"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCreateFolder(dependencies) {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const start = source.indexOf("function createFolder(");
  const end = source.indexOf("function renameFolder(", start);
  assert.ok(start >= 0, "createFolder start marker missing");
  assert.ok(end > start, "createFolder end marker missing");

  const sandbox = {
    Cc: dependencies.Cc,
    Ci: dependencies.Ci,
    ChromeUtils: dependencies.ChromeUtils,
    Components: dependencies.Components,
    MailServices: dependencies.MailServices,
    Services: dependencies.Services,
    getAccessibleFolder: dependencies.getAccessibleFolder,
    isAccountAllowed: dependencies.isAccountAllowed,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source.slice(start, end)}
this.createFolder = createFolder;`,
    sandbox
  );
  return sandbox.createFolder;
}

function makeHarness({
  canCreateSubfolders = true,
  serverType = "imap",
} = {}) {
  const timers = [];
  const listeners = new Set();
  const createCalls = [];
  const ensureCalls = [];
  const removedListeners = [];
  const account = { key: "account2", incomingServer: null };
  const server = { type: serverType, rootFolder: null };
  const parent = {
    URI: "imap://preprod@example.invalid/",
    server,
    canCreateSubfolders,
    hasSubFolders: false,
    subFolders: [],
    AddFolderListener(listener) {
      listeners.add(listener);
    },
    RemoveFolderListener(listener) {
      listeners.delete(listener);
      removedListeners.push(listener);
    },
    createSubfolder(name, msgWindow) {
      createCalls.push([name, msgWindow]);
    },
  };
  server.rootFolder = parent;
  account.incomingServer = server;

  const foldersByUri = new Map([[parent.URI, parent]]);
  const MailServices = {
    accounts: {
      accounts: [account],
      findAccountForServer(candidate) {
        return candidate === server ? account : null;
      },
    },
    imap: {
      ensureFolderExists(parentFolder, name, msgWindow, listener) {
        ensureCalls.push([parentFolder, name, msgWindow, listener]);
      },
    },
  };
  const Ci = {
    nsITimer: { TYPE_ONE_SHOT: 0 },
    nsIMsgImapMailFolder: Symbol("nsIMsgImapMailFolder"),
  };
  const Cc = {
    "@mozilla.org/timer;1": {
      createInstance() {
        const timer = {
          cancelled: false,
          callback: null,
          cancel() {
            this.cancelled = true;
          },
          initWithCallback(callback) {
            this.callback = callback;
          },
        };
        timers.push(timer);
        return timer;
      },
    },
  };
  const ChromeUtils = {
    generateQI() {
      return function QueryInterface() {
        return this;
      };
    },
  };
  const Components = {
    isSuccessCode(status) {
      return status === 0;
    },
  };
  const msgWindow = { id: "preprod-msg-window" };
  const Services = {
    wm: {
      getMostRecentWindow(windowType) {
        assert.equal(windowType, "mail:3pane");
        return { msgWindow };
      },
    },
  };
  const createFolder = loadCreateFolder({
    Cc,
    Ci,
    ChromeUtils,
    Components,
    MailServices,
    Services,
    getAccessibleFolder(uri) {
      const folder = foldersByUri.get(uri);
      return folder ? { folder } : { error: `Folder not found: ${uri}` };
    },
    isAccountAllowed(accountId) {
      return accountId === account.key;
    },
  });

  function addVerifiedChild(name, uri = `${parent.URI}${name}`) {
    const child = {
      URI: uri,
      name,
      prettyName: name,
      parent,
      server,
      canFileMessages: true,
      QueryInterface(interfaceType) {
        assert.equal(interfaceType, Ci.nsIMsgImapMailFolder);
        return { verifiedAsOnlineFolder: true };
      },
    };
    parent.hasSubFolders = true;
    parent.subFolders.push(child);
    foldersByUri.set(uri, child);
    return child;
  }

  return {
    account,
    addVerifiedChild,
    createCalls,
    createFolder,
    ensureCalls,
    listeners,
    msgWindow,
    parent,
    removedListeners,
    timers,
  };
}

describe("verified folder creation", () => {
  it("uses ensureFolderExists for IMAP so an existing unsubscribed folder can be recovered", async () => {
    const harness = makeHarness();
    const pending = harness.createFolder(harness.parent.URI, "MCP Verified");

    assert.equal(harness.ensureCalls.length, 1);
    assert.equal(harness.ensureCalls[0][0], harness.parent);
    assert.equal(harness.ensureCalls[0][1], "MCP Verified");
    assert.equal(harness.ensureCalls[0][2], harness.msgWindow);
    assert.equal(harness.createCalls.length, 0);
    assert.equal(harness.listeners.size, 1);

    const child = harness.addVerifiedChild("MCP Verified");
    const [listener] = harness.listeners;
    listener.onFolderAdded(harness.parent, child);

    const result = await pending;
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      success: true,
      message: 'Folder "MCP Verified" created or subscribed and verified',
      path: child.URI,
      parentPath: harness.parent.URI,
      accountId: "account2",
      verified: true,
    });
    assert.equal(harness.listeners.size, 0);
    assert.equal(harness.removedListeners.length, 1);
    assert.equal(harness.timers[0].cancelled, true);
  });

  it("does not fail on FolderCreateFailed when ensureFolderExists subsequently surfaces the folder", async () => {
    const harness = makeHarness();
    const pending = harness.createFolder(harness.parent.URI, "Rejected");
    const [folderListener] = harness.listeners;

    folderListener.onFolderEvent(harness.parent, "FolderCreateFailed");
    const child = harness.addVerifiedChild("Rejected");
    folderListener.onFolderAdded(harness.parent, child);

    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.path, child.URI);
    assert.equal(harness.listeners.size, 0);
  });

  it("returns the IMAP URL failure only when no verified folder was surfaced", async () => {
    const harness = makeHarness();
    const pending = harness.createFolder(harness.parent.URI, "Rejected");
    const urlListener = harness.ensureCalls[0][3];

    urlListener.OnStopRunningUrl(null, 0x80004005);

    const result = await pending;
    assert.match(result.error, /IMAP server rejected/i);
    assert.match(result.error, /account root or a regular user-created folder/i);
    assert.equal(result.success, undefined);
    assert.equal(result.path, undefined);
    assert.equal(harness.listeners.size, 0);
  });

  it("times out as unconfirmed instead of returning success with path null", async () => {
    const harness = makeHarness();
    const pending = harness.createFolder(harness.parent.URI, "No Callback");

    harness.timers[0].callback.notify();

    const result = await pending;
    assert.match(result.error, /not confirmed/i);
    assert.equal(result.status, "unconfirmed");
    assert.equal(result.success, undefined);
    assert.equal(result.path, undefined);
  });

  it("rejects a parent that cannot create subfolders before starting IMAP work", async () => {
    const harness = makeHarness({ canCreateSubfolders: false });

    const result = await harness.createFolder(harness.parent.URI, "Impossible");

    assert.match(result.error, /cannot create subfolders/i);
    assert.equal(harness.createCalls.length, 0);
    assert.equal(harness.ensureCalls.length, 0);
    assert.equal(harness.listeners.size, 0);
  });

  it("supports top-level creation by allowed account id", async () => {
    const harness = makeHarness();
    const pending = harness.createFolder(undefined, "Top Level", "account2");
    const child = harness.addVerifiedChild("Top Level");
    const [listener] = harness.listeners;
    listener.onFolderAdded(harness.parent, child);

    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.path, child.URI);
    assert.equal(result.accountId, "account2");
  });

  it("keeps createSubfolder for non-IMAP folder providers", async () => {
    const harness = makeHarness({ serverType: "none" });
    const pending = harness.createFolder(harness.parent.URI, "Local");

    assert.equal(harness.createCalls.length, 1);
    assert.equal(harness.ensureCalls.length, 0);

    const child = harness.addVerifiedChild("Local", "mailbox://local/Local");
    const [listener] = harness.listeners;
    listener.onFolderAdded(harness.parent, child);

    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.path, child.URI);
  });
});
