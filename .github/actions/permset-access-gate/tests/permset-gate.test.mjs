// Unit tests for the permset-access-gate lib. Node built-in runner only.
//   node --test .github/actions/permset-access-gate/tests/permset-gate.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ConfigError,
  validateConfig,
  resolveBaseRef,
  classifyPath,
  objectSuffix,
  parseFieldXml,
  parseObjectXml,
  parsePermissionSet,
  fieldBypassed,
  objectBypassed,
  fieldExemption,
  fieldReadOnlyReason,
  objectExemption,
  audit,
  exitCodeForFindings,
  buildCommentBody,
  buildStepSummary,
  COMMENT_MARKER,
} from "../lib/permset-gate.mjs";

// --- config validation ------------------------------------------------------
describe("validateConfig", () => {
  test("applies defaults (severity=error, fieldAccess=read, objectAccess=[read])", () => {
    const cfg = validateConfig({ rules: [{ permissionSet: "PS" }] });
    assert.equal(cfg.rules[0].severity, "error");
    assert.equal(cfg.rules[0].fieldAccess, "read");
    assert.deepEqual(cfg.rules[0].objectAccess, ["read"]);
    assert.deepEqual(cfg.bypass, { objects: [], fields: [] });
  });

  test("rules must be a non-empty array", () => {
    assert.throws(() => validateConfig({ rules: [] }), ConfigError);
    assert.throws(() => validateConfig({}), ConfigError);
  });

  test("each rule needs a non-empty permissionSet", () => {
    assert.throws(() => validateConfig({ rules: [{ permissionSet: "" }] }), ConfigError);
    assert.throws(() => validateConfig({ rules: [{}] }), ConfigError);
  });

  test("duplicate permissionSet (case-insensitive) is a config error", () => {
    assert.throws(() => validateConfig({ rules: [{ permissionSet: "PS" }, { permissionSet: "ps" }] }), ConfigError);
  });

  test("bad severity, bad fieldAccess, and unknown objectAccess are config errors", () => {
    assert.throws(() => validateConfig({ rules: [{ permissionSet: "PS", severity: "loud" }] }), ConfigError);
    assert.throws(() => validateConfig({ rules: [{ permissionSet: "PS", fieldAccess: "delete" }] }), ConfigError);
    assert.throws(() => validateConfig({ rules: [{ permissionSet: "PS", objectAccess: ["read", "teleport"] }] }), ConfigError);
  });

  test("bypass must be arrays of strings", () => {
    assert.throws(() => validateConfig({ bypass: { objects: [1] }, rules: [{ permissionSet: "PS" }] }), ConfigError);
    assert.throws(() => validateConfig({ rules: [{ permissionSet: "PS", bypass: { fields: [2] } }] }), ConfigError);
  });

  test("ignores unknown top-level keys like $comment", () => {
    const cfg = validateConfig({ $comment: "hi", rules: [{ permissionSet: "PS" }] });
    assert.equal(cfg.rules.length, 1);
  });
});

// --- base ref resolution ----------------------------------------------------
describe("resolveBaseRef", () => {
  test("precedence: arg > GATE_BASE_REF > origin/GITHUB_BASE_REF > HEAD^", () => {
    assert.equal(resolveBaseRef({ baseRefArg: "abc", env: {} }), "abc");
    assert.equal(resolveBaseRef({ env: { GATE_BASE_REF: "main" } }), "main");
    assert.equal(resolveBaseRef({ env: { GITHUB_BASE_REF: "develop" } }), "origin/develop");
    assert.equal(resolveBaseRef({ env: {} }), "HEAD^");
  });
});

// --- path classification ----------------------------------------------------
describe("classifyPath", () => {
  test("detects new fields and objects under the source dir", () => {
    assert.deepEqual(classifyPath("force-app/main/default/objects/Acct__c/fields/X__c.field-meta.xml", "force-app"), {
      kind: "field",
      object: "Acct__c",
      field: "X__c",
    });
    assert.deepEqual(classifyPath("force-app/main/default/objects/Acct__c/Acct__c.object-meta.xml", "force-app"), {
      kind: "object",
      object: "Acct__c",
    });
  });

  test("ignores paths outside the source dir and non-metadata paths", () => {
    assert.equal(classifyPath("other/objects/A__c/fields/X__c.field-meta.xml", "force-app"), null);
    assert.equal(classifyPath("force-app/classes/Foo.cls", "force-app"), null);
  });
});

