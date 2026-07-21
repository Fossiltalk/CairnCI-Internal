// STATE-CHANGING live-org test: the full activation round trip the unit and
// read-only live suites cannot cover. Deploys a dedicated throwaway
// OmniScript (tests/fixtures/CairnCITest_CacheRefreshProbe_English_1) to the
// org INACTIVE — the genuine drift state — then runs the shipped bundle,
// which must reuse the CLI session via frontdoor.jsp, drive the real
// omnistudio__OmniLwcCompile page in headless Chrome, and flip the component
// active, confirmed by SOQL. Cleanup always runs (before AND after): the
// fixture is re-deployed inactive (which itself re-validates the premise that
// the Metadata API keeps the source's active state) and then destructively
// deleted, so repeated or crashed runs never leave residue in the org.
//
// Because it mutates org state it has its own gate, separate from the
// read-only suite — use ONLY an org designated for CI testing:
//
//   OMNI_CACHE_REFRESH_LIVE_ACTIVATION_ORG=CairnCI_Production \
//     node --test .github/actions/omnistudio-standard-runtime-cache-refresh/tests/live-org-activation.test.mjs
//
// Requires a local Chrome/Chromium (see findBrowserExecutable) and an
// authenticated sf CLI for the given alias.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findBrowserExecutable } from "../lib/activator.mjs";
import { soqlQuery } from "../lib/org.mjs";

const ORG = process.env.OMNI_CACHE_REFRESH_LIVE_ACTIVATION_ORG || "";
// The activation step needs a local Chrome/Chromium; on hosts without one
// this suite skips (with the reason) rather than failing — mirroring the
// action's own warn-not-fail behavior for a missing browser.
const skip = !ORG
  ? "set OMNI_CACHE_REFRESH_LIVE_ACTIVATION_ORG=<sf org alias> (a CI test org — this suite deploys and deletes metadata)"
  : !findBrowserExecutable({ browserExecutable: "" })
    ? "no Chrome/Chromium executable found — install one or set CHROME_PATH to run the activation round trip"
    : false;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, "..", "dist", "index.mjs");
const FIXTURE = path.join(HERE, "fixtures", "CairnCITest_CacheRefreshProbe_English_1.os-meta.xml");
const PROBE = "CairnCITest_CacheRefreshProbe_English_1";
const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;

function sfJson(args, { allowFailure = false, cwd } = {}) {
  // cwd is REQUIRED for deploys: sf resolves the project from the working
  // directory, and running from the repo root would try to push the repo's
  // entire force-app org-export at the org instead of the tiny fixture.
  const res = spawnSync("sf", [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: DEPLOY_TIMEOUT_MS,
    cwd,
  });
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    assert.fail(`sf ${args.join(" ")} produced no JSON: ${String(res.stderr || res.stdout).slice(0, 400)}`);
  }
  if (!allowFailure) {
    assert.equal(parsed.status, 0, `sf ${args.join(" ")} failed: ${JSON.stringify(parsed).slice(0, 600)}`);
  }
  return parsed;
}

/** Temp SFDX project containing only the fixture OmniScript. */
function fixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-act-"));
  const osDir = path.join(dir, "force-app", "main", "default", "omniScripts");
  fs.mkdirSync(osDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "62.0" }),
  );
  fs.copyFileSync(FIXTURE, path.join(osDir, `${PROBE}.os-meta.xml`));
  return dir;
}

function probeRecord() {
  const records = soqlQuery(
    `SELECT Id, UniqueName, IsActive, VersionNumber FROM OmniProcess WHERE UniqueName = '${PROBE}'`,
    ORG,
  );
  assert.ok(records.length <= 1, `expected at most one ${PROBE} record, got ${records.length}`);
  return records[0] || null;
}

