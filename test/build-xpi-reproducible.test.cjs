"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`
  );
  return result;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("reproducible XPI build", () => {
  it("produces byte-identical archives from unchanged sources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mcp-xpi-repro-"));
    try {
      fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
      fs.copyFileSync(
        path.join(PROJECT_ROOT, "scripts", "build-xpi.cjs"),
        path.join(root, "scripts", "build-xpi.cjs")
      );
      fs.copyFileSync(
        path.join(PROJECT_ROOT, "package.json"),
        path.join(root, "package.json")
      );
      fs.cpSync(
        path.join(PROJECT_ROOT, "extension"),
        path.join(root, "extension"),
        { recursive: true }
      );

      run("git", ["init", "-q"], { cwd: root });
      run("git", ["config", "user.name", "Preprod Test"], { cwd: root });
      run("git", ["config", "user.email", "preprod@localhost"], { cwd: root });
      run("git", ["add", "."], { cwd: root });
      run("git", ["commit", "-q", "-m", "fixture"], {
        cwd: root,
        env: {
          GIT_AUTHOR_DATE: "2024-01-02T03:04:05Z",
          GIT_COMMITTER_DATE: "2024-01-02T03:04:05Z",
        },
      });

      run(process.execPath, ["scripts/build-xpi.cjs"], { cwd: root });
      const firstHash = sha256(path.join(root, "dist", "thunderbird-mcp-safe.xpi"));
      run(process.execPath, ["scripts/build-xpi.cjs"], { cwd: root });
      const secondHash = sha256(path.join(root, "dist", "thunderbird-mcp-safe.xpi"));

      assert.equal(secondHash, firstHash);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
