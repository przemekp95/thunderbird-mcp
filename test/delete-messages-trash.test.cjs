"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Ci = {
  nsIImapIncomingServer: Symbol("nsIImapIncomingServer"),
  nsMsgFolderFlags: {
    Trash: 0x00000100,
    Drafts: 0x00000400,
  },
  nsMsgImapDeleteModels: {
    IMAPDelete: 0,
    MoveToTrash: 1,
    DeleteNoTrash: 2,
  },
};

function loadDeleteMessages(dependencies) {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const startMarker = "function isTrashOrDescendant(folder) {";
  const endMarker = "function updateMessage(";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, "deleteMessages start marker missing");
  assert.ok(end > start, "deleteMessages end marker missing");

  const snippet = source.slice(start, end);
  const sandbox = {
    openFolder: dependencies.openFolder,
    findTrashFolder: dependencies.findTrashFolder,
    MailServices: dependencies.MailServices,
    Ci,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}
this.deleteMessages = deleteMessages;`,
    sandbox
  );
  return sandbox.deleteMessages;
}

function makeHarness({
  isDrafts = false,
  isTrash = false,
  isTrashDescendant = false,
  trashFolder = null,
  serverType = "imap",
  deleteModel = Ci.nsMsgImapDeleteModels.MoveToTrash,
} = {}) {
  const header = { messageId: "message-1@example.com" };
  const deleteCalls = [];
  const copyCalls = [];
  const trashLookups = [];
  const specialFolderChecks = [];
  const queryInterfaceCalls = [];
  const trashAncestor = isTrashDescendant ? {
    getFlag(flag) {
      return flag === Ci.nsMsgFolderFlags.Trash;
    },
    isSpecialFolder(flag, checkAncestors) {
      return this.getFlag(flag) || Boolean(checkAncestors && this.parent?.isSpecialFolder(flag, true));
    },
    parent: null,
  } : null;
  const folder = {
    getFlag(flag) {
      return (flag === Ci.nsMsgFolderFlags.Drafts && isDrafts) ||
        (flag === Ci.nsMsgFolderFlags.Trash && isTrash);
    },
    isSpecialFolder(flag, checkAncestors) {
      specialFolderChecks.push([flag, checkAncestors]);
      return this.getFlag(flag) || Boolean(checkAncestors && this.parent?.isSpecialFolder(flag, true));
    },
    parent: trashAncestor,
    server: {
      type: serverType,
      deleteModel,
      QueryInterface(interfaceType) {
        queryInterfaceCalls.push(interfaceType);
        if (interfaceType !== Ci.nsIImapIncomingServer) {
          throw new Error("Unexpected interface");
        }
        return this;
      },
    },
    deleteMessages(...args) {
      deleteCalls.push(args);
    },
  };
  const db = {
    getMsgHdrForMessageID(messageId) {
      return messageId === header.messageId ? header : null;
    },
    enumerateMessages() {
      return [header];
    },
  };
  const deleteMessages = loadDeleteMessages({
    openFolder: () => ({ folder, db }),
    findTrashFolder(sourceFolder) {
      trashLookups.push(sourceFolder);
      return trashFolder;
    },
    MailServices: {
      copy: {
        copyMessages(...args) {
          copyCalls.push(args);
        },
      },
    },
  });

  return {
    copyCalls,
    deleteCalls,
    deleteMessages,
    folder,
    header,
    queryInterfaceCalls,
    specialFolderChecks,
    trashLookups,
  };
}

function toPlainObject(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("deleteMessages trash lookup", () => {
  it("requires explicit confirmation before looking up or moving messages", () => {
    const harness = makeHarness();

    const result = harness.deleteMessages(
      [harness.header.messageId],
      "imap://account/INBOX"
    );

    assert.deepStrictEqual(toPlainObject(result), {
      error: "confirmTrash must be true to move messages to Trash",
    });
    assert.equal(harness.trashLookups.length, 0);
    assert.equal(harness.deleteCalls.length, 0);
    assert.equal(harness.copyCalls.length, 0);
  });

  it("fails closed when the source folder has no reachable Trash", () => {
    const harness = makeHarness();

    const result = harness.deleteMessages(
      [harness.header.messageId],
      "imap://account/INBOX",
      true
    );

    assert.deepStrictEqual(toPlainObject(result), {
      error: "Trash folder not found; no messages were deleted",
    });
    assert.equal(harness.trashLookups.length, 1);
    assert.equal(harness.trashLookups[0], harness.folder);
    assert.equal(harness.deleteCalls.length, 0);
    assert.equal(harness.copyCalls.length, 0);
  });

  it("moves matching messages to Trash without permanent deletion", () => {
    const trashFolder = { URI: "imap://account/Trash" };
    const harness = makeHarness({ trashFolder });

    const result = harness.deleteMessages(
      [harness.header.messageId],
      "imap://account/INBOX",
      true
    );

    assert.deepStrictEqual(toPlainObject(result), {
      success: true,
      movedToTrash: 1,
      permanentDeletion: false,
    });
    assert.equal(harness.trashLookups.length, 1);
    assert.equal(harness.deleteCalls.length, 0);
    assert.equal(harness.copyCalls.length, 1);
    assert.equal(harness.copyCalls[0][0], harness.folder);
    assert.equal(harness.copyCalls[0][1][0], harness.header);
    assert.equal(harness.copyCalls[0][2], trashFolder);
    assert.deepStrictEqual(harness.copyCalls[0].slice(3), [true, null, null, false]);
  });

  for (const [location, options, folderPath] of [
    ["Trash", { isTrash: true }, "imap://account/Trash"],
    ["a Trash descendant", { isTrashDescendant: true }, "imap://account/Trash/Nested"],
  ]) {
    it(`refuses permanent deletion from ${location}`, () => {
      const harness = makeHarness(options);

      const result = harness.deleteMessages(
        [harness.header.messageId],
        folderPath,
        true
      );

      assert.deepStrictEqual(toPlainObject(result), {
        error: "Refusing to permanently delete messages from Trash",
      });
      assert.deepStrictEqual(
        harness.specialFolderChecks,
        [[Ci.nsMsgFolderFlags.Trash, true]]
      );
      assert.equal(harness.trashLookups.length, 0);
      assert.equal(harness.deleteCalls.length, 0);
      assert.equal(harness.copyCalls.length, 0);
    });
  }

  it("reports requested messages that were not found while moving the rest", () => {
    const trashFolder = { URI: "imap://account/Trash" };
    const harness = makeHarness({ trashFolder });

    const result = harness.deleteMessages(
      [harness.header.messageId, "missing@example.invalid"],
      "imap://account/INBOX",
      true
    );

    assert.deepStrictEqual(toPlainObject(result), {
      success: true,
      movedToTrash: 1,
      permanentDeletion: false,
      notFound: ["missing@example.invalid"],
    });
    assert.equal(harness.copyCalls.length, 1);
  });
});
