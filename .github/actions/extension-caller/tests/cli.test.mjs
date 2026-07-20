// Tests for caller.mjs — the CLI wrapper. Spawns real child processes and
// asserts exit codes: 0 = ok/warn/no-config, 1 = blocking failure, 2 = invalid.

import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CALLER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "caller.mjs");
const CONFIG_REL = ".cairnci/extensions.json";

let dirs = [];
function tmp(prefix = "cli-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});
before(() => {
  delete process.env.GITHUB_STEP_SUMMARY;
});

function writeConfig(workspace, cfg) {
  const file = path.join(workspace, CONFIG_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
}
function writeSh(dir, rel, exit) {
  const p = path.join(dir, rel);
  fs.writeFileSync(p, `#!/usr/bin/env bash\nexit ${exit}\n`);
  return rel;
}
function runCli(cwd, args) {
  return spawnSync(process.execPath, [CALLER, ...args], { cwd, encoding: "utf8" });
}

describe("caller.mjs exit codes", () => {
  test("exit 0 when no config file exists", () => {
    const ws = tmp();
    const r = runCli(ws, ["--phase", "pre-validate"]);
    assert.equal(r.status, 0);
  });

  test("exit 1 when a blocking extension fails", () => {
    const ws = tmp();
    writeConfig(ws, {
      extensions: [{ id: "boom", phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } }],
    });
    writeSh(ws, "e.sh", 5);
    const r = runCli(ws, ["--phase", "pre-validate"]);
    assert.equal(r.status, 1);
  });

  test("exit 0 when only a non-blocking extension fails", () => {
    const ws = tmp();
    writeConfig(ws, {
      extensions: [
        { id: "soft", phases: ["pre-validate"], blocking: false, run: { type: "local", entry: "e.sh" } },
      ],
    });
    writeSh(ws, "e.sh", 5);
    const r = runCli(ws, ["--phase", "pre-validate"]);
    assert.equal(r.status, 0);
  });

  test("exit 2 on invalid config", () => {
    const ws = tmp();
    writeConfig(ws, "{ not valid json");
    const r = runCli(ws, ["--phase", "pre-validate"]);
    assert.equal(r.status, 2);
  });

  test("exit 2 when --phase is missing", () => {
    const ws = tmp();
    const r = runCli(ws, ["--config", CONFIG_REL]);
    assert.equal(r.status, 2);
  });

  test("exit 2 when the phase name is invalid", () => {
    const ws = tmp();
    writeConfig(ws, {
      extensions: [{ id: "x", phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } }],
    });
    writeSh(ws, "e.sh", 0);
    const r = runCli(ws, ["--phase", "not-a-phase"]);
    assert.equal(r.status, 2);
  });
});