describe("objectSuffix", () => {
  test("reads the trailing __x suffix", () => {
    assert.equal(objectSuffix("Acct__c"), "__c");
    assert.equal(objectSuffix("Meta__mdt"), "__mdt");
    assert.equal(objectSuffix("Account"), null);
  });
});

// --- XML parsing ------------------------------------------------------------
describe("parseFieldXml", () => {
  test("distinguishes formula from formulaTreatBlanksAs", () => {
    const xml = "<type>Number</type><formula>A + B</formula><formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>";
    const f = parseFieldXml(xml, "X__c");
    assert.equal(f.isFormula, true);
  });

  test("a plain field with only formulaTreatBlanksAs is NOT a formula", () => {
    const f = parseFieldXml("<type>Text</type>", "X__c");
    assert.equal(f.isFormula, false);
  });

  test("reads referenceTo (the master) from a master-detail field", () => {
    const p = parseFieldXml(
      "<CustomField><referenceTo>Order__c</referenceTo><type>MasterDetail</type></CustomField>",
      "Order__c",
    );
    assert.equal(p.isMasterDetail, true);
    assert.equal(p.referenceTo, "Order__c");
  });

  // The shape the Metadata API emits for standard fields — no <type> at all.
  // 4,545 of the 7,332 field files in the force-app org export look like this.
  test("a field file with no <type> parses safely", () => {
    const p = parseFieldXml(
      '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>AccountNumber</fullName>\n    <trackFeedHistory>false</trackFeedHistory>\n</CustomField>',
      "AccountNumber",
    );
    assert.equal(p.type, null);
    assert.equal(p.isFormula, false);
    assert.equal(p.isRequired, false);
    assert.equal(p.isMasterDetail, false);
    assert.equal(p.referenceTo, null);
  });

  test("reads type, required, and master-detail", () => {
    assert.equal(parseFieldXml("<type>MasterDetail</type>", "X__c").isMasterDetail, true);
    assert.equal(parseFieldXml("<type>AutoNumber</type>", "X__c").isAutoNumber, true);
    assert.equal(parseFieldXml("<type>Summary</type>", "X__c").isSummary, true);
    assert.equal(parseFieldXml("<required>true</required>", "X__c").isRequired, true);
  });
});

describe("parseObjectXml", () => {
  test("detects ControlledByParent sharing", () => {
    assert.equal(parseObjectXml("<sharingModel>ControlledByParent</sharingModel>").controlledByParent, true);
    assert.equal(parseObjectXml("<sharingModel>ReadWrite</sharingModel>").controlledByParent, false);
  });
});

describe("parsePermissionSet", () => {
  test("indexes field and object permissions by lowercased API name", () => {
    const xml = `
      <fieldPermissions><field>Acct__c.X__c</field><readable>true</readable><editable>false</editable></fieldPermissions>
      <objectPermissions><object>Acct__c</object><allowRead>true</allowRead><allowEdit>true</allowEdit>
        <allowCreate>false</allowCreate><allowDelete>false</allowDelete>
        <viewAllRecords>false</viewAllRecords><modifyAllRecords>false</modifyAllRecords></objectPermissions>`;
    const ps = parsePermissionSet(xml);
    assert.deepEqual(ps.fieldPermissions.get("acct__c.x__c"), { readable: true, editable: false });
    assert.equal(ps.objectPermissions.get("acct__c").allowRead, true);
    assert.equal(ps.objectPermissions.get("acct__c").allowCreate, false);
  });
});

// --- bypass matching --------------------------------------------------------
describe("bypass matching", () => {
  test("exact and wildcard field bypass, case-insensitive", () => {
    assert.equal(fieldBypassed(["Account.Legacy_Code__c"], "account", "legacy_code__c"), true);
    assert.equal(fieldBypassed(["Invoice__c.*"], "Invoice__c", "Anything__c"), true);
    assert.equal(fieldBypassed(["Invoice__c.*"], "Other__c", "Anything__c"), false);
  });

  test("object bypass with prefix wildcard", () => {
    assert.equal(objectBypassed(["Legacy_Thing__c"], "legacy_thing__c"), true);
    assert.equal(objectBypassed(["Temp_*"], "Temp_Cache__c"), true);
    assert.equal(objectBypassed(["Temp_*"], "Real__c"), false);
  });
});

