// End-to-end CLI tests for permset-access-gate: real temp git repos, gate.mjs
// spawned as a child, and a local node:http stub for the sticky-comment API.
//   node --test .github/actions/permset-access-gate/tests/cli.test.mjs

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "..", "gate.mjs");
const SRC = "force-app/main/default";

// --- temp-dir bookkeeping ---------------------------------------------------
let dirs = [];
let servers = [];
function tmp(prefix = "psg-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
});

// --- git + fixture helpers --------------------------------------------------
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}
function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function fieldXml(type, extra = "") {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><type>${type}</type>${extra}</CustomField>\n`;
}
function objectXml(sharing = "ReadWrite") {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><sharingModel>${sharing}</sharingModel></CustomObject>\n`;
}
function fieldPerm(field, readable, editable) {
  return `<fieldPermissions><field>${field}</field><readable>${readable}</readable><editable>${editable}</editable></fieldPermissions>`;
}
function objectPerm(obj, flags = {}) {
  const f = { allowRead: false, allowCreate: false, allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false, ...flags };
  return (
    `<objectPermissions><object>${obj}</object>` +
    Object.entries(f).map(([k, v]) => `<${k}>${v}</${k}>`).join("") +
    `</objectPermissions>`
  );
}
function permsetXml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">${inner}</PermissionSet>\n`;
}

// Build a repo with a base commit on main and feature files committed on a
// branch. `base` files are on main; `feature` files are added on the branch.
function setupRepo({ base = {}, feature = {} } = {}) {
  const repo = tmp("repo-");
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFile(repo, "README.md", "base\n");
  for (const [rel, content] of Object.entries(base)) writeFile(repo, rel, content);
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "base"], repo);
  git(["checkout", "-q", "-b", "feature"], repo);
  for (const [rel, content] of Object.entries(feature)) writeFile(repo, rel, content);
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "feature"], repo);
  return repo;
}

