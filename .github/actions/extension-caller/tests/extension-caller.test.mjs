// Tests for the ExtensionCaller class. Node built-in runner only — no npm deps.
//   node --test .github/actions/extension-caller/tests/

import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PHASES, EXIT_WARN, ConfigError, ExtensionCaller } from "../lib/extension-caller.mjs";

const silent = { log() {}, warn() {}, error() {} };
const CONFIG_REL = ".cairnci/extensions.json";

// --- temp-dir bookkeeping ---------------------------------------------------
let dirs = [];
function tmp(prefix = "cc-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});
before(() => {
  // writeSummary must no-op unless a test opts in explicitly.
  delete process.env.GITHUB_STEP_SUMMARY;
});

// --- fixture helpers --------------------------------------------------------
function writeConfig(workspace, cfg) {
  const file = path.join(workspace, CONFIG_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
}

function makeCaller(workspace, extra = {}) {
  return new ExtensionCaller({
    configFile: CONFIG_REL,
    workspace,
    logger: silent,
    cloneRoot: tmp("clone-"),
    ...extra,
  });
}

function writeSh(dir, rel, { exit = 0, log } = {}) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let s = "#!/usr/bin/env bash\n";
  if (log) s += `printf '%s\\n' "$CAIRNCI_EXTENSION_ID" >> ${JSON.stringify(log)}\n`;
  s += `exit ${exit}\n`;
  fs.writeFileSync(p, s);
  return rel;
}

function writeMjs(dir, rel, { exit = 0, log } = {}) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let s = 'import fs from "node:fs";\n';
  if (log) s += `fs.appendFileSync(${JSON.stringify(log)}, process.env.CAIRNCI_EXTENSION_ID + "\\n");\n`;
  s += `process.exit(${exit});\n`;
  fs.writeFileSync(p, s);
  return rel;
}

// Entry that dumps selected env vars + cwd to `dumpPath` as JSON, then exits 0.
function dumpMjsText(dumpPath) {
  return `import fs from "node:fs";
const keys = ["CAIRNCI_PHASE","CAIRNCI_EXTENSION_ID","CAIRNCI_BLOCKING","CAIRNCI_WORKSPACE","CAIRNCI_CONTEXT","CUSTOM_ONE"];
const out = { CWD: process.cwd() };
for (const k of keys) out[k] = process.env[k] ?? null;
fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(out));
process.exit(0);
`;
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

// Build a real local git repo with `files` committed and tagged v1.0.0.
function makeGitRepo(files) {
  const repo = tmp("gitrepo-");
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "CairnCI Test"], repo);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["tag", "v1.0.0"], repo);
  const sha = git(["rev-parse", "HEAD"], repo).stdout.trim();
  return { repo, sha };
}

// ---------------------------------------------------------------------------
describe("phase & scenario handling", () => {
  test("PHASES lists exactly the six valid phase names", () => {
    assert.deepEqual(PHASES, [
      "pre-validate",
      "post-validate-success",
      "post-validate-failure",
      "pre-deploy",
      "post-deploy-success",
      "post-deploy-failure",
    ]);
  });

  test("an extension pinned to pre-validate runs only there, not in the other five", () => {
    const ws = tmp("ws-");
    writeConfig(ws, {
      extensions: [
        { id: "only-pre", phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } },
      ],
    });
    writeSh(ws, "e.sh", { exit: 0 });
    const caller = makeCaller(ws);

    const pre = caller.runPhase("pre-validate");
    assert.equal(pre.results.length, 1);
    assert.equal(pre.results[0].id, "only-pre");

    for (const phase of PHASES.filter((p) => p !== "pre-validate")) {
      const res = caller.runPhase(phase);
      assert.equal(res.results.length, 0, `expected no run in ${phase}`);
      assert.equal(res.failed, false);
    }
  });

  test("an extension pinned to multiple phases runs in each of them", () => {
    const ws = tmp("ws-");
    writeConfig(ws, {
      extensions: [
        {
          id: "multi",
          phases: ["post-deploy-success", "post-deploy-failure"],
          run: { type: "local", entry: "e.sh" },
        },
      ],
    });
    writeSh(ws, "e.sh", { exit: 0 });
    const caller = makeCaller(ws);

    for (const phase of ["post-deploy-success", "post-deploy-failure"]) {
      const res = caller.runPhase(phase);
      assert.equal(res.results.length, 1, `should run in ${phase}`);
      assert.equal(res.results[0].id, "multi");
    }
    for (const phase of PHASES.filter((p) => !p.startsWith("post-deploy"))) {
      assert.equal(caller.runPhase(phase).results.length, 0);
    }
  });
});

