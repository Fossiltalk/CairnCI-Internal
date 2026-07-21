// permset-access-gate — pure logic for the CairnCI extension that gates a PR
// on whether the repo's permission sets grant a configured minimum access to
// every newly created Salesforce field and object.
//
// This module is deliberately side-effect-free: no process.exit, no network at
// import time, and every function is directly unit-testable. The CLI
// (gate.mjs) wires arguments, env, git, annotations, the step summary and the
// sticky PR comment around it.
//
// Zero runtime dependencies: node: builtins only, so the same code runs inside
// the composite action and under `node --test`. The Salesforce metadata files
// are small, single-purpose XML, so lightweight regex extraction is used
// instead of a full XML parser (no deps allowed).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export class ConfigError extends Error {}

// Object-access requirement -> the <objectPermissions> flag it maps to.
export const OBJECT_ACCESS_TO_PERM = {
  read: "allowRead",
  create: "allowCreate",
  edit: "allowEdit",
  delete: "allowDelete",
  viewAll: "viewAllRecords",
  modifyAll: "modifyAllRecords",
};
export const OBJECT_ACCESS_FLAGS = Object.keys(OBJECT_ACCESS_TO_PERM);

export const COMMENT_MARKER = "<!-- cairnci:permset-access-gate -->";

// --- config -----------------------------------------------------------------

/**
 * Load and validate the gate config. Returns null when the file does not exist
 * (the gate is opt-in, same philosophy as the extension caller); throws
 * ConfigError on any invalid content.
 * @param {string} configFile absolute path to the config JSON
 * @returns {ReturnType<typeof validateConfig>|null}
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

/**
 * Validate raw parsed config and return a normalized shape with defaults
 * applied. Throws ConfigError on any violation. Unknown top-level keys (e.g.
 * "$comment") are ignored.
 */
export function validateConfig(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config must be a JSON object");
  }
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new ConfigError("`rules` must be a non-empty array");
  }
  const bypass = normalizeBypass(raw.bypass, "bypass");
  const seen = new Set();
  const rules = raw.rules.map((r, i) => {
    const where = `rules[${i}]`;
    if (typeof r !== "object" || r === null || Array.isArray(r)) throw new ConfigError(`${where} must be an object`);
    if (typeof r.permissionSet !== "string" || r.permissionSet.trim() === "") {
      throw new ConfigError(`${where}.permissionSet must be a non-empty string`);
    }
    const key = r.permissionSet.toLowerCase();
    if (seen.has(key)) throw new ConfigError(`duplicate permissionSet "${r.permissionSet}"`);
    seen.add(key);

    const severity = r.severity === undefined ? "error" : r.severity;
    if (severity !== "error" && severity !== "warn") {
      throw new ConfigError(`${where}.severity must be "error" or "warn"`);
    }
    const fieldAccess = r.fieldAccess === undefined ? "read" : r.fieldAccess;
    if (fieldAccess !== "read" && fieldAccess !== "edit") {
      throw new ConfigError(`${where}.fieldAccess must be "read" or "edit"`);
    }
    const objectAccess = r.objectAccess === undefined ? ["read"] : r.objectAccess;
    if (!Array.isArray(objectAccess) || objectAccess.length === 0) {
      throw new ConfigError(`${where}.objectAccess must be a non-empty array`);
    }
    for (const a of objectAccess) {
      if (!OBJECT_ACCESS_FLAGS.includes(a)) {
        throw new ConfigError(`${where}.objectAccess has unknown value "${a}" (valid: ${OBJECT_ACCESS_FLAGS.join(", ")})`);
      }
    }
    return {
      permissionSet: r.permissionSet,
      severity,
      fieldAccess,
      objectAccess,
      bypass: normalizeBypass(r.bypass, `${where}.bypass`),
    };
  });
  return { bypass, rules };
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
 * Added (A) file paths between the merge-base of `baseRef` and HEAD. Three-dot
 * (merge-base) matches how sf-validate.yml computes deltas. Throws on git
 * failure (e.g. a shallow clone missing the base) so the CLI can exit 2.
 * @returns {string[]}
 */