// --- exemptions -------------------------------------------------------------
describe("exemptions", () => {
  test("master-detail, required, standard, and non-FLS-object fields are exempt", () => {
    assert.ok(fieldExemption({ object: "A__c", field: "X__c", isMasterDetail: true }));
    assert.ok(fieldExemption({ object: "A__c", field: "X__c", isRequired: true }));
    assert.ok(fieldExemption({ object: "A__c", field: "Name" })); // not __c
    assert.ok(fieldExemption({ object: "Meta__mdt", field: "X__c" }));
    assert.equal(fieldExemption({ object: "A__c", field: "X__c" }), null);
  });

  test("read-only-by-nature fields are reported (not exempt)", () => {
    assert.ok(fieldReadOnlyReason({ isFormula: true }));
    assert.ok(fieldReadOnlyReason({ isAutoNumber: true }));
    assert.ok(fieldReadOnlyReason({ isSummary: true }));
    assert.equal(fieldReadOnlyReason({}), null);
  });

  test("non-__c objects are exempt with a reason", () => {
    assert.ok(objectExemption({ name: "Meta__mdt" }));
    assert.ok(objectExemption({ name: "Evt__e" }));
    assert.equal(objectExemption({ name: "Acct__c" }), null);
  });
});

// --- audit ------------------------------------------------------------------
function ps(fieldPerms = {}, objPerms = {}) {
  const fieldPermissions = new Map(Object.entries(fieldPerms).map(([k, v]) => [k.toLowerCase(), v]));
  const objectPermissions = new Map(Object.entries(objPerms).map(([k, v]) => [k.toLowerCase(), v]));
  return { fieldPermissions, objectPermissions };
}
const OBJ_ALL_FALSE = { allowRead: false, allowCreate: false, allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false };

describe("audit — field FLS special cases", () => {
  test("edit request on a formula field is satisfied by readable-only FLS", () => {
    const classified = {
      fields: [{ object: "A__c", field: "Calc__c", apiName: "A__c.Calc__c", isFormula: true }],
      objects: [],
    };
    const permsets = new Map([["sales", { ...ps({ "a__c.calc__c": { readable: true, editable: false } }) }]]);
    const res = audit({ config: validateConfig({ rules: [{ permissionSet: "Sales", fieldAccess: "edit" }] }), classified, permsets });
    assert.equal(res.findings.length, 0);
    assert.equal(res.satisfied, 1);
  });

  test("a required field with zero FLS produces no finding", () => {
    const classified = { fields: [{ object: "A__c", field: "Req__c", apiName: "A__c.Req__c", isRequired: true }], objects: [] };
    const permsets = new Map([["sales", ps()]]);
    const res = audit({ config: validateConfig({ rules: [{ permissionSet: "Sales", fieldAccess: "edit" }] }), classified, permsets });
    assert.equal(res.findings.length, 0);
    assert.equal(res.exempt.length, 1);
  });

  test("a normal edit field lacking editable is a finding", () => {
    const classified = { fields: [{ object: "A__c", field: "X__c", apiName: "A__c.X__c" }], objects: [] };
    const permsets = new Map([["sales", ps({ "a__c.x__c": { readable: true, editable: false } })]]);
    const res = audit({ config: validateConfig({ rules: [{ permissionSet: "Sales", fieldAccess: "edit" }] }), classified, permsets });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].type, "field");
  });
});

