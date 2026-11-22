"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

function fixture() {
  const fields = { from: "Sender <sender@example.com>", to: "hr@example.com", cc: "staff@example.com", bcc: "", subject: "Current subject", draftId: "" };
  fields.attachments = Array.from({ length: 6 }, (_, i) => ({ name: `document-${i}.pdf`, size: 100, contentType: "application/pdf", url: `file:///private/${i}` }));
  let text = "Agreed text\nGraphic signature";
  let html = '<body>Agreed text<div class="moz-signature"><img src="data:image/png;base64,PRIVATE"/></div></body>';
  const listeners = new Set();
  const win = {
    closed: false, gCurrentIdentity: { key: "id1", email: "sender@example.com" },
    document: { title: "Compose", documentURI: "chrome://messenger/content/messengercompose/messengercompose.xhtml", documentElement: { getAttribute: () => "msgcompose" } },
    gMsgCompose: { bodyModified: true, RegisterStateListener: l => listeners.add(l), UnregisterStateListener: l => listeners.delete(l) },
    GetComposeDetails: () => fields,
    GetCurrentEditor: () => ({ outputToString: format => format === "text/plain" ? text : html }),
    IsHTMLEditor: () => true,
    SetComposeDetails(patch) { for (const key of ["to", "cc", "bcc", "subject"]) if (key in patch) fields[key] = patch[key]; if ("body" in patch) { html = patch.body; text = patch.body.replace(/<[^>]*>/g, ""); } if ("plainTextBody" in patch) { text = patch.plainTextBody; html = `<body>${text}</body>`; } this.gContentChanged = true; this.gMsgCompose.bodyModified = true; },
    setTimeout, clearTimeout,
    SaveAsDraft() { this.completeSave(); },
    completeSave(status = 0, folder = "mailbox://drafts") {
      if (status === 0) { fields.draftId = "mailbox://drafts#1"; this.gContentChanged = false; this.gMsgCompose.bodyModified = false; }
      for (const l of [...listeners]) { l.ComposeProcessDone(status); if (folder) l.SaveInFolderDone(folder); }
    },
    close() { this.closed = true; },
  };
  return { win, fields, listeners };
}

function load(windows, allowed = true) {
  const source = fs.readFileSync(require.resolve("../extension/mcp_server/api.js"), "utf8");
  const start = source.indexOf("// BEGIN THUNDERBIRD WINDOW CONTROLS");
  const end = source.indexOf("// END COMPOSE WINDOW CONTROLS", start);
  const sandbox = {
    Services: { wm: { getEnumerator: () => windows.values() }, prefs: { getChildList: () => [] } },
    Ci: { nsIDocumentEncoder: { OutputRaw: 0 } },
    ChromeUtils: { generateQI: () => () => {} },
    Components: { isSuccessCode: status => status === 0 },
    safeSecurityNotice: () => ({ untrusted: true }),
    sanitizeUntrustedText: (s, max) => String(s || "").slice(0, max),
    SAFE_MESSAGE_BODY_MAX_CHARS: 12000, SAFE_HEADER_MAX_CHARS: 1000,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end >= 0 ? end : source.indexOf("// END THUNDERBIRD WINDOW CONTROLS", start))}\nthis.api = { listThunderbirdWindows, getComposeWindow: typeof getComposeWindow === 'function' ? getComposeWindow : undefined, saveComposeWindow: typeof saveComposeWindow === 'function' ? saveComposeWindow : undefined };`, sandbox);
  const access = { canAccess: () => allowed, hash: s => createHash("sha256").update(s).digest("hex") };
  const api = sandbox.api;
  const id = api.listThunderbirdWindows().windows[0]?.windowId;
  return { api, access, id, read: () => api.getComposeWindow(id, access) };
}

describe("saving a reviewed compose window", () => {
  it("waits for actual draft completion before closing and never sends", async () => {
    const f = fixture(); const c = load([f.win]); f.win.SaveAsDraft = () => {};
    f.win.SendMessage = () => assert.fail("must never send");
    const pending = c.api.saveComposeWindow(c.id, c.read().compose.revision, true, c.access);
    await Promise.resolve(); assert.equal(f.win.closed, false); assert.equal(f.listeners.size, 1);
    f.win.completeSave(); const result = await pending;
    assert.equal(result.success, true); assert.equal(result.saved, true); assert.equal(result.closed, true);
    assert.equal(f.listeners.size, 0);
  });
  it("can save without closing", async () => {
    const f = fixture(); const c = load([f.win]);
    const result = await c.api.saveComposeWindow(c.id, c.read().compose.revision, false, c.access);
    assert.equal(result.success, true); assert.equal(result.saved, true); assert.equal(f.win.closed, false);
  });
  it("waits for native progress to unlock and rejects overlapping operations", async () => {
    const f = fixture(); const c = load([f.win]); const revision = c.read().compose.revision;
    f.win.SaveAsDraft = () => {
      f.win.gSaveOperationInProgress = true; f.win.completeSave();
      setTimeout(() => { f.win.gSaveOperationInProgress = false; }, 5);
    };
    const pending = c.api.saveComposeWindow(c.id, revision, true, c.access);
    assert.equal((await pending).success, true);
    const second = fixture(); const other = load([second.win]); const rev = other.read().compose.revision;
    second.win.SaveAsDraft = () => {};
    const waiting = other.api.saveComposeWindow(other.id, rev, false, other.access);
    assert.equal((await other.api.saveComposeWindow(other.id, rev, true, other.access)).success, false);
    second.win.completeSave(); await waiting;
  });
  it("keeps the editor and changes on preparation failure, save failure or timeout", async () => {
    for (const condition of ["throw", "failure", "timeout", "no-folder"]) {
      const f = fixture(); const c = load([f.win]);
      f.win.setTimeout = (callback, ms) => setTimeout(callback, ms === 25000 ? 5 : ms);
      f.win.SaveAsDraft = () => { if (condition === "throw") throw Error("private"); if (condition === "failure") f.win.completeSave(1); if (condition === "no-folder") f.win.completeSave(0, ""); };
      const result = await c.api.saveComposeWindow(c.id, c.read().compose.revision, true, c.access);
      assert.equal(result.success, false); assert.equal(f.win.closed, false); assert.equal(f.listeners.size, 0);
      assert.equal(JSON.stringify(result).includes("private"), false);
    }
  });
  it("does not close when content changes during save or Thunderbird prevents closure", async () => {
    for (const condition of ["edit", "prevent"]) {
      const f = fixture(); const c = load([f.win]);
      if (condition === "edit") f.win.SaveAsDraft = () => { f.win.SetComposeDetails({ plainTextBody: "User edit" }); f.win.completeSave(); };
      else f.win.close = () => {};
      const result = await c.api.saveComposeWindow(c.id, c.read().compose.revision, true, c.access);
      assert.equal(result.success, false); assert.equal(result.saved, true); assert.equal(f.win.closed, false);
    }
  });
});
