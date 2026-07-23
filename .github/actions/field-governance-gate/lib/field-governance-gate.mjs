// field-governance-gate — pure logic for the CairnCI extension that gates a PR
// on whether newly created and modified Salesforce custom fields carry the
// governance metadata the repo requires (description, help text, data owner,
// field usage, data sensitivity, compliance categorization).
//
// This module is deliberately side-effect-free: no process.exit, no network at
// import time, and every function is directly unit-testable. The CLI (gate.mjs)
// wires arguments, env, git, annotations, the step summary and the sticky PR
// comment around it.
//
// Zero runtime dependencies: node: builtins only, so the same code runs inside
// the composite action and under `node --test`. Salesforce field metadata files
// are small, single-purpose XML, so lightweight regex extraction is used
// instead of a full XML parser (no deps allowed).
//
// Org-verified behavior this encodes (check-only deploys against a live
// production org, 2026-07-23):
//   - The Data Owner tags are <businessOwnerUser> and <businessOwnerGroup>.
//     A bare <businessOwner> is rejected outright: "Element ...businessOwner
//     invalid at this location in type CustomField".
//   - Every governance tag validates on custom-object fields (including
//     formula, auto-number and required fields), on __mdt / __e / __b fields,
//     and on standard fields. Unlike field-level security, governance metadata
//     has no platform-level carve-outs — so the gate treats the differences
//     between those kinds as *policy* (configurable) rather than as hard
//     exemptions, and only special-cases what the platform actually refuses.
//   - A check-only deploy did NOT reject arbitrary <securityClassification> /
//     <businessStatus> values, so value correctness is worth enforcing here;
//     that is what the `allowed` constraint is for.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export class ConfigError extends Error {}

export const COMMENT_MARKER = "<!-- cairnci:field-governance-gate -->";

// --- the governable attributes ----------------------------------------------

/**
 * The field metadata this gate can require. `tags` lists the CustomField XML
 * elements that satisfy the requirement — more than one when Salesforce offers
 * alternatives (Data Owner is either a user or a group, and either one counts).
 */
export const ATTRIBUTES = {
  description: { tags: ["description"], label: "Description" },
  inlineHelpText: { tags: ["inlineHelpText"], label: "Help Text" },
  businessOwner: { tags: ["businessOwnerUser", "businessOwnerGroup"], label: "Data Owner" },
  businessStatus: { tags: ["businessStatus"], label: "Field Usage" },
  securityClassification: { tags: ["securityClassification"], label: "Data Sensitivity Level" },
  complianceGroup: { tags: ["complianceGroup"], label: "Compliance Categorization" },
};

/** Friendly aliases accepted in config, mapped to the canonical attribute key. */
export const ATTRIBUTE_ALIASES = {
  helpText: "inlineHelpText",
  tooltip: "inlineHelpText",
  dataOwner: "businessOwner",
  owner: "businessOwner",
  businessOwnerUser: "businessOwner",
  businessOwnerGroup: "businessOwner",
  fieldUsage: "businessStatus",
  dataSensitivity: "securityClassification",
  sensitivity: "securityClassification",
  compliance: "complianceGroup",
};

export const ATTRIBUTE_KEYS = Object.keys(ATTRIBUTES);

/** Valid keys inside a `require` constraints object. */
export const CONSTRAINT_KEYS = ["severity", "minLength", "allowed", "pattern"];

/** Canonical attribute key for a config-supplied name, or null if unknown. */
export function canonicalAttribute(name) {
  if (typeof name !== "string") return null;
  if (Object.hasOwn(ATTRIBUTES, name)) return name;
  if (Object.hasOwn(ATTRIBUTE_ALIASES, name)) return ATTRIBUTE_ALIASES[name];
  // Case-insensitive fallback so "Description" and "helptext" both resolve.
  const lower = name.toLowerCase();
  for (const k of ATTRIBUTE_KEYS) if (k.toLowerCase() === lower) return k;
  for (const [alias, target] of Object.entries(ATTRIBUTE_ALIASES)) {
    if (alias.toLowerCase() === lower) return target;
  }
  return null;
}

// --- object / field kinds ---------------------------------------------------

