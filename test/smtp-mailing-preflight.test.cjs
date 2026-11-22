"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

it("reports the selected account's explicit SMTP route and granular send grant only", () => {
  const source = fs.readFileSync(require.resolve("../extension/mcp_server/api.js"), "utf8");
  const start = source.indexOf("// Mail Merge uses the native compose transport.");
  const end = source.indexOf("// BEGIN COMPOSE WINDOW CONTROLS", start);
  const smtpInterface = Symbol("nsISmtpServer");
  const sandbox = vm.createContext({ Ci: { nsISmtpServer: smtpInterface } });
  const inspect = vm.runInContext(source.slice(start, end) +
    "\ntypeof inspectMailingAccount === 'function' ? inspectMailingAccount : undefined;", sandbox);
  assert.equal(typeof inspect, "function");
  const primary = { key: "id1", smtpServerKey: "smtp1" };
  const unassigned = { key: "id2", smtpServerKey: "" };
  const account = { key: "account1", incomingServer: { type: "imap" }, identities: [primary, unassigned] };
  const validSmtp = { key: "smtp1", type: "smtp", socketType: 2,
    QueryInterface(iface) {
      assert.equal(iface, smtpInterface);
      return { hostname: "relay.example.invalid", port: 587, password: "never-include" };
    },
  };
  const services = { accounts: { accounts: [account] }, outgoingServer: {
    servers: [validSmtp], get defaultServer() { throw Error("must not use fallback"); },
  } };
  const config = { enabled: true, allowedAccountIds: ["account1"] };
  assert.equal(inspect("account1", services, () => false, config).success, false);
  let result = inspect("account1", services, () => true, config);
  assert.equal(result.directSendAllowed, true);
  assert.equal(result.directSendTransports[0].hostname, "relay.example.invalid");
  assert.equal(result.directSendTransports[0].port, 587);
  assert.equal(result.directSendTransports[0].socketType, 2);
  assert.equal(result.directSendTransports[1].code, "smtp-not-configured");
  assert.doesNotMatch(JSON.stringify(result), /never-include/);
  services.outgoingServer.servers = [];
  result = inspect("account1", services, () => true, { enabled: true, allowedAccountIds: [] });
  assert.equal(result.directSendAllowed, false);
  assert.equal(result.directSendTransports[0].code, "smtp-unavailable");
});
