"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");

function loadWindowControls(windows) {
  const start = apiSource.indexOf("// BEGIN THUNDERBIRD WINDOW CONTROLS");
  const end = apiSource.indexOf("// END THUNDERBIRD WINDOW CONTROLS", start);
  assert.ok(start >= 0 && end > start, "window controls must be implemented");
  const sandbox = {
    Services: {
      wm: { getEnumerator: () => windows.values() },
      prefs: {
        getChildList: () => ["mail.smtpserver.smtp1.hostname"],
        getStringPref: () => "smtp.example.com",
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${apiSource.slice(start, end)}\nthis.controls = { listThunderbirdWindows, respondToSmtpPrompt };`, sandbox);
  return sandbox.controls;
}

function prompt({ title = "Password Required for Outgoing (SMTP) Server smtp.example.com", type = "prompt:promptPassword", url = "chrome://messenger/content/messenger/commonDialog.xhtml" } = {}) {
  const actions = [];
  const password = { type: "password", value: "" };
  const button = { disabled: false, click: () => actions.push("accept") };
  const checkbox = { checked: false, click() { this.checked = true; actions.push("remember"); } };
  const dialog = { getButton: () => button };
  const elements = { password1Textbox: password, commonDialog: dialog, checkbox, checkboxContainer: { hidden: false }, infoBody: { textContent: "Enter your password" } };
  const win = {
    closed: false,
    document: {
      title,
      documentURI: url,
      documentElement: { getAttribute: () => type },
      getElementById: id => elements[id],
    },
  };
  return { win, password, actions, checkbox };
}

describe("Thunderbird window controls", () => {
  it("lists a live SMTP dialog without exposing password values", () => {
    const p = prompt();
    p.password.value = "existing-secret";
    const controls = loadWindowControls([p.win]);
    const result = controls.listThunderbirdWindows();
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].kind, "smtpPasswordPrompt");
    assert.equal(JSON.stringify(result).includes("existing-secret"), false);
  });

  it("accepts only the selected live SMTP password prompt", () => {
    const p = prompt();
    const controls = loadWindowControls([p.win]);
    const id = controls.listThunderbirdWindows().windows[0].windowId;
    const result = controls.respondToSmtpPrompt(id, "new-secret");
    assert.equal(result.success, true);
    assert.equal(p.password.value, "new-secret");
    assert.deepEqual(p.actions, ["accept"]);
    assert.equal(JSON.stringify(result).includes("new-secret"), false);
    assert.equal(controls.respondToSmtpPrompt(id, "new-secret").success, false);
  });

  it("can select Thunderbird's password-manager checkbox before accepting", () => {
    const p = prompt();
    const controls = loadWindowControls([p.win]);
    const id = controls.listThunderbirdWindows().windows[0].windowId;
    const result = controls.respondToSmtpPrompt(id, "new-secret", true);
    assert.equal(result.success, true);
    assert.equal(p.checkbox.checked, true);
    assert.deepEqual(p.actions, ["remember", "accept"]);
  });

  it("rejects unrelated password prompts and stale windows", () => {
    const p = prompt({ title: "Primary Password" });
    const controls = loadWindowControls([p.win]);
    const id = controls.listThunderbirdWindows().windows[0].windowId;
    assert.equal(controls.respondToSmtpPrompt(id, "secret").success, false);
    assert.equal(p.password.value, "");
    p.win.closed = true;
    assert.equal(controls.respondToSmtpPrompt(id, "secret").success, false);
  });

  it("refuses a foreign dialog even when its title mentions the SMTP host", () => {
    const p = prompt({ url: "https://example.com/commonDialog.xhtml" });
    const controls = loadWindowControls([p.win]);
    assert.equal(controls.listThunderbirdWindows().windows.length, 0);
    assert.equal(controls.respondToSmtpPrompt("tb-window-1", "secret").success, false);
    assert.equal(p.password.value, "");
  });
});