/** Trailing-`__x` suffix of an API name (e.g. "__c", "__mdt"), lowercased. */
export function objectSuffix(name) {
  const m = name.match(/(__[a-z]+)$/i);
  return m ? m[1].toLowerCase() : null;
}

export const OBJECT_KINDS = ["custom", "standard", "customMetadata", "platformEvent", "bigObject", "externalObject"];

/** Which family an object API name belongs to. Drives the objectTypes config. */
export function objectKind(objectName) {
  switch (objectSuffix(objectName)) {
    case "__c":
      return "custom";
    case "__mdt":
      return "customMetadata";
    case "__e":
      return "platformEvent";
    case "__b":
      return "bigObject";
    case "__x":
      return "externalObject";
    default:
      return "standard";
  }
}

/**
 * True when the field is a custom field. Custom fields end in `__c` on every
 * object family — including __mdt / __e / __b, whose own built-in fields
 * (DeveloperName, ReplayId, ...) are standard and are skipped by default.
 */
export function isCustomField(fieldName) {
  return /__c$/i.test(fieldName);
}

// --- config -----------------------------------------------------------------

export const BUILTIN_DEFAULTS = {
  severity: "error",
  require: { description: {} },
};

/**
 * Load and validate the gate config. Returns null when the file does not exist
 * (the gate is opt-in, same philosophy as the extension caller); throws
 * ConfigError on any invalid content.
 */
export function loadConfig(configFile) {
  if (!fs.existsSync(configFile)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (e) {
    throw new ConfigError(`could not parse ${configFile}: ${e.message}`);
  }
  return validateConfig(raw);
}

/** Normalize + validate a bypass object ({objects, fields} of string arrays). */
function normalizeBypass(b, where) {
  if (b === undefined || b === null) return { objects: [], fields: [] };
  if (typeof b !== "object" || Array.isArray(b)) throw new ConfigError(`${where} must be an object`);
  const objects = b.objects === undefined ? [] : b.objects;
  const fields = b.fields === undefined ? [] : b.fields;
  if (!Array.isArray(objects) || !objects.every((s) => typeof s === "string")) {
    throw new ConfigError(`${where}.objects must be an array of strings`);
  }
  if (!Array.isArray(fields) || !fields.every((s) => typeof s === "string")) {
    throw new ConfigError(`${where}.fields must be an array of strings`);
  }
  return { objects, fields };
}

function normalizeSeverity(v, where) {
  if (v === undefined) return undefined;
  if (v !== "error" && v !== "warn") throw new ConfigError(`${where} must be "error" or "warn"`);
  return v;
}

/**
 * Normalize a `require` declaration into `{ <attributeKey>: <constraints> }`.
 *
 * Two accepted forms, so simple policies stay simple:
 *   ["description", "dataSensitivity"]                      — presence only
 *   { "description": { "minLength": 20 }, "helpText": true } — with constraints
 *
 * `false` opts an attribute out, which is how a narrow layer (a rule, an object
 * override) drops one requirement without restating the whole set.
 */
export function normalizeRequire(raw, where) {
  if (raw === undefined) return undefined;
  const out = {};
  const add = (name, constraints) => {
    const key = canonicalAttribute(name);
    if (!key) {
      throw new ConfigError(`${where} has unknown attribute "${name}" (valid: ${ATTRIBUTE_KEYS.join(", ")})`);
    }
    out[key] = constraints;
  };

  if (Array.isArray(raw)) {
    for (const name of raw) {
      if (typeof name !== "string") throw new ConfigError(`${where} array entries must be strings`);
      add(name, {});
    }
    return out;
  }
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`${where} must be an array of attribute names or an object`);
  }
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith("$")) continue; // $comment keys
    if (value === false) continue; // explicit opt-out
    if (value === true) {
      add(name, {});
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigError(`${where}.${name} must be true, false, or a constraints object`);
    }
    // Reject unknown keys rather than dropping them. A silently ignored
    // constraint reads as configured while doing nothing, which is the worst
    // possible failure for a policy file — a typo'd `severty` would leave the
    // requirement blocking merges with no indication why.
    for (const k of Object.keys(value)) {
      if (k.startsWith("$")) continue;
      if (!CONSTRAINT_KEYS.includes(k)) {
        throw new ConfigError(`${where}.${name} has unknown constraint "${k}" (valid: ${CONSTRAINT_KEYS.join(", ")})`);
      }
    }
    const c = {};
    // Per-attribute severity: overrides the layer's severity for this one
    // requirement, so "a missing description blocks, a missing tooltip only
    // warns" is expressible without splitting the policy into scoped rules
    // (which are matched per field, not per attribute, so they cannot do it).
    const sev = normalizeSeverity(value.severity, `${where}.${name}.severity`);
    if (sev !== undefined) c.severity = sev;
    if (value.minLength !== undefined) {
      if (!Number.isInteger(value.minLength) || value.minLength < 0) {
        throw new ConfigError(`${where}.${name}.minLength must be a non-negative integer`);
      }
      c.minLength = value.minLength;
    }
    if (value.allowed !== undefined) {
      if (!Array.isArray(value.allowed) || value.allowed.length === 0 || !value.allowed.every((s) => typeof s === "string")) {
        throw new ConfigError(`${where}.${name}.allowed must be a non-empty array of strings`);
      }
      c.allowed = value.allowed;
    }
    if (value.pattern !== undefined) {
      if (typeof value.pattern !== "string") throw new ConfigError(`${where}.${name}.pattern must be a string`);
      try {
        new RegExp(value.pattern);
      } catch (e) {
        throw new ConfigError(`${where}.${name}.pattern is not a valid regular expression: ${e.message}`);
      }
      c.pattern = value.pattern;
    }
    add(name, c);
  }
  return out;
}

