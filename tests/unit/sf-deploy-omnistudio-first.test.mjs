// Org-free tests for the omnistudioStandardRuntimeFirst path in sf-deploy.yml.
// Node built-in runner only — no npm deps:
//   node --test tests/unit/*.test.mjs
//
// The workflow's logic lives in scripts embedded in the YAML (they must — the
// reusable workflow runs in the consumer's checkout, so it can't reference
// files from this repo). These tests extract those embedded scripts from
// sf-deploy.yml by step name and run them against fixture manifests, with a
// stub `sf` binary on PATH that records every invocation.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowYaml = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "sf-deploy.yml"), "utf8");

const OMNI_TYPES = ["OmniScript", "OmniIntegrationProcedure", "OmniDataTransform", "OmniUiCard"];
const EXCLUDED_TYPES = [
  "OmniInteractionConfig", "OmniInteractionAccessConfig", "OmniStudioSettings",
  "OmniSupervisorConfig", "OmniTrackingComponentDef", "OmniTrackingGroup",
  "OmniExtTrackingDef",
];

// --- temp-dir bookkeeping ----------------------------------------------------
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

// --- workflow extraction helpers ----------------------------------------------
// Steps sit at a fixed indentation in sf-deploy.yml (6 spaces for the list
// item, 10 for `run: |` content), so plain text slicing is reliable here.
function stepLines(name) {
  const lines = workflowYaml.split("\n");
  const start = lines.findIndex((l) => l === `      - name: ${name}`);
  assert.notEqual(start, -1, `step not found in sf-deploy.yml: ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^      - name: /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

function stepIf(name) {
  const line = stepLines(name).find((l) => /^        if: /.test(l));
  return line ? line.trim() : "";
}

// Body of the step's `run: |` block, dedented to what bash actually executes.
function stepRun(name) {
  const lines = stepLines(name);
  const idx = lines.findIndex((l) => /^        run: \|/.test(l));
  assert.notEqual(idx, -1, `no run block in step: ${name}`);
  const body = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === "") { body.push(""); continue; }
    if (!l.startsWith("          ")) break;
    body.push(l.slice(10));
  }
  return body.join("\n");
}

// The embedded Node script between  node <<'EOF'  and  EOF .
function stepNodeScript(name) {
  const run = stepRun(name);
  const m = run.match(/node <<'EOF'\n([\s\S]*?)\nEOF(\n|$)/);
  assert.ok(m, `no node heredoc in step: ${name}`);
  return m[1];
}

// --- fixture helpers -----------------------------------------------------------
function packageXml(types) {
  const blocks = Object.entries(types).map(([t, members]) =>
    `    <types>\n${members.map((mm) => `        <members>${mm}</members>`).join("\n")}\n        <name>${t}</name>\n    </types>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${blocks.join("\n")}\n    <version>62.0</version>\n</Package>`;
}

function makeWorkspace(types) {
  const ws = tmp("ws-");
  fs.mkdirSync(path.join(ws, "changed-sources", "package"), { recursive: true });
  fs.writeFileSync(path.join(ws, "changed-sources", "package", "package.xml"), packageXml(types));
  fs.writeFileSync(path.join(ws, "sfdx-project.json"), JSON.stringify({
    packageDirectories: [{ path: "force-app", default: true }],
    sourceApiVersion: "62.0",
  }, null, 2));
  return ws;
}

// Stub `sf` that appends its argv (one line per call) to SF_LOG.
function makeStubBin(ws) {
  const bin = path.join(ws, "stub-bin");
  fs.mkdirSync(bin, { recursive: true });
  const sf = path.join(bin, "sf");
  fs.writeFileSync(sf, `#!/usr/bin/env bash\necho "$*" >> "$SF_LOG"\nexit 0\n`);
  fs.chmodSync(sf, 0o755);
  return bin;
}

function sfCalls(ws) {
  const log = path.join(ws, "sf.log");
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

function typesIn(manifestPath) {
  const xml = fs.readFileSync(manifestPath, "utf8");
  return [...xml.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1].trim());
}

// --- script runners --------------------------------------------------------------
function runSplit(ws, extraEnv = {}) {
  const script = path.join(ws, "split-omnistudio.cjs");
  fs.writeFileSync(script, stepNodeScript("Split OmniStudio Standard Runtime metadata"));
  const outFile = path.join(ws, "github-output");
  fs.writeFileSync(outFile, "");
  const res = spawnSync(process.execPath, [script], {
    cwd: ws, encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: outFile, ...extraEnv },
  });
  assert.equal(res.status, 0, `split script failed: ${res.stderr}`);
  return Object.fromEntries(
    fs.readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => l.split(/=(.*)/s).slice(0, 2)));
}