export function gitAddedFiles({ workspace, baseRef }) {
  const r = spawnSync(
    "git",
    ["diff", "--name-only", "--no-renames", "--diff-filter=A", `${baseRef}...HEAD`],
    { cwd: workspace, encoding: "utf8" },
  );
  if (r.status !== 0) {
    const msg = (r.stderr || r.error?.message || "unknown error").trim();
    throw new Error(`git diff against '${baseRef}' failed (shallow history?): ${msg}`);
  }
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// --- path + XML parsing -----------------------------------------------------

/** Trailing-`__x` suffix of an API name (e.g. "__c", "__mdt"), lowercased. */
export function objectSuffix(name) {
  const m = name.match(/(__[a-z]+)$/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Classify an added source path as a new field, a new object, or neither.
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
    return { kind: "field", object: parts[oi + 1], field: parts[oi + 3].replace(/\.field-meta\.xml$/, "") };
  }
  // **/objects/<Object>/<Object>.object-meta.xml
  if (parts[oi + 2]?.endsWith(".object-meta.xml") && parts.length === oi + 3) {
    return { kind: "object", object: parts[oi + 1] };
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
/** All inner texts of repeated `<tag>...</tag>` blocks. */
function allBlocks(xml, name) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/**
 * Extract the field attributes the gate cares about. `fieldName` comes from the
 * filename (authoritative API name). A `<formula>` element (not
 * `<formulaTreatBlanksAs>`) marks a formula field.
 */
export function parseFieldXml(xml, fieldName) {
  const type = firstTag(xml, "type");
  return {
    type,
    isFormula: /<formula[\s>]/i.test(xml),
    isRequired: boolTag(xml, "required"),
    isMasterDetail: type === "MasterDetail",
    isAutoNumber: type === "AutoNumber",
    isSummary: type === "Summary",
    // The master object of a master-detail field. Salesforce refuses to deploy
    // object permissions on a detail object unless the same permission set
    // also grants Read on its master, so the gate needs the master's name.
    referenceTo: firstTag(xml, "referenceTo"),
    fieldName,
  };
}

/** Object-meta attributes: master-detail children set sharingModel ControlledByParent. */
export function parseObjectXml(xml) {
  return { controlledByParent: (firstTag(xml, "sharingModel") || "").toLowerCase() === "controlledbyparent" };
}

/** Parse a permission set's field/object permission entries into lookup Maps. */
export function parsePermissionSet(xml) {
  const fieldPermissions = new Map();
  for (const block of allBlocks(xml, "fieldPermissions")) {
    const field = firstTag(block, "field");
    if (field) fieldPermissions.set(field.toLowerCase(), { readable: boolTag(block, "readable"), editable: boolTag(block, "editable") });
  }
  const objectPermissions = new Map();
  for (const block of allBlocks(xml, "objectPermissions")) {
    const object = firstTag(block, "object");
    if (object) {
      objectPermissions.set(object.toLowerCase(), {
        allowRead: boolTag(block, "allowRead"),
        allowCreate: boolTag(block, "allowCreate"),
        allowEdit: boolTag(block, "allowEdit"),
        allowDelete: boolTag(block, "allowDelete"),
        viewAllRecords: boolTag(block, "viewAllRecords"),
        modifyAllRecords: boolTag(block, "modifyAllRecords"),
      });
    }
  }
  return { fieldPermissions, objectPermissions };
}

// --- classification ---------------------------------------------------------

/**
 * Turn added file paths into structured new fields/objects, reading and parsing
 * each metadata file from the workspace (HEAD working tree). An object is a
 * master-detail child when any of its added field files is MasterDetail OR its
 * object-meta declares sharingModel ControlledByParent.
 * @returns {{fields: Array<object>, objects: Array<object>}}
 */
export function classifyComponents({ addedFiles, sourceDir, workspace, readFile = defaultRead }) {
  const fieldsRaw = [];
  const objectPaths = new Map();
  for (const rel of addedFiles) {
    const c = classifyPath(rel, sourceDir);
    if (!c) continue;
    if (c.kind === "field") fieldsRaw.push({ object: c.object, field: c.field, path: rel });
    else objectPaths.set(c.object, rel);
  }

  const fields = fieldsRaw.map((f) => {
    const xml = readFile(path.join(workspace, f.path)) || "";
    return { ...f, apiName: `${f.object}.${f.field}`, ...parseFieldXml(xml, f.field) };
  });

  // An added MasterDetail field both marks its object as a detail object and
  // names the master, which the permission-dependency check needs.
  const mdByField = new Set();
  const masterByObject = new Map();
  for (const f of fields) {
    if (!f.isMasterDetail) continue;
    mdByField.add(f.object.toLowerCase());
    if (f.referenceTo && !masterByObject.has(f.object.toLowerCase())) {
      masterByObject.set(f.object.toLowerCase(), f.referenceTo);
    }
  }

  const objects = [...objectPaths.entries()].map(([name, p]) => {
    const xml = readFile(path.join(workspace, p)) || "";
    const parsed = parseObjectXml(xml);
    return {
      name,
      apiName: name,
      path: p,
      isMasterDetailChild: mdByField.has(name.toLowerCase()) || parsed.controlledByParent,
      // null when the object is ControlledByParent but the master-detail field
      // itself was not added in this diff — the master is then unknown and the
      // dependency cannot be checked.
      masterObject: masterByObject.get(name.toLowerCase()) || null,
    };
  });

  return { fields, objects };
}

function defaultRead(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Walk `<sourceDir>/**​/permissionsets/*.permissionset-meta.xml` at HEAD (the
 * working tree, so PR-introduced permset changes count) into a Map keyed by
 * lowercased API name (Salesforce API names are case-insensitive).
 */
export function findPermissionSets({ workspace, sourceDir, readdir = fs.readdirSync, readFile = defaultRead }) {
  const map = new Map();
  const root = path.join(workspace, sourceDir);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith(".permissionset-meta.xml") && path.basename(dir) === "permissionsets") {
        const name = e.name.replace(/\.permissionset-meta\.xml$/, "");
        map.set(name.toLowerCase(), { name, path: full, ...parsePermissionSet(readFile(full) || "") });
      }
    }
  }
  return map;
}

// --- bypass matching --------------------------------------------------------

/** Case-insensitive segment match with an optional trailing `*` wildcard. */
function segMatch(pattern, value) {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p.endsWith("*")) return v.startsWith(p.slice(0, -1));
  return p === v;
}