// Async spawn (not spawnSync): the sticky-comment tests run a local HTTP stub
// in THIS process, and spawnSync would block the event loop so the stub could
// never answer the gate's fetch — a deadlock. Awaiting an async child keeps the
// parent event loop free to serve those requests.
function runGate(repo, config, { env = {}, args = [] } = {}) {
  writeFile(repo, ".cairnci/permset-access-gate.json", typeof config === "string" ? config : JSON.stringify(config));
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "config"], repo);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATE, ...args], {
      cwd: repo,
      env: { ...process.env, GATE_BASE_REF: "main", SOURCE_DIR: "force-app", GITHUB_STEP_SUMMARY: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// helpers to place field/object/permset files
function fieldPath(obj, field) {
  return `${SRC}/objects/${obj}/fields/${field}.field-meta.xml`;
}
function objectPath(obj) {
  return `${SRC}/objects/${obj}/${obj}.object-meta.xml`;
}
function permsetPath(name) {
  return `${SRC}/permissionsets/${name}.permissionset-meta.xml`;
}

// ---------------------------------------------------------------------------
describe("field FLS special cases (case 1)", () => {
  test("formula/autonumber/summary edit satisfied by readable-only; required & MD field exempt", async () => {
    const repo = setupRepo({
      base: {
        [permsetPath("Sales_Core")]: permsetXml(
          fieldPerm("Acct__c.Calc__c", true, false) +
            fieldPerm("Acct__c.Auto__c", true, false) +
            fieldPerm("Acct__c.Roll__c", true, false),
        ),
      },
      feature: {
        [fieldPath("Acct__c", "Calc__c")]: fieldXml("Number", "<formula>1 + 1</formula>"),
        [fieldPath("Acct__c", "Auto__c")]: fieldXml("AutoNumber"),
        [fieldPath("Acct__c", "Roll__c")]: fieldXml("Summary"),
        [fieldPath("Acct__c", "Req__c")]: fieldXml("Text", "<required>true</required>"),
        [fieldPath("Acct__c", "Parent__c")]: fieldXml("MasterDetail"),
      },
    });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", fieldAccess: "edit", objectAccess: ["read"] }] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

// Semantics live-verified against a real org: a detail object accepts
// viewAll/modifyAll, but the permission set must also grant Read on the master.
describe("editable=true drift on read-only fields", () => {
  // Formula field granted editable=true: deploys, but the org stores false.
  const feature = { [fieldPath("Acct__c", "Calc__c")]: fieldXml("Number", "<formula>1 + 1</formula>") };
  const base = (editable) => ({
    [permsetPath("Sales_Core")]: permsetXml(fieldPerm("Acct__c.Calc__c", true, editable)),
  });

  test("flagged by default -> exit 1", async () => {
    const repo = setupRepo({ base: base(true), feature });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", fieldAccess: "read" }] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /editable=true/);
    assert.match(r.stdout, /drift/i);
  });

  test("opting out globally -> exit 0", async () => {
    const repo = setupRepo({ base: base(true), feature });
    const r = await runGate(repo, {
      flagEditableOnReadOnlyFields: false,
      rules: [{ permissionSet: "Sales_Core", fieldAccess: "read" }],
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test("warn severity makes it non-blocking -> exit 10", async () => {
    const repo = setupRepo({ base: base(true), feature });
    const r = await runGate(repo, {
      rules: [{ permissionSet: "Sales_Core", severity: "warn", fieldAccess: "read" }],
    });
    assert.equal(r.status, 10, r.stdout + r.stderr);
  });

  test("editable=false is clean -> exit 0", async () => {
    const repo = setupRepo({ base: base(false), feature });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", fieldAccess: "read" }] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe("master-detail object access (case 2)", () => {
  // A new detail object plus the master-detail field that names its master.
  const featureObj = {
    [objectPath("Line__c")]: objectXml("ControlledByParent"),
    [fieldPath("Line__c", "Order__c")]: fieldXml("MasterDetail", "<referenceTo>Order__c</referenceTo>"),
  };
  const childPerm = (flags) => objectPerm("Line__c", flags);
  const masterRead = objectPerm("Order__c", { allowRead: true });

  test("detail object passes when fully granted and the master has Read", async () => {
    const repo = setupRepo({
      base: {
        [permsetPath("Sales_Core")]: permsetXml(
          childPerm({ allowRead: true, allowEdit: true, viewAllRecords: true, modifyAllRecords: true }) + masterRead,
        ),
      },
      feature: featureObj,
    });
    const r = await runGate(repo, {
      rules: [{ permissionSet: "Sales_Core", objectAccess: ["read", "edit", "viewAll", "modifyAll"] }],
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test("viewAll/modifyAll are enforced on a detail object, not silently dropped", async () => {
    const repo = setupRepo({
      base: { [permsetPath("Sales_Core")]: permsetXml(childPerm({ allowRead: true, allowEdit: true }) + masterRead) },
      feature: featureObj,
    });
    const r = await runGate(repo, {
      rules: [{ permissionSet: "Sales_Core", objectAccess: ["read", "edit", "viewAll", "modifyAll"] }],
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /viewAll/);
    assert.match(r.stdout, /modifyAll/);
  });

  test("detail object fails when allowEdit is missing", async () => {
    const repo = setupRepo({
      base: { [permsetPath("Sales_Core")]: permsetXml(childPerm({ allowRead: true }) + masterRead) },
      feature: featureObj,
    });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", objectAccess: ["read", "edit"] }] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
  });

  test("master missing Read is reported even when the detail object is fully granted", async () => {
    const repo = setupRepo({
      base: { [permsetPath("Sales_Core")]: permsetXml(childPerm({ allowRead: true })) },
      feature: featureObj,
    });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", objectAccess: ["read"] }] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /master ?-?detail|master/i);
    assert.match(r.stdout, /Order__c/);
  });
});

describe("warn vs error exit codes (case 3)", () => {
  const feature = { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") };
  const warnRule = { permissionSet: "Support_RO", severity: "warn", fieldAccess: "read" };
  const errRule = { permissionSet: "Sales_Core", severity: "error", fieldAccess: "read" };
  const grants = permsetXml(fieldPerm("Acct__c.X__c", true, false));

  test("warn-severity missing permission -> exit 10", async () => {
    const repo = setupRepo({ base: { [permsetPath("Support_RO")]: permsetXml("") }, feature });
    const r = await runGate(repo, { rules: [warnRule] });
    assert.equal(r.status, 10, r.stdout + r.stderr);
  });

  test("error-severity missing permission -> exit 1", async () => {
    const repo = setupRepo({ base: { [permsetPath("Sales_Core")]: permsetXml("") }, feature });
    const r = await runGate(repo, { rules: [errRule] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
  });

  test("both missing (warn + error) -> exit 1", async () => {
    const repo = setupRepo({
      base: { [permsetPath("Support_RO")]: permsetXml(""), [permsetPath("Sales_Core")]: permsetXml("") },
      feature,
    });
    const r = await runGate(repo, { rules: [warnRule, errRule] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
  });

  test("nothing missing -> exit 0", async () => {
    const repo = setupRepo({
      base: { [permsetPath("Support_RO")]: grants, [permsetPath("Sales_Core")]: grants },
      feature,
    });
    const r = await runGate(repo, { rules: [warnRule, errRule] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe("multiple rules attribution (case 4)", () => {
  test("each finding is attributed to the right permission set", async () => {
    const repo = setupRepo({
      base: {
        [permsetPath("Sales_Core")]: permsetXml(fieldPerm("Acct__c.X__c", true, false)), // read ok, edit missing
        [permsetPath("Support_RO")]: permsetXml(fieldPerm("Acct__c.X__c", false, false)), // read missing
      },
      feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") },
    });
    const r = await runGate(repo, {
      rules: [
        { permissionSet: "Sales_Core", severity: "error", fieldAccess: "edit" },
        { permissionSet: "Support_RO", severity: "error", fieldAccess: "read" },
      ],
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Sales_Core.*needs edit/);
    assert.match(r.stdout, /Support_RO.*needs read/);
  });
});

describe("bypasses (case 5)", () => {
  const feature = {
    [fieldPath("Acct__c", "X__c")]: fieldXml("Text"),
    [objectPath("Invoice__c")]: objectXml(),
  };
  const emptyPs = { [permsetPath("Sales_Core")]: permsetXml("") };

  test("global field bypass suppresses the field finding", async () => {
    const repo = setupRepo({ base: emptyPs, feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") } });
    const r = await runGate(repo, {
      bypass: { fields: ["Acct__c.X__c"] },
      rules: [{ permissionSet: "Sales_Core", fieldAccess: "read" }],
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test("wildcard Obj__c.* field bypass covers the whole object", async () => {
    const repo = setupRepo({ base: emptyPs, feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") } });
    const r = await runGate(repo, {
      bypass: { fields: ["acct__c.*"] },
      rules: [{ permissionSet: "Sales_Core", fieldAccess: "read" }],
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test("object bypass suppresses object findings only", async () => {
    const repo = setupRepo({ base: emptyPs, feature });
    const r = await runGate(repo, {
      bypass: { objects: ["Invoice__c"] },
      rules: [{ permissionSet: "Sales_Core", fieldAccess: "read", objectAccess: ["read"] }],
    });
    // field finding remains -> exit 1
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Acct__c\.X__c/);
    assert.doesNotMatch(r.stdout, /object Invoice__c missing/);
  });

  test("per-rule bypass suppresses only that rule", async () => {
    const repo = setupRepo({
      base: { [permsetPath("Sales_Core")]: permsetXml(""), [permsetPath("Support_RO")]: permsetXml("") },
      feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") },
    });
    const r = await runGate(repo, {
      rules: [
        { permissionSet: "Sales_Core", severity: "error", fieldAccess: "read", bypass: { fields: ["Acct__c.X__c"] } },
        { permissionSet: "Support_RO", severity: "error", fieldAccess: "read" },
      ],
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Support_RO/);
    assert.doesNotMatch(r.stdout, /Sales_Core.*needs read/);
  });
});

describe("config handling (case 6)", () => {
  test("missing config file -> exit 0 no-op", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") } });
    // do not write a config file
    git(["add", "-A"], repo);
    const r = spawnSync(process.execPath, [GATE], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GATE_BASE_REF: "main", SOURCE_DIR: "force-app" },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /skipping/);
  });

  test("invalid config (bad severity) -> exit 2", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") } });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", severity: "loud" }] });
    assert.equal(r.status, 2, r.stdout + r.stderr);
  });

  test("invalid config (duplicate permissionSet) -> exit 2", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") } });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core" }, { permissionSet: "sales_core" }] });
    assert.equal(r.status, 2, r.stdout + r.stderr);
  });

  test("invalid config (unknown objectAccess) -> exit 2", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") } });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", objectAccess: ["teleport"] }] });
    assert.equal(r.status, 2, r.stdout + r.stderr);
  });
});

describe("permission set resolution (case 7)", () => {
  test("permset missing from source -> finding at rule severity", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") } });
    const r = await runGate(repo, { rules: [{ permissionSet: "Ghost", severity: "warn" }] });
    assert.equal(r.status, 10, r.stdout + r.stderr);
    assert.match(r.stdout, /permission set not found/);
  });

  test("missing permset does NOT fire on a diff with no new components", async () => {
    // A rule pointing at a permset absent from source must not fail every
    // unrelated PR — the finding only applies when there is something to audit.
    const repo = setupRepo({ feature: { "docs/unrelated.md": "text\n" } });
    const r = await runGate(repo, { rules: [{ permissionSet: "Ghost", severity: "error" }] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no new custom fields or objects/);
  });
});

describe("new-object detection (case 9)", () => {
  test("added custom object yields object findings; __mdt is exempt", async () => {
    const repo = setupRepo({
      base: { [permsetPath("Sales_Core")]: permsetXml("") },
      feature: {
        [objectPath("Widget__c")]: objectXml(),
        [objectPath("Config__mdt")]: objectXml(),
      },
    });
    const r = await runGate(repo, {
      rules: [{ permissionSet: "Sales_Core", objectAccess: ["read", "create"] }],
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /object Widget__c missing/);
    assert.doesNotMatch(r.stdout, /Config__mdt missing/);
  });
});

// --- sticky comment via a local API stub (case 8) ---------------------------
function startStub() {
  const calls = [];
  let existingComments = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify(existingComments));
      } else {
        res.writeHead(req.method === "POST" ? 201 : 200);
        res.end(JSON.stringify({ id: 999 }));
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ calls, base: `http://127.0.0.1:${port}`, setExisting: (c) => (existingComments = c) });
    });
  });
}

describe("sticky PR comment (case 8)", () => {
  const commentEnv = (base) => ({
    GITHUB_API_URL: base,
    GITHUB_REPOSITORY: "Fossiltalk/CairnCI-Internal",
    GITHUB_TOKEN: "t0ken",
    PR_NUMBER: "42",
  });

  test("POST when marker absent and findings present", async () => {
    const stub = await startStub();
    const repo = setupRepo({
      base: { [permsetPath("Sales_Core")]: permsetXml("") },
      feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") },
    });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", fieldAccess: "read" }] }, { env: commentEnv(stub.base) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const post = stub.calls.find((c) => c.method === "POST");
    assert.ok(post, "expected a POST");
    assert.match(post.body, /Acct__c\.X__c/);
  });

  test("PATCH when a marker comment already exists", async () => {
    const stub = await startStub();
    stub.setExisting([{ id: 7, body: "<!-- cairnci:permset-access-gate -->\nold" }]);
    const repo = setupRepo({
      base: { [permsetPath("Sales_Core")]: permsetXml("") },
      feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") },
    });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", fieldAccess: "read" }] }, { env: commentEnv(stub.base) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const patch = stub.calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "expected a PATCH");
    assert.match(patch.url, /issues\/comments\/7/);
  });

  test("no POST when all-clear and no existing comment", async () => {
    const stub = await startStub();
    const repo = setupRepo({
      base: { [permsetPath("Sales_Core")]: permsetXml(fieldPerm("Acct__c.X__c", true, false)) },
      feature: { [fieldPath("Acct__c", "X__c")]: fieldXml("Text") },
    });
    const r = await runGate(repo, { rules: [{ permissionSet: "Sales_Core", fieldAccess: "read" }] }, { env: commentEnv(stub.base) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(stub.calls.some((c) => c.method === "POST"), false);
  });
});
