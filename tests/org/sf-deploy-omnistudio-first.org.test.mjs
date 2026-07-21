// Org-backed validation for the omnistudioStandardRuntimeFirst path in
// sf-deploy.yml. Complements tests/unit/ (fixture-driven) by checking the
// assumptions the split hardcodes against a live org:
//   - the four filtered Metadata API type names exist,
//   - no unknown Omni* types have appeared (forces a filter/docs review),
//   - sfdx-git-delta really emits those type names for real retrieved source,
//     and the workflow's actual split script scopes them correctly,
//   - (opt-in) the resulting OmniStudio-only manifest passes a check-only
//     validation against the org.
//
// Gating — never runs in CI; skips unless explicitly pointed at an org:
//   CAIRNCI_ORG=<sf alias>          enables the org-read-only tests
//   CAIRNCI_ORG_VALIDATE=true       additionally enables the check-only
//                                   validate test (queues a non-committing
//                                   dry-run deployment in the org)
//
//   CAIRNCI_ORG=CairnCI_Production node --test tests/org/*.test.mjs
//
// Org footprint: describes, listMetadata, and a retrieve (all read-only).
// The opt-in validate uses `sf project deploy start --dry-run`, which
// mirrors the workflow's real invocation shape and commits nothing.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OMNI_TYPES, EXCLUDED_TYPES, typesIn, runSplitScript } from "../lib/workflow-scripts.mjs";

const ORG = process.env.CAIRNCI_ORG || "";
const VALIDATE = process.env.CAIRNCI_ORG_VALIDATE === "true";
const skipNoOrg = ORG ? false : "set CAIRNCI_ORG=<sf org alias> to run org-backed tests";
const skipNoValidate = skipNoOrg ||
  (VALIDATE ? false : "set CAIRNCI_ORG_VALIDATE=true to run the check-only validate test");

let cleanupDirs = [];
after(() => {
  for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
});

function sf(args, opts = {}) {
  return spawnSync("sf", args, {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}

function sfJson(args, opts = {}) {
  const res = sf([...args, "--json"], opts);
  try {
    return { status: res.status, body: JSON.parse(res.stdout) };
  } catch {
    assert.fail(`sf ${args.join(" ")} returned non-JSON (exit ${res.status}): ` +
      `${(res.stdout || "").slice(0, 500)} ${(res.stderr || "").slice(0, 500)}`);
  }
}

function git(projectDir, args) {
  const res = spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function sgdInstalled() {
  return /sfdx-git-delta/.test(sf(["plugins"]).stdout || "");
}

// Live Omni* Metadata API type names, memoized (one describe per run).
let omniTypeNames;
function orgOmniTypes() {
  if (!omniTypeNames) {
    const { body } = sfJson(["org", "list", "metadata-types", "--target-org", ORG]);
    omniTypeNames = (body.result?.metadataObjects || [])
      .map((o) => o.xmlName).filter((n) => /^Omni/.test(n)).sort();
    assert.ok(omniTypeNames.length > 0,
      "org exposes no Omni* Metadata API types — is OmniStudio Standard Runtime enabled?");
  }
  return omniTypeNames;
}

// Retrieve one real component per content type into a temp SFDX project, make
// it a 2-commit git repo (baseline without the source, HEAD with it), run
// sfdx-git-delta between them, then run the workflow's actual split script.
// Memoized so the retrieve/dry-run tests share one org round-trip.
let e2e;
function setupEndToEnd() {
  if (e2e) return e2e;

  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cc-org-"));
  cleanupDirs.push(project);
  fs.mkdirSync(path.join(project, "force-app"), { recursive: true });
  fs.writeFileSync(path.join(project, "force-app", ".gitkeep"), "");
  fs.writeFileSync(path.join(project, "sfdx-project.json"), JSON.stringify({
    packageDirectories: [{ path: "force-app", default: true }],
  }, null, 2));

  git(project, ["init", "-q"]);
  git(project, ["config", "user.email", "cairnci-tests@example.invalid"]);
  git(project, ["config", "user.name", "CairnCI org tests"]);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "baseline: empty force-app"]);

  // One real fullName per content type, straight from listMetadata.
  const picked = {};
  for (const t of OMNI_TYPES) {
    const { body } = sfJson(["org", "list", "metadata", "--metadata-type", t, "--target-org", ORG]);
    const records = Array.isArray(body.result) ? body.result : body.result ? [body.result] : [];
    assert.ok(records.length > 0, `org has no ${t} components to retrieve`);
    picked[t] = records[0].fullName;
  }

  const retrieveArgs = ["project", "retrieve", "start", "--target-org", ORG];
  for (const [t, fullName] of Object.entries(picked)) {
    retrieveArgs.push("--metadata", `${t}:${fullName}`);
  }
  const retrieve = sfJson(retrieveArgs, { cwd: project });
  assert.equal(retrieve.status, 0,
    `retrieve failed: ${JSON.stringify(retrieve.body).slice(0, 800)}`);

  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "add retrieved OmniStudio source"]);

  fs.mkdirSync(path.join(project, "changed-sources"), { recursive: true });
  const sgd = sf(["sgd", "source", "delta",
    "--from", "HEAD~1", "--to", "HEAD",
    "--source-dir", "force-app",
    "--output-dir", "changed-sources",
    "--generate-delta"], { cwd: project });
  assert.equal(sgd.status, 0, `sfdx-git-delta failed: ${sgd.stderr}\n${sgd.stdout}`);

  const deltaManifest = path.join(project, "changed-sources", "package", "package.xml");
  assert.ok(fs.existsSync(deltaManifest), "sgd produced no package.xml");

  const outputs = runSplitScript(project);
  e2e = { project, picked, deltaManifest, outputs };
  return e2e;
}

