"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadComposeFormatHelper() {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const start = source.indexOf("function resolveComposeFormat(");
  const end = source.indexOf("function setComposeIdentity(", start);
  assert.ok(start >= 0, "resolveComposeFormat helper missing");
  assert.ok(end > start, "setComposeIdentity marker missing");

  const compTypes = {
    New: 0,
    Reply: 1,
    ReplyAll: 2,
    ForwardInline: 3,
    ForwardAsAttachment: 4,
  };
  const compFormats = {
    Default: 10,
    HTML: 11,
    PlainText: 12,
    OppositeOfDefault: 13,
  };
  const sandbox = {
    Ci: {
      nsIMsgCompType: compTypes,
      nsIMsgCompFormat: compFormats,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source.slice(start, end)}\nthis.resolveComposeFormat = resolveComposeFormat;`,
    sandbox
  );
  return { resolveComposeFormat: sandbox.resolveComposeFormat, compTypes, compFormats };
}

const { resolveComposeFormat, compTypes, compFormats } = loadComposeFormatHelper();

function assertFormat(actual, expected) {
  assert.equal(actual.useHtml, expected.useHtml);
  assert.equal(actual.format, expected.format);
}

describe("compose format resolution", () => {
  it("keeps an HTML identity in HTML mode for a plain-text input body", () => {
    assertFormat(
      resolveComposeFormat({ composeHtml: true }, false, compTypes.New),
      { useHtml: true, format: compFormats.Default }
    );
  });

  it("keeps a plain-text identity in plain mode for a plain-text input body", () => {
    assertFormat(
      resolveComposeFormat({ composeHtml: false }, false, compTypes.New),
      { useHtml: false, format: compFormats.Default }
    );
  });

  it("forces HTML only when the input body contains HTML markup", () => {
    assertFormat(
      resolveComposeFormat({ composeHtml: false }, true, compTypes.New),
      { useHtml: true, format: compFormats.HTML }
    );
    assertFormat(
      resolveComposeFormat({ composeHtml: false }, true, compTypes.ForwardInline),
      { useHtml: true, format: compFormats.OppositeOfDefault }
    );
  });
});