describe("run order", () => {
  test("extensions in a phase run in config-array order", () => {
    const ws = tmp("ws-");
    const log = path.join(ws, "order.log");
    writeConfig(ws, {
      extensions: [
        { id: "first", phases: ["pre-validate"], run: { type: "local", entry: "a.sh" } },
        { id: "second", phases: ["pre-validate"], run: { type: "local", entry: "b.sh" } },
        { id: "third", phases: ["pre-validate"], run: { type: "local", entry: "c.sh" } },
      ],
    });
    writeSh(ws, "a.sh", { exit: 0, log });
    writeSh(ws, "b.sh", { exit: 0, log });
    writeSh(ws, "c.sh", { exit: 0, log });

    makeCaller(ws).runPhase("pre-validate");
    const seen = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(seen, ["first", "second", "third"]);
  });
});

describe("blocking semantics", () => {
  test("a blocking extension exiting nonzero fails the phase", () => {
    const ws = tmp("ws-");
    writeConfig(ws, {
      extensions: [
        { id: "boom", phases: ["pre-validate"], blocking: true, run: { type: "local", entry: "e.sh" } },
      ],
    });
    writeSh(ws, "e.sh", { exit: 3 });
    const res = makeCaller(ws).runPhase("pre-validate");
    assert.equal(res.failed, true);
    assert.equal(res.results[0].status, "error");
    assert.equal(res.results[0].exitCode, 3);
  });

  test("a non-blocking extension exiting nonzero does NOT fail the phase but its status is error", () => {
    const ws = tmp("ws-");
    writeConfig(ws, {
      extensions: [
        { id: "soft", phases: ["pre-validate"], blocking: false, run: { type: "local", entry: "e.sh" } },
      ],
    });
    writeSh(ws, "e.sh", { exit: 4 });
    const res = makeCaller(ws).runPhase("pre-validate");
    assert.equal(res.failed, false);
    assert.equal(res.results[0].status, "error");
    assert.equal(res.results[0].blocking, false);
  });

  test("blocking defaults to true when omitted", () => {
    const ws = tmp("ws-");
    writeConfig(ws, {
      extensions: [
        { id: "def", phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } },
      ],
    });
    writeSh(ws, "e.sh", { exit: 1 });
    const res = makeCaller(ws).runPhase("pre-validate");
    assert.equal(res.results[0].blocking, true);
    assert.equal(res.failed, true);
  });
});

describe("status classification", () => {
  test("exit 10 (EXIT_WARN) yields status warn and never fails the phase, even when blocking", () => {
    assert.equal(EXIT_WARN, 10);
    const ws = tmp("ws-");
    writeConfig(ws, {
      extensions: [
        { id: "warns", phases: ["pre-validate"], blocking: true, run: { type: "local", entry: "e.sh" } },
      ],
    });
    writeSh(ws, "e.sh", { exit: EXIT_WARN });
    const res = makeCaller(ws).runPhase("pre-validate");
    assert.equal(res.results[0].status, "warn");
    assert.equal(res.results[0].exitCode, 10);
    assert.equal(res.failed, false);
  });

  test("exit 0 yields status ok with exitCode 0", () => {
    const ws = tmp("ws-");
    writeConfig(ws, {
      extensions: [
        { id: "fine", phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } },
      ],
    });
    writeSh(ws, "e.sh", { exit: 0 });
    const res = makeCaller(ws).runPhase("pre-validate");
    assert.equal(res.results[0].status, "ok");
    assert.equal(res.results[0].exitCode, 0);
  });
});

