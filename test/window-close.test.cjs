"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function controls(windows) {
  const source = fs.readFileSync(path.join(__dirname, "../extension/mcp_server/api.js"), "utf8");
  const start = source.indexOf("// BEGIN THUNDERBIRD WINDOW CONTROLS");
  const end = source.indexOf("// END THUNDERBIRD WINDOW CONTROLS", start);
  const sandbox = { Services: { wm: { getEnumerator: () => windows.values() }, prefs: { getChildList: () => [] } } };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}\nthis.result = { listThunderbirdWindows, closeThunderbirdWindow: typeof closeThunderbirdWindow === 'function' ? closeThunderbirdWindow : undefined };`, sandbox);
  return sandbox.result;
}

function windowFixture(type = "mail:messageWindow", uri = "chrome://messenger/content/messageWindow.xhtml") {
  return {
    closed: false,
    document: { title: "Test message preview", documentURI: uri, documentElement: { getAttribute: () => type } },
    close() { this.closed = true; },
  };
}

describe("closing Thunderbird message previews", () => {
  it("lists standalone previews and closes only the explicitly selected window", () => {
    const first = windowFixture();
    const second = windowFixture();
    const api = controls([first, second]);
    const rows = api.listThunderbirdWindows().windows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, "message");
    assert.equal(api.closeThunderbirdWindow(rows[0].windowId).success, true);
    assert.equal(first.closed, true);
    assert.equal(second.closed, false);
    assert.equal(api.listThunderbirdWindows().windows.length, 1);
    assert.equal(api.closeThunderbirdWindow(rows[0].windowId).success, false);
  });

  it("preserves the main mail window, compose editors and dialogs", () => {
    for (const [type, uri] of [
      ["mail:3pane", "chrome://messenger/content/messenger.xhtml"],
      ["msgcompose", "chrome://messenger/content/messengercompose/messengercompose.xhtml"],
      ["prompt:promptPassword", "chrome://global/content/commonDialog.xhtml"],
    ]) {
      const win = windowFixture(type, uri);
      const api = controls([win]);
      const id = api.listThunderbirdWindows().windows[0].windowId;
      assert.equal(typeof api.closeThunderbirdWindow, "function");
      assert.equal(api.closeThunderbirdWindow(id).success, false);
      assert.equal(win.closed, false);
    }
  });

  it("rejects unknown IDs and windows removed after listing", () => {
    const windows = [windowFixture()];
    const api = controls(windows);
    const id = api.listThunderbirdWindows().windows[0]?.windowId;
    assert.equal(typeof api.closeThunderbirdWindow, "function");
    assert.equal(api.closeThunderbirdWindow("tb-window-999").success, false);
    windows.length = 0;
    assert.equal(api.closeThunderbirdWindow(id).success, false);
  });

  it("rejects a foreign document even when it claims the preview window type", () => {
    const win = windowFixture("mail:messageWindow", "https://example.com/messageWindow.xhtml");
    const api = controls([win]);
    assert.equal(api.listThunderbirdWindows().windows.length, 0);
    assert.equal(typeof api.closeThunderbirdWindow, "function");
    assert.equal(api.closeThunderbirdWindow("tb-window-1").success, false);
    assert.equal(win.closed, false);
  });

  it("does not report closure when Thunderbird prevents it", () => {
    const win = windowFixture();
    win.close = () => {};
    const api = controls([win]);
    const id = api.listThunderbirdWindows().windows[0]?.windowId;
    assert.equal(typeof api.closeThunderbirdWindow, "function");
    assert.equal(api.closeThunderbirdWindow(id).success, false);
    assert.equal(win.closed, false);
  });

  it("handles a failed close without exposing the thrown error", () => {
    const win = windowFixture();
    win.close = () => { throw new Error("private window data"); };
    const api = controls([win]);
    const id = api.listThunderbirdWindows().windows[0]?.windowId;
    assert.equal(typeof api.closeThunderbirdWindow, "function");
    const result = api.closeThunderbirdWindow(id);
    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result).includes("private window data"), false);
  });
});