/** True when `Object.Field` is covered by any `Object.Field` bypass pattern. */
export function fieldBypassed(patterns, object, field) {
  for (const pat of patterns) {
    const dot = pat.indexOf(".");
    if (dot === -1) continue; // field patterns are Object.Field
    if (segMatch(pat.slice(0, dot), object) && segMatch(pat.slice(dot + 1), field)) return true;
  }
  return false;
}

/** True when an object name is covered by any object bypass pattern. */
export function objectBypassed(patterns, object) {
  return patterns.some((pat) => segMatch(pat, object));
}

// --- exemptions -------------------------------------------------------------

/** Reason a field is exempt from field-level security entirely, or null. */
export function fieldExemption(f) {
  const suf = objectSuffix(f.object);
  if (suf && ["__mdt", "__e", "__b"].includes(suf)) {
    return `on ${f.object} — ${suf} objects have no field-level security`;
  }
  if (f.field === "Id" || !f.field.endsWith("__c")) return "standard field (not created by this PR)";
  if (f.isMasterDetail) return "master-detail field (implicitly required; deploy fails with \"cannot deploy to a required field\")";
  if (f.isRequired) return "required field (cannot have FieldPermissions rows)";
  return null;
}

/**
 * Reason a field is read-only by nature, or null. These fields do carry FLS,
 * and a deploy will not reject `editable`, but Salesforce can never honor it —
 * so requiring `edit` on one would demand a permission the org cannot hold.
 */
export function fieldReadOnlyReason(f) {
  if (f.isFormula) return "formula field";
  if (f.isAutoNumber) return "auto-number field";
  if (f.isSummary) return "roll-up summary field";
  return null;
}

/** Reason an object is exempt from object CRUD checks (non-`__c`), or null. */
export function objectExemption(o) {
  const suf = objectSuffix(o.name);
  if (suf === "__c") return null;
  const label =
    { __mdt: "custom metadata type", __e: "platform event", __b: "big object" }[suf] || "standard object";
  return `${label} (no permission-set object CRUD)`;
}

