"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
function fixture() {
  const source = fs.readFileSync(require.resolve("../extension/mcp_server/api.js"), "utf8");
  const listeners = new Set();
  let attempts = 0;
  const events = new Map();
  const win = {
    document: { title: "Reply", documentURI: "chrome://messenger/content/messengercompose/messengercompose.xhtml", documentElement: { getAttribute: () => "msgcompose" } },
    gCurrentIdentity: { key: "id1", email: "me@example.com" },
    gMsgCompose: { RegisterStateListener: l => listeners.add(l), UnregisterStateListener: l => listeners.delete(l) },
    GetComposeDetails: () => ({ from: "me@example.com", to: "you@example.com", subject: "Reply", references: "<previous@example.com>", attachments: [] }),
    GetCurrentEditor: () => ({ outputToString: () => "Reviewed reply and quoted history" }),
    IsHTMLEditor: () => true,
    DoSpellCheckBeforeSend: () => true,
    addEventListener(name, fn) { events.set(name, fn); },
    removeEventListener(name) { events.delete(name); },
    GenericSendMessage(mode) { assert.equal(mode, 0); assert.equal(this.DoSpellCheckBeforeSend(), false); if (this.beforeSend) this.beforeSend();
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      events.get("compose-send-message")?.(event); if (event.defaultPrevented) return Promise.resolve(); attempts++; return new Promise(resolve => { this.finish = status => { for (const l of [...listeners]) l.ComposeProcessDone(status); resolve(); }; }); },
  };
  const context = { Services: { wm: { getEnumerator: () => [win].values() }, prefs: { getChildList: () => [] } }, Ci: { nsIDocumentEncoder: { OutputRaw: 0 }, nsIMsgCompDeliverMode: { Now: 0 } }, Components: { isSuccessCode: x => x === 0 }, ChromeUtils: { generateQI: () => () => {} }, safeSecurityNotice: () => ({}), sanitizeUntrustedText: (s, max) => String(s || "").slice(0, max), SAFE_MESSAGE_BODY_MAX_CHARS: 12000, SAFE_HEADER_MAX_CHARS: 1000 };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("// BEGIN THUNDERBIRD WINDOW CONTROLS"), (source.includes("// END COMPOSE WINDOW CONTROLS") ? source.indexOf("// END COMPOSE WINDOW CONTROLS") : source.indexOf("// END THUNDERBIRD WINDOW CONTROLS"))) + "\nthis.api = {listThunderbirdWindows, getComposeWindow: typeof getComposeWindow === 'function' ? getComposeWindow : undefined, sendComposeWindow: typeof sendComposeWindow === 'function' ? sendComposeWindow : undefined, getComposeSendStatus: typeof getComposeSendStatus === 'function' ? getComposeSendStatus : undefined};", context);
  const api = context.api;
  const access = { canAccess: () => true, hash: s => createHash("sha256").update(s).digest("hex"), authorizeSend: () => ({ auditId: "test-audit" }), auditSendResult: () => {} };
  const id = api.listThunderbirdWindows().windows[0].windowId;
  assert.equal(typeof api.getComposeWindow, "function", "reviewed-compose implementation must be present");
  const revision = api.getComposeWindow(id, access).compose.revision;
  return { api, access, id, revision, win, attempts: () => attempts };
}
it("sends only the reviewed window, preserves threading, prevents duplicate submission and reports native completion", async () => {
  const f = fixture(); assert.equal(typeof f.api.sendComposeWindow, "function");
  const originalSpellCheck = f.win.DoSpellCheckBeforeSend;
  const first = f.api.sendComposeWindow(f.id, f.revision, true, f.access);
  assert.equal(first.state, "pending"); assert.equal(f.attempts(), 1);
  assert.equal(f.api.sendComposeWindow(f.id, f.revision, true, f.access).success, false);
  assert.equal(f.api.getComposeSendStatus(f.id, f.access).state, "pending");
  assert.equal(f.win.GetComposeDetails().references, "<previous@example.com>");
  f.win.finish(0); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.getComposeSendStatus(f.id, f.access).state, "sent");
  assert.equal(f.win.DoSpellCheckBeforeSend, originalSpellCheck);
  assert.equal(f.api.sendComposeWindow(f.id, f.revision, true, f.access).success, false);
});
it("refuses missing confirmation, changed content, restricted accounts, policy failure and existing prompts", () => {
  for (const condition of ["confirmation", "revision", "account", "policy", "busy"]) {
    const f = fixture(); assert.equal(typeof f.api.sendComposeWindow, "function");
    if (condition === "account") f.access.canAccess = () => false;
    if (condition === "policy") f.access.authorizeSend = () => ({ error: "disabled" });
    if (condition === "busy") f.win.gSendOperationInProgress = true;
    const result = f.api.sendComposeWindow(f.id, condition === "revision" ? "stale" : f.revision, condition !== "confirmation", f.access);
    assert.equal(result.success, false); assert.equal(f.attempts(), 0);
  }
});
it("native failure is distinct from success and restores spelling policy without leaking errors", async () => {
  const f = fixture(); assert.equal(typeof f.api.sendComposeWindow, "function");
  f.api.sendComposeWindow(f.id, f.revision, true, f.access); f.win.finish(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.getComposeSendStatus(f.id, f.access).state, "failed");
  assert.equal(f.win.DoSpellCheckBeforeSend(), true);
});

it("blocks a content change made by an asynchronous before-send hook", async () => {
  const f = fixture(); f.win.beforeSend = () => { f.win.GetCurrentEditor = () => ({ outputToString: () => "Changed after authorization" }); };
  f.api.sendComposeWindow(f.id, f.revision, true, f.access);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.attempts(), 0); assert.equal(f.api.getComposeSendStatus(f.id, f.access).state, "failed");
});

// Retrospective regression: reuse an authentic token, not a fabricated stale value.
it("rejects an authentic revision after body, recipient, sender or attachment metadata changes before authorization", () => {
  for (const changed of ["body", "recipient", "identity", "attachment"]) {
    const f = fixture();
    let authorizations = 0;
    f.access.authorizeSend = () => { authorizations++; return { auditId: "blocked-test" }; };
    if (changed === "body") f.win.GetCurrentEditor = () => ({ outputToString: () => "Edited content" });
    if (changed === "identity") f.win.gCurrentIdentity = { key: "id2", email: "other@example.com" };
    if (changed === "recipient" || changed === "attachment") {
      const original = f.win.GetComposeDetails;
      f.win.GetComposeDetails = () => ({ ...original(), ...(changed === "recipient" ?
        { to: "other@example.com" } : { attachments: [{ name: "new.txt", size: 12, url: "file:///fixture.txt", contentType: "text/plain" }] }) });
    }
    const result = f.api.sendComposeWindow(f.id, f.revision, true, f.access);
    assert.equal(result.success, false);
    assert.match(result.error, /revision changed/i);
    assert.equal(authorizations, 0);
    assert.equal(f.attempts(), 0);
  }
});