/** A config layer contributing severity/require, used by rules and overrides. */
function normalizeLayer(raw, where) {
  return {
    severity: normalizeSeverity(raw.severity, `${where}.severity`),
    require: normalizeRequire(raw.require, `${where}.require`),
  };
}

/**
 * Validate raw parsed config and return a normalized shape with defaults
 * applied. Throws ConfigError on any violation. Unknown top-level keys (e.g.
 * "$comment") are ignored.
 */
export function validateConfig(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config must be a JSON object");
  }

  const severity = normalizeSeverity(raw.severity, "severity") ?? BUILTIN_DEFAULTS.severity;
  const require = normalizeRequire(raw.require, "require") ?? { ...BUILTIN_DEFAULTS.require };

  // Standard fields are off by default: the platform accepts governance tags on
  // them, but a standard field's metadata file is usually a partial customization
  // (a picklist value, a label) and was not authored by this PR.
  const includeStandardFields = raw.includeStandardFields === undefined ? false : raw.includeStandardFields;
  if (typeof includeStandardFields !== "boolean") {
    throw new ConfigError("includeStandardFields must be a boolean");
  }

  const bypass = normalizeBypass(raw.bypass, "bypass");

  // Per object family (custom / standard / customMetadata / platformEvent /
  // bigObject / externalObject). All enabled by default.
  const objectTypes = {};
  if (raw.objectTypes !== undefined) {
    if (typeof raw.objectTypes !== "object" || raw.objectTypes === null || Array.isArray(raw.objectTypes)) {
      throw new ConfigError("objectTypes must be an object");
    }
    for (const [kind, value] of Object.entries(raw.objectTypes)) {
      if (kind.startsWith("$")) continue;
      if (!OBJECT_KINDS.includes(kind)) {
        throw new ConfigError(`objectTypes has unknown kind "${kind}" (valid: ${OBJECT_KINDS.join(", ")})`);
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ConfigError(`objectTypes.${kind} must be an object`);
      }
      const enabled = value.enabled === undefined ? true : value.enabled;
      if (typeof enabled !== "boolean") throw new ConfigError(`objectTypes.${kind}.enabled must be a boolean`);
      objectTypes[kind] = { enabled, ...normalizeLayer(value, `objectTypes.${kind}`) };
    }
  }

  // Per-object overrides — the last word, applied after any matching rule.
  const objectOverrides = {};
  if (raw.objectOverrides !== undefined) {
    if (typeof raw.objectOverrides !== "object" || raw.objectOverrides === null || Array.isArray(raw.objectOverrides)) {
      throw new ConfigError("objectOverrides must be an object");
    }
    for (const [object, value] of Object.entries(raw.objectOverrides)) {
      if (object.startsWith("$")) continue;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ConfigError(`objectOverrides.${object} must be an object`);
      }
      const enabled = value.enabled === undefined ? true : value.enabled;
      if (typeof enabled !== "boolean") throw new ConfigError(`objectOverrides.${object}.enabled must be a boolean`);
      objectOverrides[object.toLowerCase()] = {
        object,
        enabled,
        ...normalizeLayer(value, `objectOverrides.${object}`),
      };
    }
  }

  // Rules are scoped policy layers, matched in declaration order — FIRST match
  // wins. Unlike permset-access-gate (whose rules each target a different
  // permission set and therefore all apply), these rules all check the same
  // family of attributes, so applying every match would just emit duplicate
  // findings for one field.
  const rules = [];
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) throw new ConfigError("`rules` must be an array");
    const seen = new Set();
    raw.rules.forEach((r, i) => {
      const where = `rules[${i}]`;
      if (typeof r !== "object" || r === null || Array.isArray(r)) throw new ConfigError(`${where} must be an object`);
      if (typeof r.name !== "string" || r.name.trim() === "") {
        throw new ConfigError(`${where}.name must be a non-empty string`);
      }
      const key = r.name.toLowerCase();
      if (seen.has(key)) throw new ConfigError(`duplicate rule name "${r.name}"`);
      seen.add(key);

      const objects = r.objects === undefined ? [] : r.objects;
      if (!Array.isArray(objects) || !objects.every((s) => typeof s === "string")) {
        throw new ConfigError(`${where}.objects must be an array of strings`);
      }
      const fields = r.fields === undefined ? [] : r.fields;
      if (!Array.isArray(fields) || !fields.every((s) => typeof s === "string")) {
        throw new ConfigError(`${where}.fields must be an array of strings`);
      }
      const enabled = r.enabled === undefined ? true : r.enabled;
      if (typeof enabled !== "boolean") throw new ConfigError(`${where}.enabled must be a boolean`);

      rules.push({
        name: r.name,
        objects,
        fields,
        enabled,
        ...normalizeLayer(r, where),
        bypass: normalizeBypass(r.bypass, `${where}.bypass`),
      });
    });
  }

  return { severity, require, includeStandardFields, bypass, objectTypes, objectOverrides, rules };
}