// Live-verified against a real org (see README "Master-detail objects"):
// Salesforce ACCEPTS viewAll/modifyAll on a detail object, but REJECTS the
// whole permission set unless the master also has Read.
describe("audit — master-detail child objects", () => {
  const mdChild = { name: "Line__c", isMasterDetailChild: true, masterObject: "Order__c" };
  const masterRead = { order__c: { ...OBJ_ALL_FALSE, allowRead: true } };

  test("viewAll/modifyAll are enforced, not dropped", () => {
    const classified = { fields: [], objects: [mdChild] };
    const permsets = new Map([["sales", ps({}, { line__c: { ...OBJ_ALL_FALSE, allowRead: true, allowEdit: true }, ...masterRead })]]);
    const cfg = validateConfig({ rules: [{ permissionSet: "Sales", objectAccess: ["read", "edit", "viewAll", "modifyAll"] }] });
    const res = audit({ config: cfg, classified, permsets });
    const objFinding = res.findings.find((f) => f.type === "object");
    assert.ok(objFinding, "viewAll/modifyAll must still be checked on a detail object");
    assert.match(objFinding.actual, /viewAll/);
    assert.match(objFinding.actual, /modifyAll/);
  });

  test("full grant on a detail object passes when the master has Read", () => {
    const classified = { fields: [], objects: [mdChild] };
    const permsets = new Map([
      ["sales", ps({}, { line__c: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: true, viewAllRecords: true, modifyAllRecords: true }, ...masterRead })],
    ]);
    const cfg = validateConfig({ rules: [{ permissionSet: "Sales", objectAccess: ["read", "edit", "viewAll", "modifyAll"] }] });
    const res = audit({ config: cfg, classified, permsets });
    assert.equal(res.findings.length, 0);
  });

  test("missing allowEdit still fails (CRUD enforced)", () => {
    const classified = { fields: [], objects: [mdChild] };
    const permsets = new Map([["sales", ps({}, { line__c: { ...OBJ_ALL_FALSE, allowRead: true }, ...masterRead })]]);
    const cfg = validateConfig({ rules: [{ permissionSet: "Sales", objectAccess: ["read", "edit"] }] });
    const res = audit({ config: cfg, classified, permsets });
    assert.equal(res.findings.length, 1);
    assert.match(res.findings[0].actual, /edit/);
  });

  test("master missing Read is its own finding (permission set would not deploy)", () => {
    const classified = { fields: [], objects: [mdChild] };
    // Child fully granted, but the master has no objectPermissions at all.
    const permsets = new Map([["sales", ps({}, { line__c: { ...OBJ_ALL_FALSE, allowRead: true } })]]);
    const cfg = validateConfig({ rules: [{ permissionSet: "Sales", objectAccess: ["read"] }] });
    const res = audit({ config: cfg, classified, permsets });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].type, "master-dependency");
    assert.equal(res.findings[0].component, "Order__c");
    assert.match(res.findings[0].detail, /master/i);
  });

  test("master present but allowRead=false is still a finding", () => {
    const classified = { fields: [], objects: [mdChild] };
    const permsets = new Map([
      ["sales", ps({}, { line__c: { ...OBJ_ALL_FALSE, allowRead: true }, order__c: { ...OBJ_ALL_FALSE, allowCreate: true } })],
    ]);
    const cfg = validateConfig({ rules: [{ permissionSet: "Sales", objectAccess: ["read"] }] });
    const res = audit({ config: cfg, classified, permsets });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].type, "master-dependency");
    assert.equal(res.findings[0].actual, "allowRead=false");
  });

  test("no master-dependency finding when the master is unknown (MD field not in the diff)", () => {
    const classified = { fields: [], objects: [{ name: "Line__c", isMasterDetailChild: true, masterObject: null }] };
    const permsets = new Map([["sales", ps({}, { line__c: { ...OBJ_ALL_FALSE, allowRead: true } })]]);
    const cfg = validateConfig({ rules: [{ permissionSet: "Sales", objectAccess: ["read"] }] });
    const res = audit({ config: cfg, classified, permsets });
    assert.equal(res.findings.length, 0);
  });

  test("bypassing the detail object also suppresses its master-dependency check", () => {
    const classified = { fields: [], objects: [mdChild] };
    const permsets = new Map([["sales", ps({}, {})]]);
    const cfg = validateConfig({ bypass: { objects: ["Line__c"] }, rules: [{ permissionSet: "Sales", objectAccess: ["read"] }] });
    const res = audit({ config: cfg, classified, permsets });
    assert.equal(res.findings.length, 0);
    assert.equal(res.bypassed.length, 1);
  });
});

describe("audit — attribution across multiple rules", () => {
  test("each finding reflects its own rule's requirement", () => {
    const classified = { fields: [{ object: "A__c", field: "X__c", apiName: "A__c.X__c" }], objects: [] };
    const permsets = new Map([
      ["core", ps({ "a__c.x__c": { readable: true, editable: false } })],
      ["ro", ps({ "a__c.x__c": { readable: false, editable: false } })],
    ]);
    const cfg = validateConfig({
      rules: [
        { permissionSet: "Core", fieldAccess: "edit", severity: "error" },
        { permissionSet: "RO", fieldAccess: "read", severity: "warn" },
      ],
    });
    const res = audit({ config: cfg, classified, permsets });
    const core = res.findings.find((f) => f.permissionSet === "Core");
    const ro = res.findings.find((f) => f.permissionSet === "RO");
    assert.equal(core.required, "edit");
    assert.equal(core.severity, "error");
    assert.equal(ro.required, "read");
    assert.equal(ro.severity, "warn");
  });
});

