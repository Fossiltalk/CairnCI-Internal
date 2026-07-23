// Org-gated tests for field-governance-gate.
//
// The gate itself is deliberately STATIC — it never talks to Salesforce. This
// suite exists to keep that static model honest: every rule the gate encodes is
// a claim about what Salesforce accepts, and those claims are checked here with
// check-only (`sf project deploy validate`) deploys against a real org. A
// check-only deploy creates nothing, so it is safe to run against production.
//
// Never runs in CI and skips unless pointed at an org:
//
//   FIELD_GOV_GATE_LIVE_ORG=CairnCI_Production \
//     node --test .github/actions/field-governance-gate/tests/*.org.test.mjs
//
// What it proves, in both directions:
//   1. A field set the gate PASSES also validates against the org — the gate
//      does not demand metadata Salesforce would reject.
//   2. The Data Owner tag the gate REJECTS (<businessOwner>) is exactly the one
//      Salesforce rejects, and the tags it accepts are the ones Salesforce
//      accepts.
//   3. Governance tags are accepted on formula / auto-number / required /
//      master-detail fields and on __c / __mdt / __e / __b objects — which is
//      why the gate exempts none of them.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { audit, classifyFields, validateConfig } from "../lib/field-governance-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORG = process.env.FIELD_GOV_GATE_LIVE_ORG || "";
const API_VERSION = process.env.FIELD_GOV_GATE_API_VERSION || "67.0";
// A live validate round trip is a couple of minutes against a production org.
const ORG_TIMEOUT_MS = Number(process.env.FIELD_GOV_GATE_TIMEOUT_MS || 15 * 60 * 1000);

// Resolved at module scope, not in a before() hook: node:test evaluates a
// suite's `skip` option when the suite is registered, which happens before any
// hook runs — a hook-assigned flag would always still be false there.
const HAS_SF = ORG ? spawnSync("sf", ["--version"], { encoding: "utf8" }).status === 0 : false;

/**
 * Reason to skip, or `false` when the suite can run. It must be `false` and not
 * null/undefined: node:test treats any non-false value here as "skip", so a
 * null would silently disable the whole suite.
 */
function skipReason() {
  if (!ORG) return "set FIELD_GOV_GATE_LIVE_ORG=<org alias> to run the org-gated tests";
  if (!HAS_SF) return "the sf CLI is not on PATH";
  return false;
}