describe("local extensions", () => {
  test("a local .sh entry and a local .mjs entry both execute", () => {
    const ws = tmp("ws-");
    const log = path.join(ws, "run.log");
    writeConfig(ws, {
      extensions: [
        { id: "sh-ext", phases: ["pre-validate"], run: { type: "local", entry: "a.sh" } },
        { id: "mjs-ext", phases: ["pre-validate"], run: { type: "local", entry: "b.mjs" } },
      ],
    });
    writeSh(ws, "a.sh", { exit: 0, log });
    writeMjs(ws, "b.mjs", { exit: 0, log });
    const res = makeCaller(ws).runPhase("pre-validate");
    assert.equal(res.results.every((r) => r.status === "ok"), true);
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["sh-ext", "mjs-ext"]);
  });

  test("a missing local entry is an error mentioning the entry and fails when blocking", () => {
    const ws = tmp("ws-");
    writeConfig(ws, {
      extensions: [
        { id: "gone", phases: ["pre-validate"], run: { type: "local", entry: "does-not-exist.sh" } },
      ],
    });
    const res = makeCaller(ws).runPhase("pre-validate");
    assert.equal(res.results[0].status, "error");
    assert.match(res.results[0].detail, /does-not-exist\.sh/);
    assert.equal(res.failed, true);
  });
});

describe("external (git) extensions", () => {
  test("an entry from a git repo pinned to a tag runs; env & cwd are correct", () => {
    const ws = tmp("ws-");
    const dump = path.join(ws, "dump.json");
    const { repo } = makeGitRepo({ "run.mjs": dumpMjsText(dump) });
    writeConfig(ws, {
      extensions: [
        {
          id: "git-ext",
          phases: ["pre-deploy"],
          env: { CUSTOM_ONE: "hello" },
          run: { type: "git", repo, ref: "v1.0.0", entry: "run.mjs" },
        },
      ],
    });
    const caller = makeCaller(ws);
    const res = caller.runPhase("pre-deploy", { deployId: "abc" });
    assert.equal(res.results[0].status, "ok");

    const out = JSON.parse(fs.readFileSync(dump, "utf8"));
    assert.equal(out.CAIRNCI_WORKSPACE, path.resolve(ws));
    assert.equal(out.CUSTOM_ONE, "hello");
    // cwd of the git extension is the checkout dir (resolve symlinks for macOS /private).
    const checkout = [...caller.cloneCache.values()][0];
    assert.equal(fs.realpathSync(out.CWD), fs.realpathSync(checkout));
  });

  test("an entry from a git repo pinned to a commit SHA runs (full-clone fallback)", () => {
    const ws = tmp("ws-");
    const dump = path.join(ws, "dump.json");
    const { repo, sha } = makeGitRepo({ "run.mjs": dumpMjsText(dump) });
    writeConfig(ws, {
      extensions: [
        { id: "git-sha", phases: ["pre-deploy"], run: { type: "git", repo, ref: sha, entry: "run.mjs" } },
      ],
    });
    const res = makeCaller(ws).runPhase("pre-deploy");
    assert.equal(res.results[0].status, "ok");
    assert.equal(fs.existsSync(dump), true);
  });

  test("a bad ref yields status error", () => {
    const ws = tmp("ws-");
    const { repo } = makeGitRepo({ "run.mjs": "process.exit(0)\n" });
    writeConfig(ws, {
      extensions: [
        { id: "bad-ref", phases: ["pre-deploy"], run: { type: "git", repo, ref: "v9.9.9", entry: "run.mjs" } },
      ],
    });
    const res = makeCaller(ws).runPhase("pre-deploy");
    assert.equal(res.results[0].status, "error");
  });

  test("two extensions sharing a repo@ref clone only once", () => {
    const ws = tmp("ws-");
    const cloneRoot = tmp("clone-");
    const { repo } = makeGitRepo({ "run.mjs": "process.exit(0)\n" });
    writeConfig(ws, {
      extensions: [
        { id: "g1", phases: ["pre-deploy"], run: { type: "git", repo, ref: "v1.0.0", entry: "run.mjs" } },
        { id: "g2", phases: ["pre-deploy"], run: { type: "git", repo, ref: "v1.0.0", entry: "run.mjs" } },
      ],
    });
    const caller = makeCaller(ws, { cloneRoot });
    const res = caller.runPhase("pre-deploy");
    assert.equal(res.results.every((r) => r.status === "ok"), true);
    assert.equal(caller.cloneCache.size, 1);
    const checkouts = fs.readdirSync(cloneRoot).filter((n) => n.startsWith("checkout-"));
    assert.equal(checkouts.length, 1);
  });
});