// --- audit ------------------------------------------------------------------

/**
 * Audit the classified new components against every rule. Findings are per
 * (rule, component); exemptions are nature-based and recorded once; bypasses
 * are per-rule because per-rule bypass unions with the global bypass.
 *
 * Finding types: "field", "object", "master-dependency" (a detail object's
 * master is missing Read in the same permission set) and "permset".
 *
 * @returns {{findings: Array<object>, exempt: Array<object>, bypassed: Array<object>, satisfied: number}}
 */
export function audit({ config, classified, permsets }) {
  const { fields, objects } = classified;
  const findings = [];
  const exempt = [];
  const bypassed = [];
  let satisfied = 0;

  // Nothing new in the diff -> nothing to gate. Skipping the rule loop here
  // keeps a misconfigured rule (e.g. a permset renamed out of source) from
  // failing every unrelated PR; the missing-permset finding only fires when
  // there are actually new components to audit.
  if (fields.length === 0 && objects.length === 0) {
    return { findings, exempt, bypassed, satisfied };
  }

  // Nature-based exemptions — independent of any rule, recorded once.
  for (const f of fields) {
    const reason = fieldExemption(f);
    if (reason) exempt.push({ component: f.apiName, type: "field", reason });
  }
  for (const o of objects) {
    const reason = objectExemption(o);
    if (reason) exempt.push({ component: o.name, type: "object", reason });
  }

  const g = config.bypass || { objects: [], fields: [] };

  for (const rule of config.rules) {
    const rb = rule.bypass || { objects: [], fields: [] };
    const bypassObjects = [...(g.objects || []), ...(rb.objects || [])];
    const bypassFields = [...(g.fields || []), ...(rb.fields || [])];

    const ps = permsets.get(rule.permissionSet.toLowerCase());
    if (!ps) {
      findings.push({
        permissionSet: rule.permissionSet,
        severity: rule.severity,
        type: "permset",
        component: rule.permissionSet,
        required: "present in source",
        actual: "not found",
        detail: "permission set not found in source",
      });
      continue;
    }

    for (const f of fields) {
      if (fieldExemption(f)) continue;
      if (fieldBypassed(bypassFields, f.object, f.field)) {
        bypassed.push({ permissionSet: rule.permissionSet, component: f.apiName, type: "field", reason: "field bypass" });
        continue;
      }
      let access = rule.fieldAccess;
      let note = "";
      const ro = fieldReadOnlyReason(f);
      if (access === "edit" && ro) {
        access = "read";
        note = ` (edit requested, ${ro} — read required)`;
      }
      const perm = ps.fieldPermissions.get(f.apiName.toLowerCase());
      let ok;
      let actual;
      if (!perm) {
        ok = false;
        actual = "no FieldPermissions entry";
      } else if (access === "read") {
        ok = perm.readable === true;
        actual = `readable=${perm.readable}`;
      } else {
        ok = perm.readable === true && perm.editable === true;
        actual = `readable=${perm.readable}, editable=${perm.editable}`;
      }
      if (ok) {
        satisfied++;
        continue;
      }
      findings.push({
        permissionSet: rule.permissionSet,
        severity: rule.severity,
        type: "field",
        component: f.apiName,
        required: access + note,
        actual,
        detail: `field ${f.apiName} needs ${access} access${note}`,
      });
    }

    for (const o of objects) {
      if (objectExemption(o)) continue;
      if (objectBypassed(bypassObjects, o.name)) {
        bypassed.push({ permissionSet: rule.permissionSet, component: o.name, type: "object", reason: "object bypass" });
        continue;
      }
      // Detail objects take the full requirement, including View All / Modify
      // All: Salesforce accepts both on a master-detail child (verified against
      // a live org, and present on real detail objects in production permission
      // sets). Only the master-dependency below is special.
      const required = [...rule.objectAccess];
      const perm = ps.objectPermissions.get(o.name.toLowerCase());
      const missing = required.filter((a) => !(perm && perm[OBJECT_ACCESS_TO_PERM[a]] === true));
      if (missing.length === 0) {
        satisfied++;
      } else {
        findings.push({
          permissionSet: rule.permissionSet,
          severity: rule.severity,
          type: "object",
          component: o.name,
          required: required.join(","),
          actual: perm ? `missing: ${missing.join(",")}` : "no objectPermissions entry",
          detail: `object ${o.name} missing ${missing.join(",")}`,
        });
      }

      // Master-detail dependency: granting ANY object permission on a detail
      // object requires Read on its master in the same permission set, or the
      // permission set is rejected at deploy time with
      // "Permission Read <child> depends on permission(s): Read <master>".
      if (o.isMasterDetailChild && o.masterObject) {
        const masterPerm = ps.objectPermissions.get(o.masterObject.toLowerCase());
        if (!(masterPerm && masterPerm.allowRead === true)) {
          findings.push({
            permissionSet: rule.permissionSet,
            severity: rule.severity,
            type: "master-dependency",
            component: o.masterObject,
            required: "read (master of " + o.name + ")",
            actual: masterPerm ? "allowRead=false" : "no objectPermissions entry",
            detail: `master-detail: ${o.name} needs Read on its master ${o.masterObject} in this permission set, or the permission set will not deploy`,
          });
        }
      }
    }
  }

  return { findings, exempt, bypassed, satisfied };
}

