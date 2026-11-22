"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

it("refreshes one authorized inbox, coalesces requests and requires a completed native fetch", async () => {
  const modulePath = path.resolve(__dirname, "../extension/mcp_server/mail_refresh.sys.mjs");
  assert.ok(fs.existsSync(modulePath), "native inbox refresh module must be available");
  const { createMailAccountRefresher } = await import(modulePath);
  let login, fetch, starts = 0;
  const inbox = {
    QueryInterface: () => inbox,
    updateFolderWithListener(_window, listener) { fetch = listener; },
  };
  const server = { type: "imap", socketType: 3, rootFolder: { getFolderWithFlags: () => inbox },
    verifyLogon(listener) { starts++; login = listener; } };
  const account = { key: "account1", incomingServer: server };
  const win = { msgWindow: {} };
  const refresh = createMailAccountRefresher({
    MailServices: { accounts: { accounts: [account] } },
    Services: { wm: { getMostRecentWindow: () => win } },
    Ci: { nsMsgFolderFlags: { Inbox: 1 }, nsMsgSocketType: { SSL: 3, alwaysSTARTTLS: 2 } },
    Components: { isSuccessCode: status => status === 0 },
    ChromeUtils: { generateQI: () => () => {} },
  }, id => id === "account1");
  const args = { accountId: "account1", action: "start", confirmRefresh: true };
  const status = () => refresh({ accountId: "account1", action: "status" });
  assert.equal(refresh({ ...args, confirmRefresh: false }).success, false);
  assert.equal(refresh({ ...args, accountId: "account2" }).success, false);
  assert.equal(status().status, "notStarted");
  assert.equal(refresh(args).status, "started");
  assert.equal(refresh(args).status, "started");
  assert.equal(starts, 1);
  login.OnStopRunningUrl(null, 0);
  assert.equal(status().refreshVerified, false);
  fetch.OnStopRunningUrl(null, 0);
  assert.equal(status().refreshVerified, true);
  assert.equal(status().smtpVerified, false);
  refresh(args);
  login.OnStopRunningUrl(null, 5);
  assert.equal(status().status, "failed");
  assert.equal(status().refreshVerified, false);
});