describe("env & context propagation", () => {
  test("per-extension env plus CAIRNCI_* and JSON context reach the extension", () => {
    const ws = tmp("ws-");
    const dump = path.join(ws, "dump.json");
    writeMjs(ws, "noop.mjs", { exit: 0 }); // not used; keep tree tidy
    fs.writeFileSync(path.join(ws, "run.mjs"), dumpMjsText(dump));
    writeConfig(ws, {
      extensions: [
        {
          id: "ctx-ext",
          phases: ["post-validate-success"],
          env: { CUSTOM_ONE: "world" },
          run: { type: "local", entry: "run.mjs" },
        },
      ],
    });
    const context = { foo: "bar", n: 42, nested: { a: [1, 2] } };
    makeCaller(ws).runPhase("post-validate-success", context);

    const out = JSON.parse(fs.readFileSync(dump, "utf8"));
    assert.equal(out.CAIRNCI_PHASE, "post-validate-success");
    assert.equal(out.CAIRNCI_EXTENSION_ID, "ctx-ext");
    assert.equal(out.CAIRNCI_BLOCKING, "true");
    assert.equal(out.CUSTOM_ONE, "world");
    assert.deepEqual(JSON.parse(out.CAIRNCI_CONTEXT), context);
  });
});

describe("config validation (loadConfig throws ConfigError)", () => {
  const bad = {
    "invalid JSON": "{ not valid json",
    "missing extensions array": { foo: 1 },
    "duplicate id": {
      extensions: [
        { id: "dup", phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } },
        { id: "dup", phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } },
      ],
    },
    "empty id": {
      extensions: [{ id: "  ", phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } }],
    },
    "missing id": {
      extensions: [{ phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } }],
    },
    "empty phases array": {
      extensions: [{ id: "x", phases: [], run: { type: "local", entry: "e.sh" } }],
    },
    "unknown phase name": {
      extensions: [{ id: "x", phases: ["nope"], run: { type: "local", entry: "e.sh" } }],
    },
    "run.type not local/git": {
      extensions: [{ id: "x", phases: ["pre-validate"], run: { type: "http", entry: "e.sh" } }],
    },
    "git run missing repo": {
      extensions: [{ id: "x", phases: ["pre-validate"], run: { type: "git", ref: "v1", entry: "e.sh" } }],
    },
    "git run missing ref": {
      extensions: [{ id: "x", phases: ["pre-validate"], run: { type: "git", repo: "r", entry: "e.sh" } }],
    },
    "git run missing entry": {
      extensions: [{ id: "x", phases: ["pre-validate"], run: { type: "git", repo: "r", ref: "v1" } }],
    },
    "blocking not a boolean": {
      extensions: [{ id: "x", phases: ["pre-validate"], blocking: "yes", run: { type: "local", entry: "e.sh" } }],
    },
  };

  for (const [name, cfg] of Object.entries(bad)) {
    test(`rejects ${name}`, () => {
      const ws = tmp("ws-");
      writeConfig(ws, cfg);
      assert.throws(() => makeCaller(ws).loadConfig(), ConfigError);
    });
  }
});

describe("no-config & select edge cases", () => {
  test("a missing config file makes loadConfig return null and runPhase a clean empty result", () => {
    const ws = tmp("ws-"); // no config written
    const caller = makeCaller(ws);
    assert.equal(caller.loadConfig(), null);
    assert.deepEqual(caller.runPhase("pre-validate"), { phase: "pre-validate", results: [], failed: false });
  });

  test("select() with an unknown phase throws ConfigError", () => {
    const ws = tmp("ws-");
    assert.throws(() => makeCaller(ws).select("not-a-phase", null), ConfigError);
  });
});

describe("GITHUB_STEP_SUMMARY", () => {
  test("writes a markdown results table when the env var points at a file", () => {
    const ws = tmp("ws-");
    const summary = path.join(tmp("sum-"), "summary.md");
    writeConfig(ws, {
      extensions: [{ id: "sum-ext", phases: ["pre-validate"], run: { type: "local", entry: "e.sh" } }],
    });
    writeSh(ws, "e.sh", { exit: 0 });
    process.env.GITHUB_STEP_SUMMARY = summary;
    try {
      makeCaller(ws).runPhase("pre-validate");
    } finally {
      delete process.env.GITHUB_STEP_SUMMARY;
    }
    const md = fs.readFileSync(summary, "utf8");
    assert.match(md, /CairnCI extensions/);
    assert.match(md, /`sum-ext`/);
    assert.match(md, /Duration/);
  });
});
