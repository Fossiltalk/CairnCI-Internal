// Unit tests for the field-governance-gate pure logic.
//   node --test .github/actions/field-governance-gate/tests/field-governance-gate.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTRIBUTES,
  ATTRIBUTE_KEYS,
  ConfigError,
  audit,
  buildCommentBody,
  buildStepSummary,
  canonicalAttribute,
  checkAttribute,
  classifyFields,
  classifyPath,
  effectivePolicy,
  exitCodeForFindings,
  fieldMatches,
  fieldTypeNote,
  isCustomField,
  normalizeRequire,
  objectKind,
  objectMatches,
  objectSuffix,
  parseFieldXml,
  parseNameStatus,
  resolveBaseRef,
  ruleMatches,
  validateConfig,
} from "../lib/field-governance-gate.mjs";

// --- fixture helpers --------------------------------------------------------

const GOV_TAGS = {
  description: (v = "A useful description of this field.") => `<description>${v}</description>`,
  inlineHelpText: (v = "Help text.") => `<inlineHelpText>${v}</inlineHelpText>`,
  businessOwnerUser: (v = "owner@example.com") => `<businessOwnerUser>${v}</businessOwnerUser>`,
  businessOwnerGroup: (v = "Data Stewards") => `<businessOwnerGroup>${v}</businessOwnerGroup>`,
  businessStatus: (v = "Active") => `<businessStatus>${v}</businessStatus>`,
  securityClassification: (v = "Confidential") => `<securityClassification>${v}</securityClassification>`,
  complianceGroup: (v = "PII") => `<complianceGroup>${v}</complianceGroup>`,
};

