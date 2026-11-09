"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadStructuredMimeBodyHelper() {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const startMarker = "// BEGIN STRUCTURED MIME BODY HELPERS";
  const endMarker = "// END STRUCTURED MIME BODY HELPERS";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0, "structured MIME body helper start marker missing");
  assert.ok(end > start, "structured MIME body helper end marker missing");

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${source.slice(start, end)}
this.extractBodyContent = extractBodyContent;`,
    sandbox
  );
  return sandbox.extractBodyContent;
}

const extractBodyContent = loadStructuredMimeBodyHelper();

function assertBody(result, text, isHtml) {
  assert.equal(result.text, text);
  assert.equal(result.isHtml, isHtml);
}

describe("structured MIME body extraction", () => {
  it("selects the requested multipart/alternative representation", () => {
    const message = {
      contentType: "multipart/alternative",
      parts: [
        { contentType: "text/plain; charset=utf-8", body: "Plain version" },
        { contentType: "text/html; charset=utf-8", body: "<p>HTML version</p>" },
      ],
    };

    assertBody(extractBodyContent(message, false), "Plain version", false);
    assertBody(extractBodyContent(message, true), "<p>HTML version</p>", true);
  });

  it("keeps multipart message order outside alternative containers", () => {
    const message = {
      contentType: "multipart/mixed",
      parts: [
        { contentType: "text/plain", body: "First body" },
        { contentType: "text/html", body: "<p>Later body</p>" },
      ],
    };

    assertBody(extractBodyContent(message, true), "First body", false);
  });
});
