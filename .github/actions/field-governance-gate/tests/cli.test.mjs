// End-to-end CLI tests for field-governance-gate: real temp git repos, gate.mjs
// spawned as a child, and a local node:http stub for the sticky-comment API.
//   node --test .github/actions/field-governance-gate/tests/cli.test.mjs

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
const CONFIG = ".cairnci/field-governance-gate.json";

// --- temp-dir bookkeeping ---------------------------------------------------
let dirs = [];
let servers = [];
function tmp(prefix = "fgg-") {
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

/** A CustomField file. `gov` is a plain map of governance tag -> text. */
function fieldXml({ type = "Text", extra = "", gov = {} } = {}) {
  const govXml = Object.entries(gov)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><type>${type}</type>${extra}${govXml}</CustomField>\n`;
}
function fieldPath(obj, field) {
  return `${SRC}/objects/${obj}/fields/${field}.field-meta.xml`;
}

// Build a repo with a base commit on main and feature files on a branch.
// `base` files are on main; `feature` files are added/modified on the branch.
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
function runGate(repo, config, { env = {}, args = [], writeConfig = true } = {}) {
  if (writeConfig) {
    writeFile(repo, CONFIG, typeof config === "string" ? config : JSON.stringify(config));
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "config"], repo);
  }
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

// ---------------------------------------------------------------------------
describe("opt-in and environment handling", () => {
  test("no config file -> the gate skips with exit 0", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml() } });
    const r = await runGate(repo, null, { writeConfig: false });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no config at .* — skipping \(the gate is opt-in\)/);
  });

  test("unparseable config -> exit 2", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml() } });
    const r = await runGate(repo, "{ not json");
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /::error::field-governance-gate: could not parse/);
  });

  test("invalid config -> exit 2 with the offending key named", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml() } });
    const r = await runGate(repo, { require: ["bogusAttribute"] });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /unknown attribute "bogusAttribute"/);
  });

  test("an unresolvable base ref -> exit 2, not a crash", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml() } });
    const r = await runGate(repo, { require: ["description"] }, { env: { GATE_BASE_REF: "origin/does-not-exist" } });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /git diff against 'origin\/does-not-exist' failed/);
  });

  test("a diff with no field metadata -> exit 0", async () => {
    const repo = setupRepo({ feature: { "docs/readme.md": "hello\n" } });
    const r = await runGate(repo, { require: ["description"] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no new or modified field metadata in this diff/);
  });
});

// ---------------------------------------------------------------------------
describe("special field types deploy-safe handling (no errors, still governed)", () => {
  // Org-verified against CairnCI_Production: every governance tag validates on
  // formula, auto-number, required and master-detail fields, so none of them is
  // exempt — but none of them may crash the gate either.
  const specials = {
    [fieldPath("Acct__c", "Calc__c")]: fieldXml({ type: "Number", extra: "<formula>1 + 1</formula><formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>" }),
    [fieldPath("Acct__c", "Auto__c")]: fieldXml({ type: "AutoNumber", extra: "<displayFormat>A-{0000}</displayFormat>" }),
    [fieldPath("Acct__c", "Roll__c")]: fieldXml({ type: "Summary" }),
    [fieldPath("Acct__c", "Req__c")]: fieldXml({ extra: "<required>true</required>" }),
    [fieldPath("Acct__c", "Parent__c")]: fieldXml({ type: "MasterDetail", extra: "<referenceTo>Account</referenceTo>" }),
  };

  test("all five special types are audited and reported with type context", async () => {
    const repo = setupRepo({ feature: specials });
    const r = await runGate(repo, { require: ["description"] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    for (const note of ["formula field", "auto-number field", "roll-up summary field", "required field", "master-detail field"]) {
      assert.match(r.stdout, new RegExp(note.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")), `missing context: ${note}`);
    }
    assert.match(r.stdout, /5 field\(s\) audited/);
  });

  test("the same five pass once the metadata is present", async () => {
    const gov = {
      description: "A description that explains what this field is for.",
      inlineHelpText: "Shown as the field tooltip.",
      businessOwnerUser: "owner@example.com",
      businessStatus: "Active",
      securityClassification: "Confidential",
      complianceGroup: "PII",
    };
    const feature = Object.fromEntries(
      Object.entries(specials).map(([p, xml]) => [
        p,
        xml.replace("</CustomField>", Object.entries(gov).map(([k, v]) => `<${k}>${v}</${k}>`).join("") + "</CustomField>"),
      ]),
    );
    const repo = setupRepo({ feature });
    const r = await runGate(repo, {
      require: ["description", "helpText", "dataOwner", "fieldUsage", "dataSensitivity", "compliance"],
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /30 requirement\(s\) satisfied/);
  });

  test("a bare <businessOwner> does not satisfy Data Owner", async () => {
    // Salesforce rejects that element at deploy: accepting it would pass a
    // field that cannot ship.
    const repo = setupRepo({
      feature: { [fieldPath("Acct__c", "X__c")]: fieldXml({ extra: "<businessOwner>owner@example.com</businessOwner>" }) },
    });
    const r = await runGate(repo, { require: ["dataOwner"] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /<businessOwnerUser> or <businessOwnerGroup>/);
  });
});

// ---------------------------------------------------------------------------
describe("running-change scope: new and modified fields", () => {
  const bare = fieldXml();
  const described = fieldXml({ gov: { description: "Now documented properly." } });

  test("an untouched legacy field is never audited", async () => {
    const repo = setupRepo({
      base: { [fieldPath("Acct__c", "Legacy__c")]: bare },
      feature: { "docs/readme.md": "x\n" },
    });
    const r = await runGate(repo, { require: ["description"] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test("touching a legacy field brings it into scope", async () => {
    const repo = setupRepo({
      base: { [fieldPath("Acct__c", "Legacy__c")]: bare },
      feature: { [fieldPath("Acct__c", "Legacy__c")]: fieldXml({ extra: "<label>Renamed</label>" }) },
    });
    const r = await runGate(repo, { require: ["description"] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Acct__c\.Legacy__c/);
  });

  test("fixing the touched field clears it", async () => {
    const repo = setupRepo({
      base: { [fieldPath("Acct__c", "Legacy__c")]: bare },
      feature: { [fieldPath("Acct__c", "Legacy__c")]: described },
    });
    const r = await runGate(repo, { require: ["description"] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test("deleting a field is not a governance finding", async () => {
    const repo = tmp("repo-");
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "t@example.com"], repo);
    git(["config", "user.name", "Test"], repo);
    writeFile(repo, fieldPath("Acct__c", "Gone__c"), bare);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "base"], repo);
    git(["checkout", "-q", "-b", "feature"], repo);
    fs.rmSync(path.join(repo, fieldPath("Acct__c", "Gone__c")));
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "delete"], repo);
    const r = await runGate(repo, { require: ["description"] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

// ---------------------------------------------------------------------------
describe("severity: warn is non-blocking, error is blocking", () => {
  const feature = { [fieldPath("Acct__c", "X__c")]: fieldXml() };

  test("repository-level error -> exit 1", async () => {
    const repo = setupRepo({ feature });
    const r = await runGate(repo, { severity: "error", require: ["description"] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /::error file=.*X__c\.field-meta\.xml,line=1::/);
  });

  test("repository-level warn -> exit 10 and a warning annotation", async () => {
    const repo = setupRepo({ feature });
    const r = await runGate(repo, { severity: "warn", require: ["description"] });
    assert.equal(r.status, 10, r.stdout + r.stderr);
    assert.match(r.stdout, /::warning file=.*X__c\.field-meta\.xml,line=1::/);
    assert.ok(!/::error /.test(r.stdout), "warn severity must not emit error annotations");
  });

  test("per-object override can downgrade error to warn", async () => {
    const repo = setupRepo({
      feature: { [fieldPath("Acct__c", "X__c")]: fieldXml(), [fieldPath("Legacy__c", "Y__c")]: fieldXml() },
    });
    const r = await runGate(repo, {
      severity: "error",
      require: ["description"],
      objectOverrides: { Legacy__c: { severity: "warn" } },
    });
    // Acct__c still errors, so the run blocks; Legacy__c is annotated as a warning.
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /\[error\] Acct__c\.X__c/);
    assert.match(r.stdout, /\[warn\] Legacy__c\.Y__c/);
  });

  test("per-object override can upgrade warn to error", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Regulated__c", "X__c")]: fieldXml() } });
    const r = await runGate(repo, {
      severity: "warn",
      require: ["description"],
      objectOverrides: { Regulated__c: { severity: "error" } },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
  });

  test("warn-only run leaves the whole repo unblocked", async () => {
    const repo = setupRepo({
      feature: { [fieldPath("A__c", "X__c")]: fieldXml(), [fieldPath("B__c", "Y__c")]: fieldXml() },
    });
    const r = await runGate(repo, { severity: "warn", require: ["description", "helpText"] });
    assert.equal(r.status, 10, r.stdout + r.stderr);
    assert.match(r.stdout, /4 finding\(s\)/);
  });
});

// ---------------------------------------------------------------------------
describe("multiple rules resolve per field", () => {
  const config = {
    severity: "error",
    require: ["description"],
    rules: [
      { name: "pii", objects: ["Contact"], severity: "error", require: { description: { minLength: 20 }, dataSensitivity: { allowed: ["Confidential", "Restricted"] } } },
      { name: "scratch", objects: ["Scratch_*"], severity: "warn", require: ["description"] },
      { name: "house", severity: "warn", require: ["description", "helpText"] },
    ],
  };

  test("each field takes its own rule's requirements and severity", async () => {
    const repo = setupRepo({
      feature: {
        [fieldPath("Contact", "SSN__c")]: fieldXml({ gov: { description: "Short", securityClassification: "Public" } }),
        [fieldPath("Scratch_Thing__c", "Tmp__c")]: fieldXml(),
        [fieldPath("Widget__c", "Colour__c")]: fieldXml({ gov: { description: "The colour of the widget." } }),
      },
    });
    const r = await runGate(repo, config);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /\[error\] Contact\.SSN__c: Description is too short.*\[rule: pii\]/);
    assert.match(r.stdout, /\[error\] Contact\.SSN__c: Data Sensitivity Level must be one of: Confidential, Restricted.*\[rule: pii\]/);
    assert.match(r.stdout, /\[warn\] Scratch_Thing__c\.Tmp__c: missing Description.*\[rule: scratch\]/);
    assert.match(r.stdout, /\[warn\] Widget__c\.Colour__c: missing Help Text.*\[rule: house\]/);
  });

  test("satisfying every rule clears the run", async () => {
    const repo = setupRepo({
      feature: {
        [fieldPath("Contact", "SSN__c")]: fieldXml({ gov: { description: "The contact's social security number.", securityClassification: "Restricted" } }),
        [fieldPath("Scratch_Thing__c", "Tmp__c")]: fieldXml({ gov: { description: "Scratch." } }),
        [fieldPath("Widget__c", "Colour__c")]: fieldXml({ gov: { description: "Colour.", inlineHelpText: "Pick one." } }),
      },
    });
    const r = await runGate(repo, config);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

// ---------------------------------------------------------------------------
describe("bypasses at global and rule level", () => {
  const feature = {
    [fieldPath("Account", "Legacy_Code__c")]: fieldXml(),
    [fieldPath("Invoice__c", "Anything__c")]: fieldXml(),
    [fieldPath("Account", "New__c")]: fieldXml(),
  };

  test("global field bypass (exact and wildcard)", async () => {
    const repo = setupRepo({ feature });
    const r = await runGate(repo, {
      require: ["description"],
      bypass: { fields: ["Account.Legacy_Code__c", "Invoice__c.*"] },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /2 bypassed/);
    assert.match(r.stdout, /1 finding\(s\)/);
    assert.match(r.stdout, /Account\.New__c/);
  });

  test("global object bypass clears the whole run", async () => {
    const repo = setupRepo({ feature });
    const r = await runGate(repo, {
      require: ["description"],
      bypass: { objects: ["Account", "Invoice__c"] },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /3 bypassed/);
  });

  test("a rule-level bypass covers only that rule's fields", async () => {
    const repo = setupRepo({
      feature: {
        [fieldPath("Opportunity", "Scratch__c")]: fieldXml(),
        [fieldPath("Account", "Scratch__c")]: fieldXml(),
      },
    });
    const r = await runGate(repo, {
      require: ["description"],
      rules: [
        { name: "sales", objects: ["Opportunity"], bypass: { fields: ["Opportunity.Scratch__c"] } },
        { name: "rest" },
      ],
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /1 bypassed/);
    assert.match(r.stdout, /Account\.Scratch__c/);
    assert.ok(!/Opportunity\.Scratch__c: missing/.test(r.stdout));
  });

  test("global and rule bypasses union", async () => {
    const repo = setupRepo({
      feature: {
        [fieldPath("Account", "Global__c")]: fieldXml(),
        [fieldPath("Account", "RuleOnly__c")]: fieldXml(),
        [fieldPath("Account", "Neither__c")]: fieldXml(),
      },
    });
    const r = await runGate(repo, {
      require: ["description"],
      bypass: { fields: ["Account.Global__c"] },
      rules: [{ name: "acct", objects: ["Account"], bypass: { fields: ["Account.RuleOnly__c"] } }],
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /2 bypassed/);
    assert.match(r.stdout, /Account\.Neither__c/);
  });
});

// ---------------------------------------------------------------------------
describe("standard fields and object families", () => {
  const feature = {
    [fieldPath("Account", "Site")]: fieldXml(), // standard field on a standard object
    [fieldPath("Account", "Custom__c")]: fieldXml(), // custom field on a standard object
    [fieldPath("Setting__mdt", "Value__c")]: fieldXml(),
    [fieldPath("Order__e", "Payload__c")]: fieldXml(),
    [fieldPath("Archive__b", "Key__c")]: fieldXml({ extra: "<required>true</required>" }),
    [fieldPath("Setting__mdt", "DeveloperName")]: fieldXml(),
  };

  test("standard fields are skipped by default; custom fields everywhere are audited", async () => {
    const repo = setupRepo({ feature });
    const r = await runGate(repo, { require: ["description"] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /4 field\(s\) audited/);
    assert.match(r.stdout, /2 skipped/);
    assert.ok(!/Account\.Site:/.test(r.stdout));
    assert.ok(!/Setting__mdt\.DeveloperName:/.test(r.stdout));
  });

  test("includeStandardFields opts standard fields in", async () => {
    const repo = setupRepo({ feature });
    const r = await runGate(repo, { require: ["description"], includeStandardFields: true });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /6 field\(s\) audited/);
    assert.match(r.stdout, /Account\.Site/);
  });

  test("per-family policy: relax __mdt/__e, disable __b", async () => {
    const repo = setupRepo({ feature });
    const r = await runGate(repo, {
      require: ["description", "helpText"],
      objectTypes: {
        customMetadata: { require: ["description"] },
        platformEvent: { require: ["description"], severity: "warn" },
        bigObject: { enabled: false },
      },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /3 field\(s\) audited/);
    assert.ok(!/Archive__b\.Key__c:/.test(r.stdout));
    assert.match(r.stdout, /\[warn\] Order__e\.Payload__c/);
    // Account.Custom__c takes the repo-level pair -> two findings.
    assert.match(r.stdout, /\[error\] Account\.Custom__c: missing Description/);
    assert.match(r.stdout, /\[error\] Account\.Custom__c: missing Help Text/);
  });

  test("a per-object override re-enables one object inside a disabled family", async () => {
    const repo = setupRepo({ feature });
    const r = await runGate(repo, {
      require: ["description"],
      objectTypes: { bigObject: { enabled: false } },
      objectOverrides: { Archive__b: { enabled: true, severity: "warn" } },
    });
    assert.match(r.stdout, /\[warn\] Archive__b\.Key__c/);
  });
});

// ---------------------------------------------------------------------------
describe("step summary and sticky PR comment", () => {
  test("the step summary file gets the findings table", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml() } });
    const summary = path.join(tmp("sum-"), "summary.md");
    const r = await runGate(repo, { require: ["description"] }, { env: { GITHUB_STEP_SUMMARY: summary } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const md = fs.readFileSync(summary, "utf8");
    assert.match(md, /### field-governance-gate/);
    assert.match(md, /\| error \| - \| Acct__c.X__c \| missing Description/);
  });

  function startStub(existingComments = []) {
    const calls = [];
    let existing = existingComments;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, body });
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET") {
          res.writeHead(200);
          res.end(JSON.stringify(existing));
        } else {
          res.writeHead(req.method === "POST" ? 201 : 200);
          res.end(JSON.stringify({ id: 999 }));
        }
      });
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve({ calls, base: `http://127.0.0.1:${server.address().port}`, setExisting: (c) => (existing = c) });
      });
    });
  }

  const commentEnv = (base) => ({
    GITHUB_API_URL: base,
    GITHUB_REPOSITORY: "Fossiltalk/CairnCI-Internal",
    GITHUB_TOKEN: "t0ken",
    PR_NUMBER: "42",
  });

  test("POST when no marker comment exists and there are findings", async () => {
    const stub = await startStub();
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml() } });
    const r = await runGate(repo, { require: ["description"] }, { env: commentEnv(stub.base) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const post = stub.calls.find((c) => c.method === "POST");
    assert.ok(post, "expected a POST");
    assert.match(post.body, /Acct__c\.X__c/);
    assert.match(post.body, /cairnci:field-governance-gate/);
  });

  test("PATCH when a marker comment already exists", async () => {
    const stub = await startStub([{ id: 7, body: "<!-- cairnci:field-governance-gate -->\nold" }]);
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml() } });
    const r = await runGate(repo, { require: ["description"] }, { env: commentEnv(stub.base) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(stub.calls.some((c) => c.method === "PATCH" && c.url.includes("/comments/7")));
  });

  test("all-clear with no existing comment posts nothing", async () => {
    const stub = await startStub();
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml({ gov: { description: "Documented." } }) } });
    const r = await runGate(repo, { require: ["description"] }, { env: commentEnv(stub.base) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!stub.calls.some((c) => c.method !== "GET"), "should not write a comment");
  });

  test("--comment false disables commenting entirely", async () => {
    const stub = await startStub();
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml() } });
    const r = await runGate(repo, { require: ["description"] }, { env: commentEnv(stub.base), args: ["--comment", "false"] });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(stub.calls.length, 0);
    assert.match(r.stdout, /PR commenting disabled/);
  });

  test("a comment API failure never changes the gate result", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml({ gov: { description: "Documented." } }) } });
    const r = await runGate(
      repo,
      { require: ["description"] },
      // Port 1 is not listening: fetch rejects.
      { env: commentEnv("http://127.0.0.1:1") },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /could not list PR comments/);
  });
});

// ---------------------------------------------------------------------------
describe("extension-caller entry point", () => {
  test("run.sh honors CAIRNCI_WORKSPACE and returns the contract exit code", async () => {
    const repo = setupRepo({ feature: { [fieldPath("Acct__c", "X__c")]: fieldXml() } });
    writeFile(repo, CONFIG, JSON.stringify({ severity: "warn", require: ["description"] }));
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "config"], repo);

    const r = spawnSync("bash", [path.join(HERE, "..", "run.sh")], {
      cwd: tmp("elsewhere-"), // deliberately NOT the repo
      encoding: "utf8",
      env: { ...process.env, CAIRNCI_WORKSPACE: repo, GATE_BASE_REF: "main", SOURCE_DIR: "force-app", GITHUB_STEP_SUMMARY: "" },
    });
    assert.equal(r.status, 10, r.stdout + r.stderr);
    assert.match(r.stdout, /Acct__c\.X__c/);
  });
});