// --- git delta --------------------------------------------------------------

/**
 * Resolve the base ref for the diff: --base-ref arg, else GATE_BASE_REF, else
 * origin/$GITHUB_BASE_REF when running on a PR, else HEAD^.
 */
export function resolveBaseRef({ baseRefArg, env = process.env } = {}) {
  if (baseRefArg) return baseRefArg;
  if (env.GATE_BASE_REF) return env.GATE_BASE_REF;
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`;
  return "HEAD^";
}

/**
 * Added or modified (AM) file paths between the merge-base of `baseRef` and
 * HEAD — the "running change" scope: this PR's new fields plus the existing
 * fields it touched. Three-dot (merge-base) matches how sf-validate.yml
 * computes deltas. Throws on git failure (e.g. a shallow clone missing the
 * base) so the CLI can exit 2.
 */
export function gitChangedFiles({ workspace, baseRef }) {
  const r = spawnSync(
    "git",
    ["diff", "--name-status", "--no-renames", "--diff-filter=AM", `${baseRef}...HEAD`],
    { cwd: workspace, encoding: "utf8" },
  );
  if (r.status !== 0) {
    const msg = (r.stderr || r.error?.message || "unknown error").trim();
    throw new Error(`git diff against '${baseRef}' failed (shallow history?): ${msg}`);
  }
  return parseNameStatus(r.stdout);
}

/** Parse `git diff --name-status` output into `{path, change}` records. */
export function parseNameStatus(stdout) {
  const out = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split("\t");
    const file = rest.join("\t").trim();
    if (!file) continue;
    out.push({ path: file, change: status.startsWith("A") ? "added" : "modified" });
  }
  return out;
}

// --- path + XML parsing -----------------------------------------------------

/**
 * Classify a changed source path as a field metadata file, or null.
 * Only paths under `sourceDir` that match the sfdx source layout count.
 */
export function classifyPath(relPath, sourceDir) {
  const norm = relPath.split(path.sep).join("/");
  if (sourceDir && norm !== sourceDir && !norm.startsWith(sourceDir.replace(/\/+$/, "") + "/")) return null;
  const parts = norm.split("/");
  const oi = parts.indexOf("objects");
  if (oi === -1) return null;
  // **/objects/<Object>/fields/<Field>.field-meta.xml
  if (parts[oi + 2] === "fields" && parts[oi + 3]?.endsWith(".field-meta.xml") && parts.length === oi + 4) {
    return { object: parts[oi + 1], field: parts[oi + 3].replace(/\.field-meta\.xml$/, "") };
  }
  return null;
}

/** First `<tag>...</tag>` text content (trimmed) or null. */
function firstTag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i"));
  return m ? m[1].trim() : null;
}
/** Boolean `<tag>true</tag>` (case-insensitive). */
function boolTag(xml, name) {
  const v = firstTag(xml, name);
  return v != null && v.toLowerCase() === "true";
}

/**
 * Extract what the gate needs from a field metadata file. `fieldName` comes
 * from the filename (the authoritative API name). A `<formula>` element (not
 * `<formulaTreatBlanksAs>`) marks a formula field.
 *
 * `values` holds the raw text of every governable tag, so constraint checks can
 * inspect content rather than mere presence.
 */
export function parseFieldXml(xml, fieldName) {
  const type = firstTag(xml, "type");
  const values = {};
  for (const [key, def] of Object.entries(ATTRIBUTES)) {
    for (const t of def.tags) {
      const v = firstTag(xml, t);
      // First non-empty alternative wins (businessOwnerUser before ...Group).
      if (v !== null && v !== "" && values[key] === undefined) values[key] = { tag: t, value: v };
    }
  }
  return {
    type,
    isFormula: /<formula[\s>]/i.test(xml),
    isRequired: boolTag(xml, "required"),
    isMasterDetail: type === "MasterDetail",
    isAutoNumber: type === "AutoNumber",
    isSummary: type === "Summary",
    values,
    fieldName,
  };
}

function defaultRead(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Turn changed file records into parsed field objects, reading each metadata
 * file from the workspace (the HEAD working tree). Non-field paths are dropped.
 * @param {{changed: Array<{path: string, change: string}>, sourceDir: string, workspace: string}} args
 * @returns {Array<object>}
 */
export function classifyFields({ changed, sourceDir, workspace, readFile = defaultRead }) {
  const out = [];
  for (const rec of changed) {
    const c = classifyPath(rec.path, sourceDir);
    if (!c) continue;
    const xml = readFile(path.join(workspace, rec.path)) || "";
    out.push({
      object: c.object,
      field: c.field,
      apiName: `${c.object}.${c.field}`,
      path: rec.path,
      change: rec.change,
      ...parseFieldXml(xml, c.field),
    });
  }
  return out;
}

// --- bypass matching --------------------------------------------------------

/** Case-insensitive segment match with an optional trailing `*` wildcard. */
function segMatch(pattern, value) {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p.endsWith("*")) return v.startsWith(p.slice(0, -1));
  return p === v;
}

/** True when `Object.Field` is covered by any `Object.Field` pattern. */
export function fieldMatches(patterns, object, field) {
  for (const pat of patterns) {
    const dot = pat.indexOf(".");
    if (dot === -1) continue; // field patterns are Object.Field
    if (segMatch(pat.slice(0, dot), object) && segMatch(pat.slice(dot + 1), field)) return true;
  }
  return false;
}

/** True when an object name is covered by any object pattern. */
export function objectMatches(patterns, object) {
  return patterns.some((pat) => segMatch(pat, object));
}

// --- policy resolution ------------------------------------------------------

/**
 * Resolve the effective policy for one field by layering, most general first:
 *
 *   built-in defaults
 *     -> top-level `severity` / `require`          (repository level)
 *       -> objectTypes[<object kind>]              (custom / __mdt / __e / ...)
 *         -> the FIRST matching rule                (scoped by objects/fields)
 *           -> objectOverrides[<Object>]            (per object — the last word)
 *
 * A layer that omits `severity` or `require` inherits it; a layer that sets
 * `require` replaces the set wholesale (predictable, and `false` on a single
 * attribute is the escape hatch for dropping just one).
 *
 * @returns {{severity: string, require: object, rule: string|null, enabled: boolean, disabledBy: string|null}}
 */
export function effectivePolicy({ config, object, field }) {
  let severity = config.severity;
  let require = config.require;
  let ruleName = null;
  let disabledBy = null;

  const kind = objectKind(object);
  const typeLayer = config.objectTypes?.[kind];
  if (typeLayer) {
    if (typeLayer.enabled === false) disabledBy = `objectTypes.${kind}`;
    if (typeLayer.severity !== undefined) severity = typeLayer.severity;
    if (typeLayer.require !== undefined) require = typeLayer.require;
  }

  for (const rule of config.rules || []) {
    if (!ruleMatches(rule, object, field)) continue;
    ruleName = rule.name;
    if (rule.enabled === false) disabledBy = `rules.${rule.name}`;
    if (rule.severity !== undefined) severity = rule.severity;
    if (rule.require !== undefined) require = rule.require;
    break; // first match wins
  }

  const override = config.objectOverrides?.[object.toLowerCase()];
  if (override) {
    // An explicit per-object override is the last word in both directions: it
    // can re-enable an object family that objectTypes turned off.
    disabledBy = override.enabled === false ? `objectOverrides.${override.object}` : null;
    if (override.severity !== undefined) severity = override.severity;
    if (override.require !== undefined) require = override.require;
  }

  return { severity, require, rule: ruleName, enabled: disabledBy === null, disabledBy };
}

/**
 * Does a rule's scope cover this field? A rule with neither `objects` nor
 * `fields` is the catch-all (matches everything) — that is how a trailing
 * "default" rule is written.
 */
export function ruleMatches(rule, object, field) {
  const hasObjects = rule.objects && rule.objects.length > 0;
  const hasFields = rule.fields && rule.fields.length > 0;
  if (!hasObjects && !hasFields) return true;
  if (hasObjects && objectMatches(rule.objects, object)) return true;
  if (hasFields && fieldMatches(rule.fields, object, field)) return true;
  return false;
}

// --- attribute checking -----------------------------------------------------

/**
 * Check one required attribute against a parsed field.
 * @returns {{ok: true} | {ok: false, problem: string, actual: string}}
 */
export function checkAttribute(key, constraints, parsed) {
  const def = ATTRIBUTES[key];
  const present = parsed.values[key];
  const tagList = def.tags.map((t) => `<${t}>`).join(" or ");
  if (!present) {
    return { ok: false, problem: `missing ${def.label} (${tagList})`, actual: "not set" };
  }
  const value = present.value;
  if (constraints.minLength !== undefined && value.length < constraints.minLength) {
    return {
      ok: false,
      problem: `${def.label} is too short (needs >= ${constraints.minLength} characters)`,
      actual: `${value.length} characters`,
    };
  }
  if (constraints.allowed !== undefined) {
    const lower = constraints.allowed.map((s) => s.toLowerCase());
    if (!lower.includes(value.toLowerCase())) {
      return {
        ok: false,
        problem: `${def.label} must be one of: ${constraints.allowed.join(", ")}`,
        actual: value,
      };
    }
  }
  if (constraints.pattern !== undefined && !new RegExp(constraints.pattern).test(value)) {
    return { ok: false, problem: `${def.label} does not match /${constraints.pattern}/`, actual: value };
  }
  return { ok: true };
}

// --- audit ------------------------------------------------------------------

/**
 * Audit every changed field against its effective policy.
 *
 * Nothing here depends on the field's *type*: a check-only deploy against a
 * live org confirmed that formula, auto-number, required and master-detail
 * fields all accept every governance tag, so — unlike field-level security —
 * there is no type to carve out. Special types are recorded on the finding as
 * context only, which is what keeps them from erroring.
 *
 * @returns {{findings: Array<object>, skipped: Array<object>, bypassed: Array<object>, satisfied: number, audited: number}}
 */
export function audit({ config, fields }) {
  const findings = [];
  const skipped = [];
  const bypassed = [];
  let satisfied = 0;
  let audited = 0;

  const globalBypass = config.bypass || { objects: [], fields: [] };

  for (const f of fields) {
    const { object, field, apiName } = f;

    if (!config.includeStandardFields && !isCustomField(field)) {
      skipped.push({ component: apiName, file: f.path, reason: "standard field (set includeStandardFields to audit these)" });
      continue;
    }

    const policy = effectivePolicy({ config, object, field });
    if (!policy.enabled) {
      skipped.push({ component: apiName, file: f.path, reason: `disabled by ${policy.disabledBy}` });
      continue;
    }

    // Bypass = global list unioned with the matched rule's own list, so a rule
    // can widen the bypass for the fields it governs without touching others.
    const rule = (config.rules || []).find((r) => r.name === policy.rule);
    const rb = rule?.bypass || { objects: [], fields: [] };
    const bypassObjects = [...(globalBypass.objects || []), ...(rb.objects || [])];
    const bypassFields = [...(globalBypass.fields || []), ...(rb.fields || [])];

    if (objectMatches(bypassObjects, object)) {
      bypassed.push({ component: apiName, file: f.path, rule: policy.rule, reason: "object bypass" });
      continue;
    }
    if (fieldMatches(bypassFields, object, field)) {
      bypassed.push({ component: apiName, file: f.path, rule: policy.rule, reason: "field bypass" });
      continue;
    }

    audited++;
    const context = fieldTypeNote(f);
    for (const [key, constraints] of Object.entries(policy.require || {})) {
      const res = checkAttribute(key, constraints, f);
      if (res.ok) {
        satisfied++;
        continue;
      }
      findings.push({
        // Per-attribute severity wins over the layer's; omitted means inherit.
        severity: constraints.severity ?? policy.severity,
        rule: policy.rule,
        attribute: key,
        component: apiName,
        file: f.path,
        change: f.change,
        objectKind: objectKind(object),
        fieldType: f.type || "unknown",
        context,
        problem: res.problem,
        actual: res.actual,
        detail: `${apiName}${context ? ` (${context})` : ""} ${res.problem}`,
      });
    }
  }

  return { findings, skipped, bypassed, satisfied, audited };
}

/**
 * Human-readable note for field types worth calling out in a report. Purely
 * informational — these types are fully governable, and naming them stops a
 * reviewer from assuming the gate mishandled a formula or auto-number field.
 */
export function fieldTypeNote(f) {
  if (f.isFormula) return "formula field";
  if (f.isAutoNumber) return "auto-number field";
  if (f.isSummary) return "roll-up summary field";
  if (f.isMasterDetail) return "master-detail field";
  if (f.isRequired) return "required field";
  return null;
}

/** Exit code per the extension contract: error finding -> 1, warn -> 10, else 0. */
export function exitCodeForFindings(findings) {
  if (findings.some((f) => f.severity === "error")) return 1;
  if (findings.some((f) => f.severity === "warn")) return 10;
  return 0;
}

// --- reporting --------------------------------------------------------------

/**
 * Make a value safe to interpolate into a Markdown table cell.
 *
 * Component names and problems are derived from file paths and field metadata
 * in the PR — on a fork PR that is contributor-controlled text rendered into a
 * bot-authored comment, so it is escaped rather than trusted.
 *
 * Order matters: the backslash must be escaped BEFORE the pipe. Escaping only
 * the pipe leaves a trailing backslash in the input to pair with the one we add
 * ("\" + "|" -> "\\|"), which Markdown reads as an escaped backslash followed
 * by a live cell delimiter — the row breaks anyway.
 *
 * Newlines are collapsed because a raw one ends the table row: every finding
 * after it would silently vanish from the report. Angle brackets and ampersands
 * are neutralized so metadata cannot inject markup into the comment.
 */
function mdCell(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;");
}

/**
 * Make a value safe inside a `code span`. Backslash escapes do not apply there,
 * so a backtick cannot be escaped — only removed, or it closes the span early.
 */
function mdCode(value) {
  return String(value).replace(/`/g, "").replace(/[\r\n\t]+/g, " ");
}

