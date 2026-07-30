"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const apiPath = path.join(repoRoot, "extension", "mcp_server", "api.js");
const apiSource = fs.readFileSync(apiPath, "utf8");

function getMarkedSnippet(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  assert.ok(end > start, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadPolicy() {
  const snippet = getMarkedSnippet(
    apiSource,
    "// BEGIN SAFE FILTER POLICY",
    "// END SAFE FILTER POLICY"
  );
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}
this.safeFilterPolicy = {
  encodeSafeFilterUtf8,
  validateSafeFilterDefinition,
  makeSafeFilterRevisionPayload,
  findSafeFilterMutationTarget,
};`,
    sandbox
  );
  return sandbox.safeFilterPolicy;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("safe persistent filter policy", () => {
  it("encodes revision payloads as stable UTF-8 without browser globals", () => {
    const policy = loadPolicy();
    for (const value of ["ASCII", "ważne", "mail 📬", "\ud800"]) {
      assert.deepEqual(
        Array.from(policy.encodeSafeFilterUtf8(value)),
        Array.from(Buffer.from(value, "utf8"))
      );
    }
  });

  it("accepts and normalizes a bounded non-destructive filter", () => {
    const policy = loadPolicy();
    const result = policy.validateSafeFilterDefinition(
      "  MCP: ważne faktury  ",
      [
        {
          attrib: "subject",
          op: "contains",
          value: "faktura",
        },
        {
          attrib: "otherHeader",
          op: "is",
          value: "trusted",
          header: "X-Workflow",
          booleanAnd: true,
        },
      ],
      [
        { type: "moveToFolder", value: "imap://account/Invoices" },
        { type: "markRead" },
        { type: "addTag", value: "$label1" },
      ]
    );

    assert.deepEqual(plain(result), {
      definition: {
        name: "MCP: ważne faktury",
        conditions: [
          {
            attrib: "subject",
            op: "contains",
            value: "faktura",
            booleanAnd: true,
          },
          {
            attrib: "otherHeader",
            op: "is",
            value: "trusted",
            booleanAnd: true,
            header: "X-Workflow",
          },
        ],
        actions: [
          { type: "moveToFolder", value: "imap://account/Invoices" },
          { type: "markRead" },
          { type: "addTag", value: "$label1" },
        ],
      },
    });
  });

  it("rejects destructive, sending, server, and custom actions", () => {
    const policy = loadPolicy();
    for (const type of [
      "delete",
      "forward",
      "reply",
      "deleteFromServer",
      "deleteBody",
      "custom",
      "junkScore",
      "stopExecution",
    ]) {
      const result = policy.validateSafeFilterDefinition(
        "unsafe",
        [{ attrib: "from", op: "contains", value: "example.com" }],
        [{ type }]
      );
      assert.match(result.error, /action|not allowed/i, type);
    }
  });

  it("rejects unbounded or malformed names, conditions, headers, and tags", () => {
    const policy = loadPolicy();
    const validAction = [{ type: "markRead" }];
    assert.match(
      policy.validateSafeFilterDefinition(
        "bad\r\nname",
        [{ attrib: "subject", op: "contains", value: "x" }],
        validAction
      ).error,
      /name|control/i
    );
    assert.match(
      policy.validateSafeFilterDefinition(
        "bad attribute",
        [{ attrib: "date", op: "contains", value: "x" }],
        validAction
      ).error,
      /attribute|not allowed/i
    );
    assert.match(
      policy.validateSafeFilterDefinition(
        "bad operator",
        [{ attrib: "subject", op: "matches", value: ".*" }],
        validAction
      ).error,
      /operator|not allowed/i
    );
    assert.match(
      policy.validateSafeFilterDefinition(
        "bad header",
        [{
          attrib: "otherHeader",
          op: "contains",
          value: "x",
          header: "X-Test\r\nBcc",
        }],
        validAction
      ).error,
      /header/i
    );
    assert.match(
      policy.validateSafeFilterDefinition(
        "bad tag",
        [{ attrib: "subject", op: "contains", value: "x" }],
        [{ type: "addTag", value: "two words" }]
      ).error,
      /tag/i
    );
  });

  it("builds a stable revision payload that excludes mutable list position", () => {
    const policy = loadPolicy();
    const filter = {
      index: 7,
      filterId: "f".repeat(64),
      managedByMcp: true,
      complete: true,
      mutable: true,
      unparseable: false,
      name: "MCP rule",
      enabled: false,
      type: 17,
      temporary: false,
      termCount: 1,
      actionCount: 1,
      terms: [{
        attrib: "from",
        op: "contains",
        value: "@example.com",
        booleanAnd: true,
        beginsGrouping: true,
        endsGrouping: true,
      }],
      actions: [{ type: "markRead" }],
    };
    const first = policy.makeSafeFilterRevisionPayload(filter);
    const second = policy.makeSafeFilterRevisionPayload({ ...filter, index: 99 });
    assert.equal(first, second);
    assert.doesNotMatch(first, /"index"/);
  });

  it("requires an MCP-managed id plus current revision and fails closed", () => {
    const policy = loadPolicy();
    const filters = [
      {
        index: 0,
        name: "Rule",
        filterId: "1".repeat(64),
        revision: "a".repeat(64),
        managedByMcp: true,
        complete: true,
        mutable: true,
      },
      {
        index: 1,
        name: "Other",
        filterId: "2".repeat(64),
        revision: "b".repeat(64),
        managedByMcp: true,
        complete: true,
        mutable: true,
      },
    ];
    assert.deepEqual(
      plain(policy.findSafeFilterMutationTarget(
        filters,
        "1".repeat(64),
        "a".repeat(64)
      )),
      { target: filters[0] }
    );
    assert.match(
      policy.findSafeFilterMutationTarget(
        filters,
        "1".repeat(64),
        "c".repeat(64)
      ).error,
      /stale|changed/i
    );
    assert.match(
      policy.findSafeFilterMutationTarget(
        [...filters, { ...filters[0], index: 2 }],
        "1".repeat(64),
        "a".repeat(64)
      ).error,
      /ambiguous/i
    );
    for (const unsafe of [
      { managedByMcp: false },
      { complete: false },
      { mutable: false },
      { unparseable: true },
      { temporary: true },
    ]) {
      const result = policy.findSafeFilterMutationTarget(
        [{ ...filters[0], ...unsafe }],
        "1".repeat(64),
        "a".repeat(64)
      );
      assert.match(result.error, /only filters created|incomplete|unsupported/i);
    }
  });
});

describe("safe persistent filter integration contract", () => {
  it("uses Thunderbird interface constants instead of stale numeric enum copies", () => {
    assert.match(apiSource, /subject:\s*Ci\.nsMsgSearchAttrib\.Subject/);
    assert.match(apiSource, /tag:\s*Ci\.nsMsgSearchAttrib\.Keywords/);
    assert.match(apiSource, /otherHeader:\s*Ci\.nsMsgSearchAttrib\.OtherHeader/);
    assert.match(apiSource, /contains:\s*Ci\.nsMsgSearchOp\.Contains/);
    assert.match(apiSource, /copyToFolder:\s*Ci\.nsMsgFilterAction\.CopyToFolder/);
    assert.match(apiSource, /markRead:\s*Ci\.nsMsgFilterAction\.MarkRead/);
    assert.doesNotMatch(apiSource, /copyToFolder:\s*0x02/);
    assert.doesNotMatch(apiSource, /markRead:\s*0x05/);
  });

  it("hashes revisions with the scope-independent UTF-8 encoder", () => {
    assert.match(
      apiSource,
      /function safeFilterSha256[\s\S]+encodeSafeFilterUtf8\(value\)/
    );
    assert.doesNotMatch(
      apiSource,
      /function safeFilterSha256[\s\S]{0,500}(convertToByteArray|TextEncoder)/
    );
  });

  it("publishes only the reviewed filter tools", () => {
    for (const name of [
      "listFilters",
      "createFilter",
      "updateFilter",
      "disableFilter",
      "deleteFilter",
    ]) {
      assert.match(apiSource, new RegExp(`"${name}"`));
      assert.match(apiSource, new RegExp(`case "${name}":`));
    }
    assert.doesNotMatch(
      getMarkedSnippet(
        apiSource,
        "// BEGIN SAFE READ-ONLY POLICY",
        "// END SAFE READ-ONLY POLICY"
      ),
      /"applyFilters"|"reorderFilters"/
    );
  });

  it("creates rules disabled and requires a disabled rule for definition updates", () => {
    assert.match(
      apiSource,
      /function createSafeFilter[\s\S]+filter\.enabled = false/
    );
    assert.match(
      apiSource,
      /function updateSafeFilter[\s\S]+must be disabled before its definition can be changed/
    );
  });

  it("backs up and audits before every persisted mutation", () => {
    assert.match(apiSource, /function backupSafeFilterFile/);
    assert.match(apiSource, /filterList\.defaultFile/);
    assert.match(apiSource, /filter-backups/);
    assert.match(apiSource, /filter-mutation-audit\.jsonl/);
    assert.match(
      apiSource,
      /function prepareSafeFilterMutation[\s\S]+backupSafeFilterFile[\s\S]+appendSafeFilterAudit/
    );
    for (const functionName of [
      "createSafeFilter",
      "updateSafeFilter",
      "disableSafeFilter",
      "deleteSafeFilter",
    ]) {
      assert.match(
        apiSource,
        new RegExp(`function ${functionName}[\\s\\S]+prepareSafeFilterMutation`)
      );
    }
  });

  it("keeps state durable and confines move/copy destinations to safe same-account folders", () => {
    assert.match(
      apiSource,
      /function getSafePersistentDirectory[\s\S]+Services\.dirsvc\.get\("UAppData"/
    );
    assert.match(
      apiSource,
      /function validateSafeFilterTargetFolder[\s\S]+folder\.server !== server/
    );
    assert.match(
      apiSource,
      /validateSafeFilterTargetFolder[\s\S]+nsMsgFolderFlags\.Virtual[\s\S]+nsMsgFolderFlags\.Trash[\s\S]+nsMsgFolderFlags\.Junk[\s\S]+canFileMessages/
    );
    assert.match(
      apiSource,
      /function validateSafeFilterTag[\s\S]+MailServices\.tags\.getAllTags/
    );
  });

  it("requires IMAP filter destinations to be confirmed as online folders", () => {
    assert.match(
      apiSource,
      /QueryInterface\([\s\S]*Ci\.nsIMsgImapMailFolder[\s\S]*verifiedAsOnlineFolder/
    );
    assert.match(
      apiSource,
      /Filter destination is not confirmed on the IMAP server/
    );
  });

  it("does not expose index, arbitrary type bits, or enabled-on-create", () => {
    assert.match(apiSource, /name: "disableFilter"/);
    assert.doesNotMatch(apiSource, /name: "setFilterEnabled"/);
    assert.doesNotMatch(apiSource, /SAFE_FILTER_ENABLE_CONFIRMATION_PHRASE/);
    assert.match(apiSource, /confirmDelete/);
    assert.match(apiSource, /expectedRevision/);
    assert.match(apiSource, /filterId/);
    assert.doesNotMatch(
      apiSource,
      /case "createFilter":[\s\S]{0,600}args\.(enabled|type|insertAtIndex)/
    );
    assert.doesNotMatch(
      apiSource,
      /case "(updateFilter|deleteFilter)":[\s\S]{0,600}args\.filterIndex/
    );
  });
});