function fieldXml({ type = "Text", extra = "", gov = [] } = {}) {
  const govXml = gov.map((g) => (typeof g === "string" ? GOV_TAGS[g]() : GOV_TAGS[g.tag](g.value))).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><type>${type}</type>${extra}${govXml}</CustomField>\n`;
}

/** Build the field record shape `audit()` consumes. */
function mkField(object, field, xmlOpts = {}, change = "added") {
  const xml = fieldXml(xmlOpts);
  return {
    object,
    field,
    apiName: `${object}.${field}`,
    path: `force-app/main/default/objects/${object}/fields/${field}.field-meta.xml`,
    change,
    ...parseFieldXml(xml, field),
  };
}

const cfg = (raw) => validateConfig(raw);

// ---------------------------------------------------------------------------
describe("attribute registry", () => {
  test("Data Owner is satisfied by the user OR the group tag", () => {
    // Org-verified: a bare <businessOwner> is rejected by Salesforce at deploy;
    // the real tags are businessOwnerUser / businessOwnerGroup.
    assert.deepEqual(ATTRIBUTES.businessOwner.tags, ["businessOwnerUser", "businessOwnerGroup"]);
    assert.ok(!ATTRIBUTES.businessOwner.tags.includes("businessOwner"));
  });

  test("canonicalAttribute resolves aliases and is case-insensitive", () => {
    assert.equal(canonicalAttribute("helpText"), "inlineHelpText");
    assert.equal(canonicalAttribute("tooltip"), "inlineHelpText");
    assert.equal(canonicalAttribute("dataOwner"), "businessOwner");
    assert.equal(canonicalAttribute("businessOwnerUser"), "businessOwner");
    assert.equal(canonicalAttribute("dataSensitivity"), "securityClassification");
    assert.equal(canonicalAttribute("compliance"), "complianceGroup");
    assert.equal(canonicalAttribute("fieldUsage"), "businessStatus");
    assert.equal(canonicalAttribute("DESCRIPTION"), "description");
    assert.equal(canonicalAttribute("nope"), null);
  });

  test("every canonical key round-trips", () => {
    for (const k of ATTRIBUTE_KEYS) assert.equal(canonicalAttribute(k), k);
  });
});

// ---------------------------------------------------------------------------
describe("object and field kinds", () => {
  test("objectSuffix / objectKind cover every family", () => {
    assert.equal(objectSuffix("Invoice__c"), "__c");
    assert.equal(objectSuffix("Account"), null);
    assert.equal(objectKind("Invoice__c"), "custom");
    assert.equal(objectKind("Account"), "standard");
    assert.equal(objectKind("Setting__mdt"), "customMetadata");
    assert.equal(objectKind("Order_Event__e"), "platformEvent");
    assert.equal(objectKind("Archive__b"), "bigObject");
    assert.equal(objectKind("Ext_Thing__x"), "externalObject");
  });

  test("custom fields end in __c on every object family", () => {
    assert.ok(isCustomField("Note__c"));
    assert.ok(isCustomField("Note__C"));
    assert.ok(!isCustomField("DeveloperName"));
    assert.ok(!isCustomField("ReplayId"));
    assert.ok(!isCustomField("Id"));
  });
});

// ---------------------------------------------------------------------------
describe("XML parsing", () => {
  test("reads every governance tag's value", () => {
    const p = parseFieldXml(
      fieldXml({ gov: ["description", "inlineHelpText", "businessOwnerUser", "businessStatus", "securityClassification", "complianceGroup"] }),
      "Note__c",
    );
    assert.equal(p.values.description.value, "A useful description of this field.");
    assert.equal(p.values.inlineHelpText.value, "Help text.");
    assert.equal(p.values.businessOwner.tag, "businessOwnerUser");
    assert.equal(p.values.businessStatus.value, "Active");
    assert.equal(p.values.securityClassification.value, "Confidential");
    assert.equal(p.values.complianceGroup.value, "PII");
  });

  test("businessOwnerGroup alone satisfies Data Owner", () => {
    const p = parseFieldXml(fieldXml({ gov: ["businessOwnerGroup"] }), "Note__c");
    assert.equal(p.values.businessOwner.tag, "businessOwnerGroup");
    assert.equal(p.values.businessOwner.value, "Data Stewards");
  });

  test("a bare <businessOwner> does NOT satisfy Data Owner", () => {
    // Salesforce rejects that element outright, so accepting it here would
    // green-light a field that cannot deploy.
    const p = parseFieldXml(fieldXml({ extra: "<businessOwner>owner@example.com</businessOwner>" }), "Note__c");
    assert.equal(p.values.businessOwner, undefined);
  });

  test("an empty tag counts as absent", () => {
    const p = parseFieldXml(fieldXml({ extra: "<description></description>" }), "Note__c");
    assert.equal(p.values.description, undefined);
  });

  test("<formula> is detected but <formulaTreatBlanksAs> alone is not", () => {
    assert.ok(parseFieldXml(fieldXml({ extra: "<formula>1+1</formula>" }), "F__c").isFormula);
    assert.ok(!parseFieldXml(fieldXml({ extra: "<formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>" }), "F__c").isFormula);
  });

  test("special field types are flagged for context", () => {
    assert.equal(fieldTypeNote(parseFieldXml(fieldXml({ extra: "<formula>1</formula>" }), "F__c")), "formula field");
    assert.equal(fieldTypeNote(parseFieldXml(fieldXml({ type: "AutoNumber" }), "A__c")), "auto-number field");
    assert.equal(fieldTypeNote(parseFieldXml(fieldXml({ type: "Summary" }), "S__c")), "roll-up summary field");
    assert.equal(fieldTypeNote(parseFieldXml(fieldXml({ type: "MasterDetail" }), "M__c")), "master-detail field");
    assert.equal(fieldTypeNote(parseFieldXml(fieldXml({ extra: "<required>true</required>" }), "R__c")), "required field");
    assert.equal(fieldTypeNote(parseFieldXml(fieldXml({}), "T__c")), null);
  });
});

// ---------------------------------------------------------------------------
describe("path classification and diff parsing", () => {
  test("classifyPath accepts field files under the source dir only", () => {
    assert.deepEqual(classifyPath("force-app/main/default/objects/Account/fields/N__c.field-meta.xml", "force-app"), {
      object: "Account",
      field: "N__c",
    });
    assert.equal(classifyPath("other/main/default/objects/Account/fields/N__c.field-meta.xml", "force-app"), null);
    assert.equal(classifyPath("force-app/main/default/objects/Account/Account.object-meta.xml", "force-app"), null);
    assert.equal(classifyPath("force-app/main/default/classes/Foo.cls", "force-app"), null);
  });

  test("parseNameStatus labels added vs modified", () => {
    const recs = parseNameStatus("A\tforce-app/a.xml\nM\tforce-app/b.xml\n\n");
    assert.deepEqual(recs, [
      { path: "force-app/a.xml", change: "added" },
      { path: "force-app/b.xml", change: "modified" },
    ]);
  });

  test("classifyFields reads and parses each changed field file", () => {
    const files = {
      "/w/force-app/main/default/objects/Account/fields/N__c.field-meta.xml": fieldXml({ gov: ["description"] }),
    };
    const out = classifyFields({
      changed: [
        { path: "force-app/main/default/objects/Account/fields/N__c.field-meta.xml", change: "modified" },
        { path: "force-app/main/default/classes/Foo.cls", change: "added" },
      ],
      sourceDir: "force-app",
      workspace: "/w",
      readFile: (p) => files[p.split("\\").join("/")] ?? null,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].apiName, "Account.N__c");
    assert.equal(out[0].change, "modified");
    assert.equal(out[0].values.description.value, "A useful description of this field.");
  });

  test("resolveBaseRef precedence: arg > env > PR base > HEAD^", () => {
    assert.equal(resolveBaseRef({ baseRefArg: "abc", env: { GATE_BASE_REF: "x", GITHUB_BASE_REF: "y" } }), "abc");
    assert.equal(resolveBaseRef({ env: { GATE_BASE_REF: "x", GITHUB_BASE_REF: "y" } }), "x");
    assert.equal(resolveBaseRef({ env: { GITHUB_BASE_REF: "main" } }), "origin/main");
    assert.equal(resolveBaseRef({ env: {} }), "HEAD^");
  });
});

// ---------------------------------------------------------------------------
describe("config validation", () => {
  test("an empty config gets the built-in defaults", () => {
    const c = cfg({});
    assert.equal(c.severity, "error");
    assert.deepEqual(c.require, { description: {} });
    assert.equal(c.includeStandardFields, false);
    assert.deepEqual(c.rules, []);
  });

  test("require accepts the array form and the object form", () => {
    assert.deepEqual(cfg({ require: ["description", "helpText"] }).require, { description: {}, inlineHelpText: {} });
    assert.deepEqual(cfg({ require: { description: { minLength: 10 }, tooltip: true } }).require, {
      description: { minLength: 10 },
      inlineHelpText: {},
    });
  });

  test("require:false opts a single attribute out", () => {
    assert.deepEqual(normalizeRequire({ description: true, helpText: false }, "require"), { description: {} });
  });

  test("rejects malformed config", () => {
    const bad = [
      [[], "config must be a JSON object"],
      [{ severity: "fatal" }, /must be "error" or "warn"/],
      [{ require: ["nope"] }, /unknown attribute/],
      [{ require: { description: { minLength: -1 } } }, /non-negative integer/],
      [{ require: { description: { allowed: [] } } }, /non-empty array/],
      [{ require: { description: { pattern: "[" } } }, /not a valid regular expression/],
      [{ includeStandardFields: "yes" }, /must be a boolean/],
      [{ bypass: { objects: [1] } }, /array of strings/],
      [{ objectTypes: { nope: {} } }, /unknown kind/],
      [{ rules: {} }, /`rules` must be an array/],
      [{ rules: [{}] }, /name must be a non-empty string/],
      [{ rules: [{ name: "a" }, { name: "A" }] }, /duplicate rule name/],
      [{ rules: [{ name: "a", objects: [1] }] }, /array of strings/],
    ];
    for (const [raw, expected] of bad) {
      assert.throws(() => cfg(raw), (e) => e instanceof ConfigError && (typeof expected === "string" ? e.message.includes(expected) : expected.test(e.message)), JSON.stringify(raw));
    }
  });

  test("$comment keys are ignored everywhere", () => {
    const c = cfg({
      $comment: "x",
      require: { $comment: "y", description: true },
      objectTypes: { $comment: "z", custom: {} },
      objectOverrides: { $comment: "w", Account: { severity: "warn" } },
    });
    assert.deepEqual(c.require, { description: {} });
    assert.equal(c.objectOverrides.account.severity, "warn");
  });
});

// ---------------------------------------------------------------------------
describe("attribute constraint checking", () => {
  const parsed = (gov) => parseFieldXml(fieldXml({ gov }), "N__c");

  test("presence", () => {
    assert.equal(checkAttribute("description", {}, parsed(["description"])).ok, true);
    const miss = checkAttribute("description", {}, parsed([]));
    assert.equal(miss.ok, false);
    assert.match(miss.problem, /missing Description \(<description>\)/);
    assert.equal(miss.actual, "not set");
  });

  test("Data Owner reports both acceptable tags when missing", () => {
    const r = checkAttribute("businessOwner", {}, parsed([]));
    assert.match(r.problem, /<businessOwnerUser> or <businessOwnerGroup>/);
  });

  test("minLength", () => {
    const short = parsed([{ tag: "description", value: "TBD" }]);
    const r = checkAttribute("description", { minLength: 20 }, short);
    assert.equal(r.ok, false);
    assert.match(r.problem, /too short/);
    assert.equal(r.actual, "3 characters");
    assert.equal(checkAttribute("description", { minLength: 3 }, short).ok, true);
  });

  test("allowed values, case-insensitively", () => {
    const f = parsed([{ tag: "securityClassification", value: "Confidential" }]);
    assert.equal(checkAttribute("securityClassification", { allowed: ["Confidential", "Restricted"] }, f).ok, true);
    assert.equal(checkAttribute("securityClassification", { allowed: ["confidential"] }, f).ok, true);
    const bad = checkAttribute("securityClassification", { allowed: ["Public"] }, f);
    assert.equal(bad.ok, false);
    assert.equal(bad.actual, "Confidential");
    assert.match(bad.problem, /must be one of: Public/);
  });

  test("pattern", () => {
    const f = parsed([{ tag: "businessOwnerUser", value: "owner@example.com" }]);
    assert.equal(checkAttribute("businessOwner", { pattern: "@example\\.com$" }, f).ok, true);
    assert.equal(checkAttribute("businessOwner", { pattern: "@other\\.com$" }, f).ok, false);
  });
});

// ---------------------------------------------------------------------------
describe("policy layering", () => {
  test("repository-level severity applies when nothing narrower matches", () => {
    const p = effectivePolicy({ config: cfg({ severity: "warn" }), object: "Account", field: "N__c" });
    assert.equal(p.severity, "warn");
    assert.equal(p.rule, null);
  });

  test("objectTypes layer overrides the repository level", () => {
    const c = cfg({ severity: "error", objectTypes: { platformEvent: { severity: "warn", require: ["description"] } } });
    assert.equal(effectivePolicy({ config: c, object: "Order__e", field: "N__c" }).severity, "warn");
    assert.equal(effectivePolicy({ config: c, object: "Order__c", field: "N__c" }).severity, "error");
  });

  test("the FIRST matching rule wins", () => {
    const c = cfg({
      rules: [
        { name: "pii", objects: ["Contact"], severity: "error", require: ["description", "dataSensitivity"] },
        { name: "catch-all", severity: "warn", require: ["description"] },
      ],
    });
    const contact = effectivePolicy({ config: c, object: "Contact", field: "N__c" });
    assert.equal(contact.rule, "pii");
    assert.equal(contact.severity, "error");
    assert.deepEqual(Object.keys(contact.require), ["description", "securityClassification"]);

    const other = effectivePolicy({ config: c, object: "Account", field: "N__c" });
    assert.equal(other.rule, "catch-all");
    assert.equal(other.severity, "warn");
    assert.deepEqual(Object.keys(other.require), ["description"]);
  });

  test("objectOverrides are the last word, beating a matching rule", () => {
    const c = cfg({
      rules: [{ name: "all", severity: "error", require: ["description", "helpText"] }],
      objectOverrides: { Case: { severity: "warn", require: ["description"] } },
    });
    const p = effectivePolicy({ config: c, object: "Case", field: "N__c" });
    assert.equal(p.rule, "all");
    assert.equal(p.severity, "warn");
    assert.deepEqual(Object.keys(p.require), ["description"]);
  });

  test("objectOverrides match case-insensitively", () => {
    const c = cfg({ objectOverrides: { "invoice__c": { severity: "warn" } } });
    assert.equal(effectivePolicy({ config: c, object: "Invoice__C", field: "N__c" }).severity, "warn");
  });

  test("a layer that omits severity/require inherits it", () => {
    const c = cfg({ severity: "warn", require: ["helpText"], rules: [{ name: "scoped", objects: ["Account"] }] });
    const p = effectivePolicy({ config: c, object: "Account", field: "N__c" });
    assert.equal(p.severity, "warn");
    assert.deepEqual(Object.keys(p.require), ["inlineHelpText"]);
  });

  test("disabling a whole object family, and re-enabling one object inside it", () => {
    const c = cfg({
      objectTypes: { bigObject: { enabled: false } },
      objectOverrides: { Audited__b: { enabled: true, severity: "warn" } },
    });
    assert.equal(effectivePolicy({ config: c, object: "Other__b", field: "N__c" }).enabled, false);
    assert.equal(effectivePolicy({ config: c, object: "Other__b", field: "N__c" }).disabledBy, "objectTypes.bigObject");
    assert.equal(effectivePolicy({ config: c, object: "Audited__b", field: "N__c" }).enabled, true);
  });

  test("ruleMatches: object patterns, field patterns, wildcards, catch-all", () => {
    assert.ok(ruleMatches({ objects: [], fields: [] }, "Account", "N__c"));
    assert.ok(ruleMatches({ objects: ["Account"], fields: [] }, "account", "N__c"));
    assert.ok(ruleMatches({ objects: ["Temp_*"], fields: [] }, "Temp_Thing__c", "N__c"));
    assert.ok(ruleMatches({ objects: [], fields: ["Account.Legacy_*"] }, "Account", "Legacy_Code__c"));
    assert.ok(!ruleMatches({ objects: ["Contact"], fields: [] }, "Account", "N__c"));
  });

  test("bare object patterns never match as field patterns", () => {
    assert.ok(!fieldMatches(["Account"], "Account", "N__c"));
    assert.ok(objectMatches(["Account"], "Account"));
  });
});

// ---------------------------------------------------------------------------
describe("audit: special field types are governed, never errors", () => {
  const special = [
    ["formula", { extra: "<formula>1+1</formula>" }, "formula field"],
    ["auto-number", { type: "AutoNumber", extra: "<displayFormat>A-{0000}</displayFormat>" }, "auto-number field"],
    ["required", { extra: "<required>true</required>" }, "required field"],
    ["master-detail", { type: "MasterDetail", extra: "<referenceTo>Account</referenceTo>" }, "master-detail field"],
    ["roll-up summary", { type: "Summary" }, "roll-up summary field"],
  ];

  for (const [label, xmlOpts, note] of special) {
    test(`a ${label} field missing metadata is reported with type context`, () => {
      // Org-verified: every governance tag deploys on these types, so they are
      // governed like any other field — the type is context, not an exemption.
      const r = audit({ config: cfg({ require: ["description"] }), fields: [mkField("Account", "X__c", xmlOpts)] });
      assert.equal(r.findings.length, 1);
      assert.equal(r.findings[0].context, note);
      assert.equal(r.findings[0].attribute, "description");
      assert.equal(r.audited, 1);
    });

    test(`a ${label} field WITH the metadata passes`, () => {
      const r = audit({
        config: cfg({ require: ["description", "dataOwner", "dataSensitivity"] }),
        fields: [mkField("Account", "X__c", { ...xmlOpts, gov: ["description", "businessOwnerUser", "securityClassification"] })],
      });
      assert.deepEqual(r.findings, []);
      assert.equal(r.satisfied, 3);
      assert.equal(exitCodeForFindings(r.findings), 0);
    });
  }

  test("one field can produce one finding per unmet requirement", () => {
    const r = audit({
      config: cfg({ require: ["description", "helpText", "dataOwner"] }),
      fields: [mkField("Account", "X__c", { gov: ["description"] })],
    });
    assert.equal(r.findings.length, 2);
    assert.deepEqual(r.findings.map((f) => f.attribute).sort(), ["businessOwner", "inlineHelpText"]);
    assert.equal(r.satisfied, 1);
  });
});

// ---------------------------------------------------------------------------
describe("audit: running-change scope", () => {
  test("modified fields get the same full audit as new ones", () => {
    const r = audit({
      config: cfg({ require: ["description"] }),
      fields: [mkField("Account", "Legacy__c", {}, "modified")],
    });
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].change, "modified");
  });

  test("nothing changed -> nothing audited, exit 0", () => {
    const r = audit({ config: cfg({}), fields: [] });
    assert.deepEqual(r.findings, []);
    assert.equal(r.audited, 0);
    assert.equal(exitCodeForFindings(r.findings), 0);
  });
});

// ---------------------------------------------------------------------------
describe("audit: standard vs custom fields and object families", () => {
  test("standard fields are skipped by default", () => {
    const r = audit({ config: cfg({ require: ["description"] }), fields: [mkField("Account", "Site")] });
    assert.deepEqual(r.findings, []);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /standard field/);
  });

  test("includeStandardFields opts them in", () => {
    // The platform accepts governance tags on standard fields (org-verified),
    // so this is a policy switch, not a platform limit.
    const r = audit({ config: cfg({ require: ["description"], includeStandardFields: true }), fields: [mkField("Account", "Site")] });
    assert.equal(r.findings.length, 1);
    assert.equal(r.skipped.length, 0);
  });

  test("built-in fields on __mdt / __e are standard fields and skipped by default", () => {
    const r = audit({
      config: cfg({ require: ["description"] }),
      fields: [mkField("Setting__mdt", "DeveloperName"), mkField("Order__e", "ReplayId")],
    });
    assert.deepEqual(r.findings, []);
    assert.equal(r.skipped.length, 2);
  });

  test("custom fields on every object family are audited by default", () => {
    const fields = [
      mkField("Invoice__c", "N__c"),
      mkField("Account", "N__c"),
      mkField("Setting__mdt", "N__c"),
      mkField("Order__e", "N__c"),
      mkField("Archive__b", "N__c"),
    ];
    const r = audit({ config: cfg({ require: ["description"] }), fields });
    assert.equal(r.audited, 5);
    assert.equal(r.findings.length, 5);
    assert.deepEqual(
      r.findings.map((f) => f.objectKind),
      ["custom", "standard", "customMetadata", "platformEvent", "bigObject"],
    );
  });

  test("per-family policy: lighter requirements for __mdt / __e / __b", () => {
    const config = cfg({
      require: ["description", "helpText", "dataOwner"],
      objectTypes: {
        customMetadata: { require: ["description"] },
        platformEvent: { require: ["description"], severity: "warn" },
        bigObject: { enabled: false },
      },
    });
    const r = audit({
      config,
      fields: [mkField("Setting__mdt", "N__c"), mkField("Order__e", "N__c"), mkField("Archive__b", "N__c"), mkField("Invoice__c", "N__c")],
    });
    const by = (name) => r.findings.filter((f) => f.component === name);
    assert.equal(by("Setting__mdt.N__c").length, 1);
    assert.equal(by("Order__e.N__c").length, 1);
    assert.equal(by("Order__e.N__c")[0].severity, "warn");
    assert.equal(by("Archive__b.N__c").length, 0);
    assert.equal(by("Invoice__c.N__c").length, 3);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /objectTypes.bigObject/);
  });
});

// ---------------------------------------------------------------------------
describe("audit: severity — warn is non-blocking, error is blocking", () => {
  test("error severity yields exit 1", () => {
    const r = audit({ config: cfg({ severity: "error", require: ["description"] }), fields: [mkField("Account", "N__c")] });
    assert.equal(r.findings[0].severity, "error");
    assert.equal(exitCodeForFindings(r.findings), 1);
  });

  test("warn severity yields exit 10", () => {
    const r = audit({ config: cfg({ severity: "warn", require: ["description"] }), fields: [mkField("Account", "N__c")] });
    assert.equal(r.findings[0].severity, "warn");
    assert.equal(exitCodeForFindings(r.findings), 10);
  });

  test("a mix of warn and error escalates to exit 1", () => {
    const config = cfg({
      severity: "warn",
      require: ["description"],
      objectOverrides: { Invoice__c: { severity: "error" } },
    });
    const r = audit({ config, fields: [mkField("Account", "N__c"), mkField("Invoice__c", "N__c")] });
    assert.deepEqual(r.findings.map((f) => f.severity).sort(), ["error", "warn"]);
    assert.equal(exitCodeForFindings(r.findings), 1);
  });

  test("no findings yields exit 0", () => {
    assert.equal(exitCodeForFindings([]), 0);
  });
});

// ---------------------------------------------------------------------------
describe("audit: multiple rules resolve to the right rule per field", () => {
  const config = cfg({
    severity: "error",
    require: ["description"],
    rules: [
      { name: "pii", objects: ["Contact", "Lead"], severity: "error", require: { description: { minLength: 15 }, dataSensitivity: { allowed: ["Confidential", "Restricted"] }, compliance: true } },
      { name: "finance", fields: ["Invoice__c.Amount*"], severity: "error", require: ["description", "dataOwner"] },
      { name: "relaxed", objects: ["Scratch__c"], severity: "warn", require: ["description"] },
      { name: "house-default", severity: "warn", require: ["description", "helpText"] },
    ],
  });

  test("each field is audited by the rule that matches it", () => {
    const fields = [
      mkField("Contact", "SSN__c", { gov: [{ tag: "description", value: "Social security number of the contact." }, { tag: "securityClassification", value: "Public" }] }),
      mkField("Invoice__c", "Amount_Due__c", { gov: ["description"] }),
      mkField("Scratch__c", "Tmp__c"),
      mkField("Widget__c", "Colour__c", { gov: ["description"] }),
    ];
    const r = audit({ config, fields });

    const forField = (n) => r.findings.filter((f) => f.component === n);

    // pii: description long enough, but sensitivity value is not allowed and
    // compliance is missing.
    const ssn = forField("Contact.SSN__c");
    assert.deepEqual(ssn.map((f) => f.rule), ["pii", "pii"]);
    assert.deepEqual(ssn.map((f) => f.attribute).sort(), ["complianceGroup", "securityClassification"]);
    assert.match(ssn.find((f) => f.attribute === "securityClassification").problem, /must be one of: Confidential, Restricted/);

    // finance: description present, data owner missing.
    const amt = forField("Invoice__c.Amount_Due__c");
    assert.equal(amt.length, 1);
    assert.equal(amt[0].rule, "finance");
    assert.equal(amt[0].attribute, "businessOwner");
    assert.equal(amt[0].severity, "error");

    // relaxed: warn severity from its own rule.
    const tmp = forField("Scratch__c.Tmp__c");
    assert.equal(tmp.length, 1);
    assert.equal(tmp[0].rule, "relaxed");
    assert.equal(tmp[0].severity, "warn");

    // house-default catch-all: help text missing, warn.
    const col = forField("Widget__c.Colour__c");
    assert.equal(col.length, 1);
    assert.equal(col[0].rule, "house-default");
    assert.equal(col[0].attribute, "inlineHelpText");
    assert.equal(col[0].severity, "warn");

    // An error from `finance`/`pii` must still block overall.
    assert.equal(exitCodeForFindings(r.findings), 1);
  });

  test("a field matching two rules takes only the first", () => {
    // Lead matches `pii`; it also matches the `house-default` catch-all, but
    // first-match-wins means no duplicate help-text finding.
    const r = audit({ config, fields: [mkField("Lead", "SSN__c", { gov: [{ tag: "description", value: "A sufficiently long description here." }, "securityClassification", "complianceGroup"] })] });
    assert.deepEqual(r.findings, []);
  });

  test("a rule's minLength is enforced against the real text", () => {
    const r = audit({ config, fields: [mkField("Contact", "Note__c", { gov: [{ tag: "description", value: "TBD" }, "securityClassification", "complianceGroup"] })] });
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].attribute, "description");
    assert.match(r.findings[0].problem, /too short \(needs >= 15/);
  });
});

// ---------------------------------------------------------------------------
describe("audit: bypasses", () => {
  const base = { severity: "error", require: ["description"] };

  test("global field bypass, exact and wildcard", () => {
    const config = cfg({ ...base, bypass: { fields: ["Account.Legacy_Code__c", "Invoice__c.*"] } });
    const r = audit({
      config,
      fields: [mkField("Account", "Legacy_Code__c"), mkField("Invoice__c", "Anything__c"), mkField("Account", "New__c")],
    });
    assert.equal(r.bypassed.length, 2);
    assert.deepEqual(r.bypassed.map((b) => b.component).sort(), ["Account.Legacy_Code__c", "Invoice__c.Anything__c"]);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].component, "Account.New__c");
  });

  test("global object bypass, exact and wildcard", () => {
    const config = cfg({ ...base, bypass: { objects: ["Legacy_Thing__c", "Temp_*"] } });
    const r = audit({
      config,
      fields: [mkField("Legacy_Thing__c", "A__c"), mkField("Temp_Stuff__c", "B__c"), mkField("Real__c", "C__c")],
    });
    assert.deepEqual(r.bypassed.map((b) => b.reason), ["object bypass", "object bypass"]);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].component, "Real__c.C__c");
  });

  test("a rule-level bypass applies only to fields that rule governs", () => {
    const config = cfg({
      ...base,
      rules: [
        { name: "sales", objects: ["Opportunity"], bypass: { fields: ["Opportunity.Scratch__c"] } },
        { name: "rest", require: ["description"] },
      ],
    });
    const r = audit({
      config,
      // Same field name on a different object is NOT covered — the bypass
      // belongs to the `sales` rule, and Account resolves to `rest`.
      fields: [mkField("Opportunity", "Scratch__c"), mkField("Account", "Scratch__c")],
    });
    assert.equal(r.bypassed.length, 1);
    assert.equal(r.bypassed[0].component, "Opportunity.Scratch__c");
    assert.equal(r.bypassed[0].rule, "sales");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].component, "Account.Scratch__c");
  });

  test("a rule-level object bypass works too", () => {
    const config = cfg({
      ...base,
      rules: [{ name: "wide", bypass: { objects: ["Sandbox_*"] } }],
    });
    const r = audit({ config, fields: [mkField("Sandbox_Thing__c", "A__c"), mkField("Prod__c", "B__c")] });
    assert.equal(r.bypassed.length, 1);
    assert.equal(r.bypassed[0].component, "Sandbox_Thing__c.A__c");
    assert.equal(r.findings.length, 1);
  });

  test("global and rule bypasses union rather than replace", () => {
    const config = cfg({
      ...base,
      bypass: { fields: ["Account.Global__c"] },
      rules: [{ name: "acct", objects: ["Account"], bypass: { fields: ["Account.RuleOnly__c"] } }],
    });
    const r = audit({
      config,
      fields: [mkField("Account", "Global__c"), mkField("Account", "RuleOnly__c"), mkField("Account", "Neither__c")],
    });
    assert.deepEqual(r.bypassed.map((b) => b.component).sort(), ["Account.Global__c", "Account.RuleOnly__c"]);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].component, "Account.Neither__c");
  });

  test("the global bypass still applies to fields governed by a rule", () => {
    const config = cfg({
      ...base,
      bypass: { objects: ["Contact"] },
      rules: [{ name: "pii", objects: ["Contact"], require: ["description", "dataSensitivity"] }],
    });
    const r = audit({ config, fields: [mkField("Contact", "SSN__c")] });
    assert.deepEqual(r.findings, []);
    assert.equal(r.bypassed.length, 1);
    assert.equal(r.bypassed[0].rule, "pii");
  });

  test("bypassed and skipped fields are not counted as audited", () => {
    const config = cfg({ ...base, bypass: { fields: ["Account.Skip__c"] } });
    const r = audit({ config, fields: [mkField("Account", "Skip__c"), mkField("Account", "Name"), mkField("Account", "Real__c")] });
    assert.equal(r.audited, 1);
    assert.equal(r.bypassed.length, 1);
    assert.equal(r.skipped.length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("reporting", () => {
  const result = () =>
    audit({
      config: cfg({ require: ["description"], rules: [{ name: "r1" }] }),
      fields: [mkField("Account", "N__c"), mkField("Account", "Name")],
    });

  test("step summary lists findings and a tally", () => {
    const md = buildStepSummary(result());
    assert.match(md, /### field-governance-gate/);
    assert.match(md, /\| error \| r1 \| Account.N__c \|/);
    assert.match(md, /Tally: \*\*1\*\* finding\(s\) across 1 audited field\(s\)/);
  });

  test("step summary has an all-clear variant", () => {
    const md = buildStepSummary(audit({ config: cfg({}), fields: [] }));
    assert.match(md, /carries the required governance metadata/);
    assert.ok(!md.includes("| error |"));
  });

  test("comment body carries the sticky marker and a skipped section", () => {
    const body = buildCommentBody(result());
    assert.ok(body.startsWith("<!-- cairnci:field-governance-gate -->"));
    assert.match(body, /Found \*\*1\*\* governance gap\(s\)/);
    assert.match(body, /<details><summary>Skipped \/ bypassed fields \(1\)<\/summary>/);
  });

  test("markdown cells neutralize pipes, newlines and markup from PR content", () => {
    const evil = {
      findings: [
        {
          severity: "error",
          rule: "a|b",
          component: "Account.X__c",
          problem: "line1\nline2 <img src=x> & more",
          actual: "back\\slash",
        },
      ],
      skipped: [],
      bypassed: [],
      satisfied: 0,
      audited: 1,
    };
    const md = buildStepSummary(evil);
    const rows = md.split("\n").filter((l) => l.startsWith("| error"));
    assert.equal(rows.length, 1, "the finding must stay on one table row");
    assert.match(rows[0], /a\\\|b/);
    assert.ok(!rows[0].includes("<img"));
    assert.match(rows[0], /&amp; more/);
    assert.match(rows[0], /back\\\\slash/);
  });

  test("the shipped example config is valid and exercises every feature", () => {
    // examples/ ships only in CairnCI-Internal — the publish workflow syncs the
    // extension directory alone — so skip rather than fail elsewhere.
    const example = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../examples/field-governance-gate.json",
    );
    if (!fs.existsSync(example)) return;

    const c = validateConfig(JSON.parse(fs.readFileSync(example, "utf8")));
    assert.deepEqual(c.rules.map((r) => r.name), ["pii", "sandbox", "house-default"]);
    assert.equal(c.objectTypes.bigObject.enabled, false);
    assert.ok(c.objectOverrides.case, "objectOverrides should be keyed lowercase");

    // The documented layering must actually behave as the comments claim.
    const pii = effectivePolicy({ config: c, object: "Contact", field: "SSN__c" });
    assert.equal(pii.rule, "pii");
    assert.equal(pii.require.description.minLength, 20);
    assert.equal(effectivePolicy({ config: c, object: "Case", field: "X__c" }).severity, "warn");
    assert.equal(effectivePolicy({ config: c, object: "Other__b", field: "X__c" }).enabled, false);
    assert.equal(effectivePolicy({ config: c, object: "Audited_Archive__b", field: "X__c" }).enabled, true);
  });

  test("backticks are stripped from code spans in the comment body", () => {
    const body = buildCommentBody({
      findings: [],
      skipped: [{ component: "Account.`X`__c", reason: "standard field" }],
      bypassed: [],
    });
    assert.ok(!body.includes("`X`"));
    assert.match(body, /`Account.X__c`/);
  });
});