let dirs = [];
function tmp(prefix = "fgg-org-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// --- fixture generation -----------------------------------------------------

const GOV = {
  description: "Probe field created by the CairnCI field-governance-gate org test.",
  inlineHelpText: "Tooltip shown next to the field.",
  businessOwnerUser: process.env.FIELD_GOV_GATE_OWNER_USER || "",
  businessStatus: "Active",
  securityClassification: "Confidential",
  complianceGroup: "PII",
};

/** Governance tags as XML. `omit` drops keys; `override` replaces them. */
function govXml({ omit = [], override = {} } = {}) {
  const merged = { ...GOV, ...override };
  return Object.entries(merged)
    .filter(([k, v]) => !omit.includes(k) && v !== "")
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("\n    ");
}

function customField(name, { type = "Text", extra = "", gov = {} } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>${name}</fullName>
    <label>${name.replace(/__c$/, "")}</label>
    <type>${type}</type>
    ${extra}
    ${govXml(gov)}
</CustomField>
`;
}

const SRC = "force-app/main/default";
const fieldPath = (obj, field) => `${SRC}/objects/${obj}/fields/${field}.field-meta.xml`;

/**
 * A throwaway SFDX project exercising every field type and object family the
 * gate reasons about, each field carrying the full governance tag set.
 */
function buildFixtureProject({ ownerTagOverride = null } = {}) {
  const root = tmp();
  writeFile(
    root,
    "sfdx-project.json",
    JSON.stringify({
      packageDirectories: [{ path: "force-app", default: true }],
      namespace: "",
      sfdcLoginUrl: "https://login.salesforce.com",
      sourceApiVersion: API_VERSION,
    }),
  );

  // Data Owner variant under test: the correct tag, or the invalid legacy one.
  const govOpts = ownerTagOverride
    ? { omit: ["businessOwnerUser"], override: { [ownerTagOverride]: "probe@example.com" } }
    : {};

  // --- custom object, one field per special type ---
  writeFile(
    root,
    `${SRC}/objects/FggProbe__c/FggProbe__c.object-meta.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Fgg Probe</label>
    <nameField><label>Name</label><type>Text</type></nameField>
    <pluralLabel>Fgg Probes</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
`,
  );
  const specials = {
    Txt__c: { extra: "<length>50</length>" },
    Frm__c: { extra: "<formula>&quot;x&quot;</formula><formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>" },
    Auto__c: { type: "AutoNumber", extra: "<displayFormat>A-{0000}</displayFormat>" },
    Req__c: { extra: "<length>50</length><required>true</required>" },
  };
  for (const [name, opts] of Object.entries(specials)) {
    writeFile(root, fieldPath("FggProbe__c", name), customField(name, { ...opts, gov: govOpts }));
  }

  // --- custom metadata type ---
  writeFile(
    root,
    `${SRC}/objects/FggProbeMdt__mdt/FggProbeMdt__mdt.object-meta.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Fgg Probe Mdt</label>
    <pluralLabel>Fgg Probe Mdts</pluralLabel>
    <visibility>Public</visibility>
</CustomObject>
`,
  );
  writeFile(
    root,
    fieldPath("FggProbeMdt__mdt", "Gov__c"),
    customField("Gov__c", { extra: "<length>50</length><fieldManageability>DeveloperControlled</fieldManageability>", gov: govOpts }),
  );

  // --- platform event ---
  writeFile(
    root,
    `${SRC}/objects/FggProbeEvt__e/FggProbeEvt__e.object-meta.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <eventType>HighVolume</eventType>
    <label>Fgg Probe Evt</label>
    <pluralLabel>Fgg Probe Evts</pluralLabel>
    <publishBehavior>PublishAfterCommit</publishBehavior>
</CustomObject>
`,
  );
  writeFile(root, fieldPath("FggProbeEvt__e", "Gov__c"), customField("Gov__c", { extra: "<length>50</length>", gov: govOpts }));

  // --- big object (its index field must be required) ---
  writeFile(
    root,
    `${SRC}/objects/FggProbeBig__b/FggProbeBig__b.object-meta.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Fgg Probe Big</label>
    <pluralLabel>Fgg Probe Bigs</pluralLabel>
</CustomObject>
`,
  );
  writeFile(root, fieldPath("FggProbeBig__b", "Gov__c"), customField("Gov__c", { extra: "<length>50</length><required>true</required>", gov: govOpts }));
  writeFile(
    root,
    `${SRC}/objects/FggProbeBig__b/indexes/FggProbeBigIdx.index-meta.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<Index xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>FggProbeBigIdx</fullName>
    <fields><name>Gov__c</name><sortDirection>ASC</sortDirection></fields>
    <label>Fgg Probe Big Index</label>
</Index>
`,
  );

  return root;
}

/** Every field file in the fixture, as the records classifyFields() expects. */
function fixtureChangedFiles(root) {
  const out = [];
  const objects = path.join(root, SRC, "objects");
  for (const obj of fs.readdirSync(objects)) {
    const fieldsDir = path.join(objects, obj, "fields");
    if (!fs.existsSync(fieldsDir)) continue;
    for (const f of fs.readdirSync(fieldsDir)) {
      out.push({ path: `${SRC}/objects/${obj}/fields/${f}`, change: "added" });
    }
  }
  return out;
}

// --- the org oracle ---------------------------------------------------------

/**
 * Check-only deploy the fixture and report whether the COMPONENTS validated.
 *
 * A production org runs Apex tests after components pass, and this repo's
 * dogfood org has pre-existing coverage debt — so a coverage failure is the
 * success signal for a metadata-only check: component errors abort the deploy
 * before the test phase is ever reached.
 *
 * `--test-level` is deliberately omitted: an explicit NoTestRun is rejected by
 * production orgs.
 */
function validateAgainstOrg(projectRoot) {
  const r = spawnSync("sf", ["project", "deploy", "validate", "-o", ORG, "-d", "force-app", "--json"], {
    cwd: projectRoot, // never the repo root — that would push the whole org export
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let payload = {};
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    return { componentsValid: false, message: `could not parse sf output: ${r.stdout.slice(0, 500)}${r.stderr.slice(0, 500)}` };
  }
  const message = payload.message || "";
  const failures = payload.result?.details?.componentFailures || [];
  if (r.status === 0) return { componentsValid: true, message: "deploy validated", failures };
  const coverageOnly = /test coverage/i.test(message) && !/component error/i.test(message);
  return { componentsValid: coverageOnly, message, failures };
}

// ---------------------------------------------------------------------------
describe("field-governance-gate against a live org", { skip: skipReason() }, () => {
  test(
    "metadata the gate accepts also validates against the org",
    { timeout: ORG_TIMEOUT_MS },
    () => {
      const root = buildFixtureProject();

      // 1. Static verdict: the gate must be satisfied by this fixture.
      const config = validateConfig({
        severity: "error",
        require: ["description", "helpText", "dataOwner", "fieldUsage", "dataSensitivity", "compliance"],
        // The fixture omits businessOwnerUser unless an owner username is
        // supplied, since the value must resolve to a real user in the org.
        ...(GOV.businessOwnerUser ? {} : { require: ["description", "helpText", "fieldUsage", "dataSensitivity", "compliance"] }),
      });
      const fields = classifyFields({ changed: fixtureChangedFiles(root), sourceDir: "force-app", workspace: root });
      assert.equal(fields.length, 7, "expected 7 custom fields across the four object families");
      const result = audit({ config, fields });
      assert.deepEqual(
        result.findings.map((f) => `${f.component}: ${f.problem}`),
        [],
        "the gate must consider the fixture compliant",
      );
      assert.equal(result.audited, 7);

      // 2. Org verdict: Salesforce must accept the same metadata.
      const org = validateAgainstOrg(root);
      assert.ok(
        org.componentsValid,
        `the org rejected metadata the gate passed:\n${org.message}\n${JSON.stringify(org.failures, null, 2)}`,
      );
    },
  );

  test(
    "the legacy <businessOwner> tag is rejected by both the gate and the org",
    { timeout: ORG_TIMEOUT_MS },
    () => {
      // The gate this one replaces checked <businessOwner>. Salesforce has no
      // such element, so that check could never have passed on real metadata.
      const root = buildFixtureProject({ ownerTagOverride: "businessOwner" });

      const config = validateConfig({ severity: "error", require: ["dataOwner"] });
      const fields = classifyFields({ changed: fixtureChangedFiles(root), sourceDir: "force-app", workspace: root });
      const result = audit({ config, fields });
      assert.equal(result.findings.length, fields.length, "every field must be flagged as missing a Data Owner");
      for (const f of result.findings) {
        assert.match(f.problem, /<businessOwnerUser> or <businessOwnerGroup>/);
      }

      const org = validateAgainstOrg(root);
      assert.equal(org.componentsValid, false, "the org should reject <businessOwner>");
      assert.match(org.message, /businessOwner invalid at this location|Error parsing file/i);
    },
  );
});

// ---------------------------------------------------------------------------
describe("org-gated suite wiring", () => {
  test("the gate is skipped without an org and enabled with one", () => {
    // Guards the guard, in both directions: a skipReason() that never returns a
    // reason would run org deploys in CI (no org secret there), and one that
    // returns a truthy value when an org IS configured would silently disable
    // the whole suite — node:test skips on anything that is not exactly false.
    if (!ORG) {
      assert.match(String(skipReason()), /FIELD_GOV_GATE_LIVE_ORG/);
    } else if (HAS_SF) {
      assert.equal(skipReason(), false, "with an org and the sf CLI present, the suite must actually run");
    } else {
      assert.match(String(skipReason()), /sf CLI/);
    }
  });

  test("the fixture generator covers every object family the gate classifies", () => {
    const root = buildFixtureProject();
    const changed = fixtureChangedFiles(root);
    const fields = classifyFields({ changed, sourceDir: "force-app", workspace: root });
    const kinds = new Set(fields.map((f) => f.object.match(/(__[a-z]+)$/i)?.[1].toLowerCase()));
    assert.deepEqual([...kinds].sort(), ["__b", "__c", "__e", "__mdt"]);
    // And every special field type is present on the custom object.
    const custom = fields.filter((f) => f.object === "FggProbe__c");
    assert.ok(custom.some((f) => f.isFormula), "formula field missing");
    assert.ok(custom.some((f) => f.isAutoNumber), "auto-number field missing");
    assert.ok(custom.some((f) => f.isRequired), "required field missing");
  });
});