function runBashStep(ws, stepName, env) {
  const script = path.join(ws, `${stepName.replace(/\W+/g, "-")}.sh`);
  fs.writeFileSync(script, stepRun(stepName));
  const res = spawnSync("bash", [script], {
    cwd: ws, encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${makeStubBin(ws)}:${process.env.PATH}`,
      SF_LOG: path.join(ws, "sf.log"),
      ...env,
    },
  });
  assert.equal(res.status, 0, `step "${stepName}" failed: ${res.stderr}\n${res.stdout}`);
  return res;
}

// Env for the main deploy step's bash, defaults matching a plain delta run.
function deployEnv(overrides = {}) {
  return {
    JOB_ID: "",
    DEPLOY_DIR: "changed-sources/force-app",
    TEST_LEVEL: "RunLocalTests",
    TESTS: "",
    WAIT: "60",
    EFFECTIVE_RULE_DEPLOY: "false",
    HAS_RULES: "",
    HAS_OMNI: "",
    ALLOW_DESTRUCTIVE: "false",
    DELTA: "true",
    ...overrides,
  };
}

// --- tests ----------------------------------------------------------------------

test("test_omnistudio_first_splits_deploy", () => {
  const ws = makeWorkspace({
    OmniScript: ["MyScript"],
    OmniIntegrationProcedure: ["MyIP"],
    OmniDataTransform: ["MyDR"],
    OmniUiCard: ["MyCard"],
    ApexClass: ["MyClass"],
    CustomObject: ["MyObj__c"],
  });

  const out = runSplit(ws);
  assert.equal(out["has-omnistudio"], "true");
  assert.equal(out["has-remainder"], "true");

  // First invocation: the OmniStudio-first step.
  runBashStep(ws, "Deploy OmniStudio Standard Runtime — first",
    { DEPLOY_DIR: "changed-sources/force-app", WAIT: "60" });
  // Second invocation: the main deploy step with the omni split active.
  runBashStep(ws, "Deploy (quick deploy, fallback to full)",
    deployEnv({ HAS_OMNI: "true" }));

  const calls = sfCalls(ws).filter((c) => c.startsWith("project deploy start"));
  assert.equal(calls.length, 2, `expected exactly 2 deploy invocations, got:\n${calls.join("\n")}`);
  assert.match(calls[0], /--manifest changed-sources\/omnistudio-pkg\.xml/);
  assert.match(calls[1], /--manifest changed-sources\/main-pkg\.xml/);
  // The OmniStudio-first invocation runs without an explicit test level
  // (org default; NoTestRun would be rejected by production orgs).
  assert.doesNotMatch(calls[0], /--test-level/);

  // The first manifest is scoped to exactly the four content types.
  assert.deepEqual(
    typesIn(path.join(ws, "changed-sources", "omnistudio-pkg.xml")).sort(),
    [...OMNI_TYPES].sort());
  // The remainder manifest holds everything else, and no OmniStudio content.
  const rest = typesIn(path.join(ws, "changed-sources", "main-pkg.xml"));
  assert.deepEqual(rest.sort(), ["ApexClass", "CustomObject"]);
});

test("test_omnistudio_first_excludes_adjacent_types", () => {
  const excluded = Object.fromEntries(EXCLUDED_TYPES.map((t) => [t, [`Some${t}`]]));
  const ws = makeWorkspace({
    OmniScript: ["MyScript"],
    OmniIntegrationProcedure: ["MyIP"],
    OmniDataTransform: ["MyDR"],
    OmniUiCard: ["MyCard"],
    ...excluded,
  });

  const out = runSplit(ws);
  assert.equal(out["has-omnistudio"], "true");
  assert.equal(out["has-remainder"], "true");

  const omni = typesIn(path.join(ws, "changed-sources", "omnistudio-pkg.xml"));
  for (const t of EXCLUDED_TYPES) {
    assert.ok(!omni.includes(t), `excluded type leaked into omnistudio-pkg.xml: ${t}`);
  }
  assert.deepEqual(omni.sort(), [...OMNI_TYPES].sort());

  const rest = typesIn(path.join(ws, "changed-sources", "main-pkg.xml"));
  assert.deepEqual(rest.sort(), [...EXCLUDED_TYPES].sort());
});

test("test_omnistudio_first_default_off_no_change", () => {
  // The split step can only run when the flag (and delta mode) resolve true.
  const cond = stepIf("Split OmniStudio Standard Runtime metadata");
  assert.match(cond, /env\.EFFECTIVE_OMNISTUDIO_STANDARD_RUNTIME_FIRST == 'true'/);
  assert.match(cond, /env\.EFFECTIVE_DELTA == 'true'/);
  // ...and the OmniStudio-first deploy step only on the split step's output.
  assert.match(stepIf("Deploy OmniStudio Standard Runtime — first"),
    /steps\.split-omnistudio\.outputs\.has-omnistudio == 'true'/);

  // With the flag off (HAS_OMNI unset), the deploy step must behave exactly as
  // before the feature: one invocation, plain --source-dir delta deploy.
  const ws = makeWorkspace({
    OmniScript: ["MyScript"], // present in the delta, but the split never ran
    ApexClass: ["MyClass"],
  });
  runBashStep(ws, "Deploy (quick deploy, fallback to full)", deployEnv());

  const calls = sfCalls(ws);
  assert.deepEqual(calls, [
    "project deploy start --source-dir changed-sources/force-app --test-level RunLocalTests --wait 60",
  ]);
  // No split artifacts appear in default-off mode.
  assert.ok(!fs.existsSync(path.join(ws, "changed-sources", "omnistudio-pkg.xml")));
  assert.ok(!fs.existsSync(path.join(ws, "changed-sources", "main-pkg.xml")));
});