/** Exit code per the extension contract: error finding -> 1, warn -> 10, else 0. */
export function exitCodeForFindings(findings) {
  if (findings.some((f) => f.severity === "error")) return 1;
  if (findings.some((f) => f.severity === "warn")) return 10;
  return 0;
}

// --- reporting --------------------------------------------------------------

function escapePipe(s) {
  return String(s).replace(/\|/g, "\\|");
}

/** Markdown for GITHUB_STEP_SUMMARY: findings table plus a short tally. */
export function buildStepSummary({ findings, exempt, bypassed, satisfied }) {
  let md = "### permset-access-gate\n\n";
  if (findings.length === 0) {
    md += "No permission-set access gaps found for the new fields/objects in this diff.\n\n";
  } else {
    md += "| Permission Set | Severity | Type | Component | Required | Found |\n|---|---|---|---|---|---|\n";
    for (const f of findings) {
      md += `| ${f.permissionSet} | ${f.severity} | ${f.type} | ${f.component} | ${escapePipe(f.required)} | ${escapePipe(f.actual)} |\n`;
    }
    md += "\n";
  }
  md += `Tally: **${findings.length}** finding(s), ${satisfied} satisfied, ${exempt.length} exempt, ${bypassed.length} bypassed.\n`;
  return md;
}

/**
 * Sticky PR comment body. Leads with COMMENT_MARKER, then a table of ALL
 * findings (so the overview surfaces every missing permission), plus a
 * collapsed section of exempt/bypassed components. All-clear variant when
 * there are no findings.
 */
export function buildCommentBody({ findings, exempt, bypassed }) {
  let body = `${COMMENT_MARKER}\n### CairnCI permset-access-gate\n\n`;
  if (findings.length === 0) {
    body += "All newly added fields and objects are covered by the configured permission sets. ✅\n";
  } else {
    body += `Found **${findings.length}** permission-set access gap(s):\n\n`;
    body += "| Permission Set | Severity | Component | Required | Found |\n|---|---|---|---|---|\n";
    for (const f of findings) {
      body += `| ${f.permissionSet} | ${f.severity} | ${f.component} | ${escapePipe(f.required)} | ${escapePipe(f.actual)} |\n`;
    }
  }
  if (exempt.length || bypassed.length) {
    body += `\n<details><summary>Exempt / bypassed components (${exempt.length + bypassed.length})</summary>\n\n`;
    for (const e of exempt) body += `- \`${e.component}\` (${e.type}) — exempt: ${e.reason}\n`;
    for (const b of bypassed) body += `- \`${b.component}\` (${b.type}) — bypassed for ${b.permissionSet}: ${b.reason}\n`;
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
    "User-Agent": "cairnci-permset-access-gate",
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
    logger.log(`::notice::permset-access-gate: could not list PR comments (${e.message}); skipping comment.`);
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
    logger.log(`::notice::permset-access-gate: comment API call failed (${e.message}).`);
    return { action: "error" };
  }
}