/** Markdown for GITHUB_STEP_SUMMARY: findings table plus a short tally. */
export function buildStepSummary({ findings, skipped, bypassed, satisfied, audited }) {
  let md = "### field-governance-gate\n\n";
  if (findings.length === 0) {
    md += "Every new and modified field in this diff carries the required governance metadata.\n\n";
  } else {
    md += "| Severity | Rule | Field | Requirement | Found |\n|---|---|---|---|---|\n";
    for (const f of findings) {
      md += `| ${mdCell(f.severity)} | ${mdCell(f.rule || "-")} | ${mdCell(f.component)} | ${mdCell(f.problem)} | ${mdCell(f.actual)} |\n`;
    }
    md += "\n";
  }
  md += `Tally: **${findings.length}** finding(s) across ${audited} audited field(s), ${satisfied} requirement(s) satisfied, ${skipped.length} skipped, ${bypassed.length} bypassed.\n`;
  return md;
}

/**
 * Sticky PR comment body. Leads with COMMENT_MARKER, then a table of ALL
 * findings, plus a collapsed section of skipped/bypassed fields. All-clear
 * variant when there are no findings.
 */
export function buildCommentBody({ findings, skipped, bypassed }) {
  let body = `${COMMENT_MARKER}\n### CairnCI field-governance-gate\n\n`;
  if (findings.length === 0) {
    body += "Every new and modified field in this diff carries the required governance metadata. ✅\n";
  } else {
    body += `Found **${findings.length}** governance gap(s):\n\n`;
    body += "| Severity | Rule | Field | Requirement | Found |\n|---|---|---|---|---|\n";
    for (const f of findings) {
      body += `| ${mdCell(f.severity)} | ${mdCell(f.rule || "-")} | ${mdCell(f.component)} | ${mdCell(f.problem)} | ${mdCell(f.actual)} |\n`;
    }
  }
  if (skipped.length || bypassed.length) {
    body += `\n<details><summary>Skipped / bypassed fields (${skipped.length + bypassed.length})</summary>\n\n`;
    for (const s of skipped) body += `- \`${mdCode(s.component)}\` — skipped: ${mdCell(s.reason)}\n`;
    for (const b of bypassed) body += `- \`${mdCode(b.component)}\` — bypassed: ${mdCell(b.reason)}\n`;
    body += "\n</details>\n";
  }
  return body;
}