// --- tests ----------------------------------------------------------------------

test("test_org_metadata_api_exposes_content_types", { skip: skipNoOrg }, () => {
  const live = orgOmniTypes();
  for (const t of OMNI_TYPES) {
    assert.ok(live.includes(t),
      `Metadata API type '${t}' (hardcoded in sf-deploy.yml's split) is missing from the org. ` +
      `Org exposes: ${live.join(", ")}`);
  }
});

test("test_org_omni_type_universe_has_no_unknown_types", { skip: skipNoOrg }, () => {
  const known = new Set([...OMNI_TYPES, ...EXCLUDED_TYPES]);
  const unknown = orgOmniTypes().filter((t) => !known.has(t));
  assert.deepEqual(unknown, [],
    `The org exposes Omni* Metadata API types this repo has never classified: ` +
    `${unknown.join(", ")}. Decide per type whether it is deployable content ` +
    `(add to the split filter in sf-deploy.yml) or config/tracking (add to the ` +
    `excluded lists in sf-deploy.yml's comment, docs/consumer-setup.md §5e, and ` +
    `tests/lib/workflow-scripts.mjs).`);
});

test("test_org_retrieve_and_split_end_to_end", { skip: skipNoOrg }, (t) => {
  if (!sgdInstalled()) {
    return t.skip("sfdx-git-delta plugin not installed (sf plugins install sfdx-git-delta@6.31.0)");
  }
  const { project, picked, deltaManifest, outputs } = setupEndToEnd();

  // sfdx-git-delta emitted the exact type names the split filters on.
  const deltaTypes = typesIn(deltaManifest);
  for (const t2 of OMNI_TYPES) {
    assert.ok(deltaTypes.includes(t2),
      `sgd did not emit '${t2}' for retrieved ${t2} source (delta types: ${deltaTypes.join(", ")})`);
  }

  // ...and the workflow's actual split script scoped them correctly.
  assert.equal(outputs["has-omnistudio"], "true");
  const omniPkg = path.join(project, "changed-sources", "omnistudio-pkg.xml");
  assert.deepEqual(typesIn(omniPkg).sort(), [...OMNI_TYPES].sort());
  const omniXml = fs.readFileSync(omniPkg, "utf8");
  for (const [t2, fullName] of Object.entries(picked)) {
    assert.ok(omniXml.includes(`<members>${fullName}</members>`),
      `retrieved ${t2} '${fullName}' missing from omnistudio-pkg.xml members`);
  }
  // Any non-Omni types sgd emitted alongside must have gone to the remainder.
  const extras = deltaTypes.filter((x) => !OMNI_TYPES.includes(x));
  if (extras.length > 0) {
    assert.equal(outputs["has-remainder"], "true");
    const rest = typesIn(path.join(project, "changed-sources", "main-pkg.xml"));
    for (const x of extras) assert.ok(rest.includes(x), `type '${x}' lost by the split`);
  } else {
    assert.equal(outputs["has-remainder"], "false");
  }
});

test("test_org_check_only_validate_of_split_manifest", { skip: skipNoValidate }, (t) => {
  if (!sgdInstalled()) {
    return t.skip("sfdx-git-delta plugin not installed (sf plugins install sfdx-git-delta@6.31.0)");
  }
  const { project } = setupEndToEnd();

  // Mirror the workflow's real invocation shape (no --test-level; the package
  // has no Apex) with --dry-run: full deployability check, nothing committed.
  const res = sfJson(["project", "deploy", "start", "--dry-run",
    "--manifest", "changed-sources/omnistudio-pkg.xml",
    "--target-org", ORG, "--wait", "30"], { cwd: project });
  assert.equal(res.status, 0,
    `check-only validate of the split manifest failed: ${JSON.stringify(res.body?.result?.details?.componentFailures ?? res.body).slice(0, 1500)}`);
  assert.equal(res.body.result?.success, true);
});