describe("audit — bypasses", () => {
  const field = { object: "A__c", field: "X__c", apiName: "A__c.X__c" };
  const missing = new Map([["sales", ps({})]]);

  test("global field bypass suppresses the finding", () => {
    const cfg = validateConfig({ bypass: { fields: ["A__c.X__c"] }, rules: [{ permissionSet: "Sales" }] });
    const res = audit({ config: cfg, classified: { fields: [field], objects: [] }, permsets: missing });
    assert.equal(res.findings.length, 0);
    assert.equal(res.bypassed.length, 1);
  });

  test("wildcard field bypass Obj__c.* covers the whole object's fields, case-insensitive", () => {
    const cfg = validateConfig({ bypass: { fields: ["a__C.*"] }, rules: [{ permissionSet: "Sales" }] });
    const res = audit({ config: cfg, classified: { fields: [field], objects: [] }, permsets: missing });
    assert.equal(res.findings.length, 0);
  });

  test("object bypass suppresses object findings only, not field findings", () => {
    const obj = { name: "A__c", isMasterDetailChild: false };
    const cfg = validateConfig({ bypass: { objects: ["A__c"] }, rules: [{ permissionSet: "Sales" }] });
    const res = audit({ config: cfg, classified: { fields: [field], objects: [obj] }, permsets: missing });
    // object suppressed, but the field is still a finding
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].type, "field");
  });

  test("per-rule bypass suppresses only that rule; the other rule still reports", () => {
    const permsets = new Map([["core", ps({})], ["extra", ps({})]]);
    const cfg = validateConfig({
      rules: [
        { permissionSet: "Core", bypass: { fields: ["A__c.X__c"] } },
        { permissionSet: "Extra" },
      ],
    });
    const res = audit({ config: cfg, classified: { fields: [field], objects: [] }, permsets });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].permissionSet, "Extra");
  });
});

describe("audit — permission set not found", () => {
  test("produces a finding at the rule's severity when the diff has new components", () => {
    const cfg = validateConfig({ rules: [{ permissionSet: "Ghost", severity: "warn" }] });
    const classified = { fields: [{ object: "A__c", field: "X__c", apiName: "A__c.X__c" }], objects: [] };
    const res = audit({ config: cfg, classified, permsets: new Map() });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].type, "permset");
    assert.equal(res.findings[0].severity, "warn");
  });

  test("does not fire on an empty diff (no new components to audit)", () => {
    const cfg = validateConfig({ rules: [{ permissionSet: "Ghost", severity: "error" }] });
    const res = audit({ config: cfg, classified: { fields: [], objects: [] }, permsets: new Map() });
    assert.equal(res.findings.length, 0);
  });
});

describe("exitCodeForFindings", () => {
  test("error -> 1, warn -> 10, none -> 0", () => {
    assert.equal(exitCodeForFindings([{ severity: "error" }]), 1);
    assert.equal(exitCodeForFindings([{ severity: "warn" }, { severity: "error" }]), 1);
    assert.equal(exitCodeForFindings([{ severity: "warn" }]), 10);
    assert.equal(exitCodeForFindings([]), 0);
  });
});

describe("reporting", () => {
  test("comment body leads with the marker and lists every finding", () => {
    const result = {
      findings: [
        { permissionSet: "Sales", severity: "error", component: "A__c.X__c", required: "edit", actual: "no FieldPermissions entry" },
        { permissionSet: "Sales", severity: "error", component: "B__c", required: "read", actual: "no objectPermissions entry" },
      ],
      exempt: [{ component: "A__c.Calc__c", type: "field", reason: "formula field" }],
      bypassed: [],
    };
    const body = buildCommentBody(result);
    assert.ok(body.startsWith(COMMENT_MARKER));
    assert.match(body, /A__c\.X__c/);
    assert.match(body, /B__c/);
    assert.match(body, /<details>/);
  });

  test("all-clear comment body has no findings table", () => {
    const body = buildCommentBody({ findings: [], exempt: [], bypassed: [] });
    assert.ok(body.startsWith(COMMENT_MARKER));
    assert.doesNotMatch(body, /Severity/);
  });

  test("step summary shows a tally", () => {
    const md = buildStepSummary({ findings: [], exempt: [], bypassed: [], satisfied: 3 });
    assert.match(md, /Tally/);
    assert.match(md, /3 satisfied/);
  });
});