/**
 * Create or update the sticky PR comment. PATCH an existing marker comment,
 * POST a new one when findings exist, and do nothing when all-clear with no
 * existing comment. Never throws: a failed API call is a notice, not a gate
 * failure. `apiBase` is fully driven by the caller (GITHUB_API_URL) so tests
 * can point it at a local server.
 */
export async function upsertStickyComment({ apiBase, repo, prNumber, token, body, hasFindings, logger = console, fetchImpl = fetch }) {
  const listUrl = `${apiBase}/repos/${repo}/issues/${prNumber}/comments?per_page=100`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "cairnci-field-governance-gate",
    "Content-Type": "application/json",
  };

  let existing = null;
  try {
    const res = await fetchImpl(listUrl, { headers });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) existing = list.find((c) => typeof c?.body === "string" && c.body.startsWith(COMMENT_MARKER)) || null;
    }
  } catch (e) {
    logger.log(`::notice::field-governance-gate: could not list PR comments (${e.message}); skipping comment.`);
    return { action: "skipped" };
  }

  // All-clear and nothing to update -> leave the PR alone.
  if (!existing && !hasFindings) return { action: "none" };

  try {
    if (existing) {
      const res = await fetchImpl(`${apiBase}/repos/${repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body }),
      });
      return { action: res.ok ? "patched" : "error" };
    }
    const res = await fetchImpl(`${apiBase}/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
    return { action: res.ok ? "posted" : "error" };
  } catch (e) {
    logger.log(`::notice::field-governance-gate: comment API call failed (${e.message}).`);
    return { action: "error" };
  }
}