/** Deploy the fixture as-is (isActive=false in source). */
function deployFixtureInactive() {
  const dir = fixtureProject();
  try {
    sfJson(["project", "deploy", "start", "-d", "force-app", "--target-org", ORG], { cwd: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Remove the probe from the org entirely; a no-op when it is not there. */
function destroyProbe() {
  if (!probeRecord()) return;
  // An active OmniScript version cannot be deleted; re-deploying the source
  // (isActive=false) first forces it inactive — the Metadata API keeps the
  // source's active state, the very behavior this extension exists to fix.
  if (probeRecord().IsActive) deployFixtureInactive();
  const dir = fixtureProject();
  try {
    const pkgDir = path.join(dir, "manifest");
    fs.mkdirSync(pkgDir);
    fs.writeFileSync(
      path.join(pkgDir, "package.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <version>62.0</version>\n</Package>\n`,
    );
    fs.writeFileSync(
      path.join(pkgDir, "destructiveChanges.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>${PROBE}</members>\n    <name>OmniScript</name>\n  </types>\n  <version>62.0</version>\n</Package>\n`,
    );
    sfJson(
      [
        "project", "deploy", "start",
        "--manifest", path.join(pkgDir, "package.xml"),
        "--post-destructive-changes", path.join(pkgDir, "destructiveChanges.xml"),
        "--target-org", ORG,
      ],
      { cwd: dir },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(probeRecord(), null, `cleanup failed: ${PROBE} still exists in ${ORG}`);
}

function runBundleAgainstProbe() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "omni-act-run-"));
  fs.mkdirSync(path.join(ws, "changed-sources", "package"), { recursive: true });
  // Manifest only, no deployed source in the workspace: intendsActive
  // defaults to true, matching a caller that deploys OmniStudio elsewhere.
  fs.writeFileSync(
    path.join(ws, "changed-sources", "package", "package.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>${PROBE}</members>\n    <name>OmniScript</name>\n  </types>\n  <version>62.0</version>\n</Package>\n`,
  );
  const summaryFile = path.join(ws, "summary.md");
  const res = spawnSync(
    process.execPath,
    [BUNDLE, "--workspace", ws, "--target-org", ORG, "--activation-timeout-seconds", "180"],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile }, timeout: 8 * 60 * 1000 },
  );
  const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8") : "";
  fs.rmSync(ws, { recursive: true, force: true });
  return { ...res, summary };
}

describe("live-org activation round trip (STATE-CHANGING)", { skip }, () => {
  before(() => {
    assert.ok(fs.existsSync(FIXTURE), `fixture missing: ${FIXTURE}`);
    destroyProbe(); // residue from a crashed earlier run must not skew this one
  });

  after(() => {
    destroyProbe(); // leave the shared CI org exactly as we found it
  });

  test("live_activation_round_trip: deploy inactive -> bundle activates via real browser -> SOQL confirms", () => {
    deployFixtureInactive();
    const before_ = probeRecord();
    assert.ok(before_, `${PROBE} did not land in the org`);
    assert.equal(before_.IsActive, false, "fixture must start inactive (the drift state)");

    const res = runBundleAgainstProbe();
    assert.equal(res.status, 0, `bundle exit ${res.status}:\n${res.stdout}\n${res.stderr}`);
    assert.doesNotMatch(res.stdout, /::warning::/, `unexpected warning:\n${res.stdout}`);
    assert.match(res.stdout, new RegExp(`${PROBE} \\(OmniProcess\\): reactivated`));
    assert.match(res.summary, /reactivated/);

    const after_ = probeRecord();
    assert.ok(after_, `${PROBE} vanished after activation`);
    assert.equal(after_.IsActive, true, "org must show the component active after the round trip");
  });

  test("live_deactivating_redeploy: re-deploying the inactive source flips the org back to inactive", () => {
    // Validates the design-doc premise directly: the Metadata API keeps the
    // source's active state (here: used deliberately, as cleanup relies on it).
    const current = probeRecord();
    assert.ok(current?.IsActive, "expects the activated probe from the previous test");
    deployFixtureInactive();
    assert.equal(probeRecord().IsActive, false, "inactive redeploy must deactivate the org record");
  });
});
