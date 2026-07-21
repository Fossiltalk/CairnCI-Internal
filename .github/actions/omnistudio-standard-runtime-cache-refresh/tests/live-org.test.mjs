// Live-org validation for the assumptions the unit suite has to stub. Runs
// only when OMNI_CACHE_REFRESH_LIVE_ORG names an authenticated sf org alias:
//
//   OMNI_CACHE_REFRESH_LIVE_ORG=CairnCI_Production \
//     node --test .github/actions/omnistudio-standard-runtime-cache-refresh/tests/live-org.test.mjs
//
// Without the env var every test self-skips, so the CI tests/*.test.mjs glob
// stays org-free. Everything here is READ-ONLY against the org: SOQL, object
// describes, metadata listings, and CLI runs whose plans never reach the
// activation step. Deliberately NOT covered: driving the compile pages with
// the headless browser — that mutates org state (recompile/reactivation) and
// must stay a manual, explicitly-invoked step against a chosen component.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULTS, METADATA_TYPE_TO_FAMILY } from "../lib/cache-refresh.mjs";
import { orgSession, soqlQuery } from "../lib/org.mjs";

const ORG = process.env.OMNI_CACHE_REFRESH_LIVE_ORG || "";
const skip = ORG ? false : "set OMNI_CACHE_REFRESH_LIVE_ORG=<sf org alias> to run live-org validation";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, "..", "dist", "index.mjs");

const FAMILIES = ["OmniProcess", "OmniUiCard", "OmniDataTransform"];
const REQUIRED_FIELDS = ["IsActive", "VersionNumber", "UniqueName"];

function sfJson(args) {
  const res = spawnSync("sf", [...args, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, 0, `sf ${args.join(" ")} failed: ${parsed.message || res.stdout.slice(0, 300)}`);
  return parsed.result;
}

/** Split a default page path like /apex/omnistudio__OmniLwcCompile. */
function pageParts(pagePath) {
  const name = pagePath.replace(/^\/apex\//, "");
  const m = /^(?:([A-Za-z0-9]+)__)?(.+)$/.exec(name);
  return { namespace: m[1] || null, page: m[2] };
}

function manifestXml(members, type = "OmniScript") {
  const lines = members.map((m) => `    <members>${m}</members>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n${lines}\n    <name>${type}</name>\n  </types>\n  <version>62.0</version>\n</Package>\n`;
}

function runBundle(members, { type } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "omni-live-"));
  fs.mkdirSync(path.join(ws, "changed-sources", "package"), { recursive: true });
  fs.writeFileSync(path.join(ws, "changed-sources", "package", "package.xml"), manifestXml(members, type));
  const summaryFile = path.join(ws, "summary.md");
  const res = spawnSync(process.execPath, [BUNDLE, "--workspace", ws, "--target-org", ORG], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
  });
  const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8") : "";
  fs.rmSync(ws, { recursive: true, force: true });
  return { ...res, summary };
}

describe("live-org validation (read-only)", { skip }, () => {
  test("live_sobject_contract: IsActive/VersionNumber/UniqueName exist on all three SObjects", () => {
    for (const family of FAMILIES) {
      const r = sfJson(["sobject", "describe", "--sobject", family, "--target-org", ORG]);
      const names = new Set(r.fields.map((f) => f.name));
      for (const field of REQUIRED_FIELDS) {
        assert.ok(names.has(field), `${family} is missing field ${field}`);
      }
    }
  });

  test("live_compile_pages_exist: the shipped default page paths resolve to real ApexPages", () => {
    for (const pagePath of [DEFAULTS.omniscriptCompilePage, DEFAULTS.flexcardCompilePage]) {
      const { namespace, page } = pageParts(pagePath);
      const nsClause = namespace ? `NamespacePrefix = '${namespace}'` : "NamespacePrefix = null";
      const records = soqlQuery(
        `SELECT Id FROM ApexPage WHERE Name = '${page}' AND ${nsClause}`,
        ORG,
      );
      assert.equal(records.length, 1, `default page ${pagePath} not found on ${ORG} — override the page input for this org`);
    }
  });

  test("live_manifest_key_equals_unique_name: metadata fullName matches the SObject UniqueName", () => {
    // The whole sync check rests on this equality (confirmed at design time);
    // re-verify it against whatever this org actually contains.
    let checked = 0;
    for (const [metadataType, family] of Object.entries(METADATA_TYPE_TO_FAMILY)) {
      const listed = sfJson(["org", "list", "metadata", "--metadata-type", metadataType, "--target-org", ORG]);
      const items = (Array.isArray(listed) ? listed : [listed]).filter(Boolean);
      const sample = items.slice(0, 5).map((i) => i.fullName);
      if (sample.length === 0) continue;
      const inList = sample.map((n) => `'${n.replace(/'/g, "\\'")}'`).join(", ");
      const records = soqlQuery(
        `SELECT UniqueName FROM ${family} WHERE UniqueName IN (${inList})`,
        ORG,
      );
      const found = new Set(records.map((r) => r.UniqueName));
      for (const name of sample) {
        assert.ok(found.has(name), `${metadataType} fullName '${name}' has no ${family} row with that UniqueName`);
      }
      checked += sample.length;
    }
    assert.ok(checked > 0, `org ${ORG} has no OmniStudio components to check the key mapping against`);
  });

  test("live_org_session_available: orgSession() reuses the CLI auth (instanceUrl + accessToken)", () => {
    const session = orgSession(ORG);
    assert.match(session.instanceUrl, /^https:\/\//);
    assert.ok(session.accessToken.length > 20, "accessToken looks too short to be real");
  });

  test("live_end_to_end_in_sync_no_op: active org components run through the real bundle as a no-op", (t) => {
    const active = soqlQuery(
      "SELECT UniqueName FROM OmniProcess WHERE IsActive = true ORDER BY LastModifiedDate DESC LIMIT 3",
      ORG,
    );
    if (active.length === 0) {
      t.skip(`org ${ORG} has no active OmniProcess rows to exercise the in-sync path`);
      return;
    }
    const res = runBundle(active.map((r) => r.UniqueName));
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /::warning::/);
    assert.match(res.summary, /in-sync/);
  });

  test("live_missing_component_warns: a bogus manifest member warns once and exits 10", () => {
    const bogus = "CairnCI_LiveTest_DoesNotExist_English_1";
    const res = runBundle([bogus]);
    assert.equal(res.status, 10, res.stdout + res.stderr);
    const warnings = res.stdout.split("\n").filter((l) => l.startsWith("::warning::"));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(bogus));
    assert.match(res.summary, /warning/);
  });
});
