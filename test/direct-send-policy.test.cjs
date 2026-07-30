"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const apiPath = path.join(repoRoot, "extension", "mcp_server", "api.js");
const schemaPath = path.join(repoRoot, "extension", "mcp_server", "schema.json");
const optionsHtmlPath = path.join(repoRoot, "extension", "options-safe.html");
const optionsScriptPath = path.join(repoRoot, "extension", "options-safe.js");
const apiSource = fs.readFileSync(apiPath, "utf8");
const experimentSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const optionsHtml = fs.readFileSync(optionsHtmlPath, "utf8");
const optionsScript = fs.readFileSync(optionsScriptPath, "utf8");

function getMarkedSnippet(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  assert.ok(end > start, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

function createPrefs(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getBoolPref(name, fallback) {
      return values.has(name) ? values.get(name) : fallback;
    },
    getStringPref(name, fallback) {
      return values.has(name) ? values.get(name) : fallback;
    },
    getIntPref(name, fallback) {
      return values.has(name) ? values.get(name) : fallback;
    },
    setBoolPref(name, value) {
      values.set(name, value);
    },
    setStringPref(name, value) {
      values.set(name, value);
    },
    setIntPref(name, value) {
      values.set(name, value);
    },
    clearUserPref(name) {
      values.delete(name);
    },
    values,
  };
}

function loadPolicy(initialPrefs = {}) {
  const snippet = getMarkedSnippet(
    apiSource,
    "// BEGIN DIRECT SEND POLICY",
    "// END DIRECT SEND POLICY"
  );
  const prefs = createPrefs(initialPrefs);
  const sandbox = {
    Services: { prefs },
    console: { warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}
this.directSendPolicy = {
  normalizeDirectSendAllowRule,
  parseDirectSendRecipients,
  validateDirectSendSettings,
  evaluateDirectSendRequest,
  readDirectSendConfigFromPrefs,
};`,
    sandbox
  );
  return { policy: sandbox.directSendPolicy, prefs };
}

function loadQuota(initialPrefs = {}) {
  const snippet = getMarkedSnippet(
    apiSource,
    "// BEGIN DIRECT SEND QUOTA",
    "// END DIRECT SEND QUOTA"
  );
  const prefs = createPrefs(initialPrefs);
  const sandbox = {
    Services: { prefs },
    PREF_DIRECT_SEND_QUOTA_DATE: "extensions.thunderbird-mcp-safe.directSendQuotaDate",
    PREF_DIRECT_SEND_QUOTA_COUNT: "extensions.thunderbird-mcp-safe.directSendQuotaCount",
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}
this.directSendQuota = { getDirectSendQuotaState, reserveDirectSendQuota };`,
    sandbox
  );
  return { quota: sandbox.directSendQuota, prefs };
}

describe("direct-send policy", () => {
  it("normalizes exact mailbox and domain allow-rules", () => {
    const { policy } = loadPolicy();
    assert.equal(policy.normalizeDirectSendAllowRule(" User@Example.COM "), "user@example.com");
    assert.equal(policy.normalizeDirectSendAllowRule("*@Example.COM"), "*@example.com");
    assert.equal(policy.normalizeDirectSendAllowRule("Display <user@example.com>"), null);
    assert.equal(policy.normalizeDirectSendAllowRule("*"), null);
    assert.equal(policy.normalizeDirectSendAllowRule("bad\r\nBcc: attacker@example.com"), null);
  });

  it("parses recipients fail-closed and rejects duplicates or header injection", () => {
    const { policy } = loadPolicy();
    assert.deepEqual(
      Array.from(policy.parseDirectSendRecipients(
        '"Example, User" <User@Example.com>',
        "second@example.org",
        ""
      ).recipients),
      ["user@example.com", "second@example.org"]
    );
    assert.match(
      policy.parseDirectSendRecipients("same@example.com", "Same@example.com", "").error,
      /duplicate/i
    );
    assert.match(
      policy.parseDirectSendRecipients("ok@example.com\r\nBcc: attacker@example.net", "", "").error,
      /control|header/i
    );
    assert.match(
      policy.parseDirectSendRecipients("not-an-address", "", "").error,
      /invalid/i
    );
  });

  it("validates enabled settings against accessible accounts and hard caps", () => {
    const { policy } = loadPolicy();
    assert.deepEqual(
      JSON.parse(JSON.stringify(policy.validateDirectSendSettings(
        {
          enabled: true,
          allowedAccountIds: ["account1"],
          allowedRecipients: ["person@example.com", "*@trusted.example"],
          maxRecipientsPerMessage: 3,
          dailyLimit: 10,
        },
        ["account1", "account2"]
      ))),
      {
        enabled: true,
        allowedAccountIds: ["account1"],
        allowedRecipients: ["person@example.com", "*@trusted.example"],
        maxRecipientsPerMessage: 3,
        dailyLimit: 10,
      }
    );
    assert.match(
      policy.validateDirectSendSettings(
        {
          enabled: true,
          allowedAccountIds: ["account9"],
          allowedRecipients: ["person@example.com"],
          maxRecipientsPerMessage: 1,
          dailyLimit: 1,
        },
        ["account1"]
      ).error,
      /account9/
    );
    assert.match(
      policy.validateDirectSendSettings(
        {
          enabled: true,
          allowedAccountIds: ["account1"],
          allowedRecipients: [],
          maxRecipientsPerMessage: 1,
          dailyLimit: 1,
        },
        ["account1"]
      ).error,
      /recipient/i
    );
    assert.match(
      policy.validateDirectSendSettings(
        {
          enabled: true,
          allowedAccountIds: ["account1"],
          allowedRecipients: ["person@example.com"],
          maxRecipientsPerMessage: 11,
          dailyLimit: 101,
        },
        ["account1"]
      ).error,
      /maxRecipientsPerMessage|dailyLimit/
    );
  });

  it("enforces sender, recipient, per-message, and daily limits", () => {
    const { policy } = loadPolicy();
    const config = {
      enabled: true,
      allowedAccountIds: ["account1"],
      allowedRecipients: ["person@example.com", "*@trusted.example"],
      maxRecipientsPerMessage: 2,
      dailyLimit: 5,
    };
    const ok = policy.evaluateDirectSendRequest(
      config,
      {
        accountId: "account1",
        to: "person@example.com",
        cc: "other@trusted.example",
        bcc: "",
      },
      4
    );
    assert.equal(ok.ok, true);
    assert.deepEqual(
      Array.from(ok.recipients),
      ["person@example.com", "other@trusted.example"]
    );
    assert.match(
      policy.evaluateDirectSendRequest(config, {
        accountId: "account2",
        to: "person@example.com",
      }, 0).error,
      /sender account/i
    );
    assert.match(
      policy.evaluateDirectSendRequest(config, {
        accountId: "account1",
        to: "outside@example.net",
      }, 0).error,
      /not allowed/i
    );
    assert.match(
      policy.evaluateDirectSendRequest(config, {
        accountId: "account1",
        to: "person@example.com, a@trusted.example, b@trusted.example",
      }, 0).error,
      /at most 2/i
    );
    assert.match(
      policy.evaluateDirectSendRequest(config, {
        accountId: "account1",
        to: "person@example.com",
      }, 5).error,
      /daily limit/i
    );
  });

  it("reads missing or corrupt preferences as disabled", () => {
    const { policy } = loadPolicy();
    assert.equal(policy.readDirectSendConfigFromPrefs().enabled, false);

    const corrupt = loadPolicy({
      "extensions.thunderbird-mcp-safe.directSendEnabled": true,
      "extensions.thunderbird-mcp-safe.directSendAccounts": "[not-json",
      "extensions.thunderbird-mcp-safe.directSendRecipients": '["person@example.com"]',
      "extensions.thunderbird-mcp-safe.directSendMaxRecipients": 1,
      "extensions.thunderbird-mcp-safe.directSendDailyLimit": 10,
    }).policy.readDirectSendConfigFromPrefs();
    assert.equal(corrupt.enabled, false);
    assert.match(corrupt.error, /corrupt/i);
  });

  it("reserves persistent daily quota and resets only on a new UTC date", () => {
    const quotaDate = "2026-07-28";
    const now = new Date(`${quotaDate}T12:00:00.000Z`);
    const { quota, prefs } = loadQuota({
      "extensions.thunderbird-mcp-safe.directSendQuotaDate": quotaDate,
      "extensions.thunderbird-mcp-safe.directSendQuotaCount": 9,
    });
    const reserved = quota.reserveDirectSendQuota({ dailyLimit: 10 }, now);
    assert.deepEqual(
      JSON.parse(JSON.stringify(reserved)),
      { date: quotaDate, used: 10, remaining: 0 }
    );
    assert.equal(
      prefs.values.get("extensions.thunderbird-mcp-safe.directSendQuotaCount"),
      10
    );
    assert.match(
      quota.reserveDirectSendQuota({ dailyLimit: 10 }, now).error,
      /daily limit/i
    );

    const nextDay = new Date("2026-07-29T00:00:00.000Z");
    assert.deepEqual(
      JSON.parse(JSON.stringify(quota.reserveDirectSendQuota({ dailyLimit: 10 }, nextDay))),
      { date: "2026-07-29", used: 1, remaining: 9 }
    );
  });

  it("blocks when same-day quota state is corrupt", () => {
    const quotaDate = "2026-07-28";
    const { quota } = loadQuota({
      "extensions.thunderbird-mcp-safe.directSendQuotaDate": quotaDate,
      "extensions.thunderbird-mcp-safe.directSendQuotaCount": -1,
    });
    assert.match(
      quota.getDirectSendQuotaState(new Date(`${quotaDate}T12:00:00.000Z`)).error,
      /corrupt/i
    );
  });
});

describe("direct-send integration contract", () => {
  it("exposes a dedicated direct tool without weakening reviewed sendMail", () => {
    assert.match(apiSource, /"sendMailDirect"/);
    assert.match(apiSource, /case "sendMailDirect":/);
    assert.match(apiSource, /sendMailDirect\(args\)/);
    assert.match(apiSource, /case "sendMail":[\s\S]{0,300}normalizeSafeInlineAttachments\(args\.attachments\), false\)/);
    assert.doesNotMatch(apiSource, /case "sendMail":[\s\S]{0,300}args\.skipReview/);
  });

  it("keeps direct-send administration outside MCP", () => {
    const names = experimentSchema[0].functions.map(fn => fn.name);
    assert.ok(names.includes("getDirectSendConfig"));
    assert.ok(names.includes("setDirectSendConfig"));
    assert.doesNotMatch(apiSource, /name:\s*"setDirectSendConfig"/);
    assert.match(optionsHtml, /ENABLE DIRECT SEND/);
    assert.match(optionsScript, /setDirectSendConfig/);
    assert.doesNotMatch(optionsScript, /innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it("requires fail-closed audit and quota reservation before transport", () => {
    assert.match(apiSource, /appendDirectSendAudit[\s\S]+reserveDirectSendQuota[\s\S]+composeMail/);
    assert.match(apiSource, /direct-send-audit\.jsonl/);
    assert.match(apiSource, /DIRECT_SEND_AUDIT_MAX_BYTES = 5 \* 1024 \* 1024/);
    assert.match(apiSource, /normalizeSafeInlineAttachments\(args\.attachments\)/);
  });
});
