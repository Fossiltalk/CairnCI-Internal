// Classifies retrieval failures so the run can tell a user "this is expected"
// apart from "this might be your permissions, or an undocumented API gap".
//
// Neither outcome aborts the run — retrieve-metadata.mjs already isolates
// failures per chunk. This module only decides how a failure is EXPLAINED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KNOWN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'known-unretrievable.json');

export const UNKNOWN_GUIDANCE =
  'This is either a missing permission for the user the job authenticated as, or an undocumented Metadata API ' +
  'incompatibility. Check the running user\'s permissions first (the Metadata API only returns what that user can see); ' +
  'if the permissions are right, treat the type as unretrievable and add it to known-unretrievable.json with a source.';

/**
 * Loads the tracked reference data. Missing or malformed file is not fatal:
 * every failure then classifies as unknown, which is a worse message but
 * never a broken run.
 */
export function loadKnownUnretrievable(file = KNOWN_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      types: parsed.types ?? {},
      categories: parsed.categories ?? {},
      canonicalDocs: parsed.canonicalDocs ?? {},
    };
  } catch {
    return { types: {}, categories: {}, canonicalDocs: {} };
  }
}

/**
 * Classify one failed metadata type.
 *
 * @param {string} type       metadata xmlName, e.g. "StandardValueSet"
 * @param {string} [error]    the raw CLI/API error, if there was one
 * @param {object} [known]    result of loadKnownUnretrievable()
 * @returns {{type: string, known: boolean, category: string, reason: string,
 *            workaround: string, source: string|null, error: string|null}}
 */
export function classifyFailure(type, error, known = loadKnownUnretrievable()) {
  const entry = known.types?.[type];

  if (entry) {
    return {
      type,
      known: true,
      category: entry.category,
      reason: entry.reason,
      workaround: entry.workaround,
      source: entry.source ?? null,
      error: error ?? null,
    };
  }

  return {
    type,
    known: false,
    category: 'unknown',
    reason: 'Visible to the CLI but could not be retrieved, and it is not in known-unretrievable.json.',
    workaround: UNKNOWN_GUIDANCE,
    source: null,
    error: error ?? null,
  };
}

/**
 * Types to drop BEFORE the index lists them, so they never reach a manifest.
 *
 * Only entries flagged `skipBeforeRetrieval` qualify, and the flag means "this
 * type yields nothing": listMetadata returns no rows, or the CLI's local
 * registry rejects it and takes the whole chunk down. Entries describing a
 * PARTIAL limitation (Report's personal folders, ConnectedApp's redacted
 * secret, CustomMetadata's under-count) are deliberately not skippable —
 * they retrieve real components, and skipping them would lose data to save
 * time, which is the wrong trade for a backup tool.
 *
 * Skipping is a runtime optimisation with a real payoff on the registry gaps:
 * the CLI validates a manifest against its bundled registry before it contacts
 * the org, so an unknown type does not fail alone, it fails every member of
 * whatever chunk it lands in. Org-verified against CairnCI_Production: two PSS
 * types forced two full retries of a 4,983-member chunk.
 */
export function skippableTypes(known = loadKnownUnretrievable()) {
  return new Set(
    Object.entries(known.types ?? {})
      .filter(([, entry]) => entry.skipBeforeRetrieval === true)
      .map(([type]) => type),
  );
}

/**
 * Collect every unretrievable finding for a run, from all three places a type
 * can drop out: skipped up front as known-unretrievable, refused by
 * listMetadata during the index, or excluded from a chunk (or its chunk failed
 * outright) during the retrieve.
 */
export function collectFindings({ index, report, known = loadKnownUnretrievable() } = {}) {
  const byType = new Map();

  const add = (type, error) => {
    if (!byType.has(type)) byType.set(type, classifyFailure(type, error, known));
  };

  // Skipped types are still reported. Filtering them out of the run must not
  // filter them out of the summary — "we did not attempt this, and here is
  // why" is exactly what the user needs to see.
  for (const type of index?.skippedTypes ?? []) {
    add(type, known.types?.[type]?.skipReason ?? 'Skipped before retrieval as a known-unretrievable type.');
  }
  for (const { type, error } of index?.erroredTypes ?? []) add(type, error);
  for (const type of index?.truncatedUnresolvedTypes ?? []) {
    add(type, 'listMetadata truncated at 3,000 rows with no Tooling API fallback registered for this type.');
  }
  for (const chunk of report?.chunks ?? []) {
    for (const type of chunk.excludedTypes ?? []) {
      add(type, `Excluded from ${chunk.file}: unsupported by the installed sf CLI's metadata registry.`);
    }
  }

  const findings = [...byType.values()];
  return {
    findings,
    knownCount: findings.filter((f) => f.known).length,
    unknownCount: findings.filter((f) => !f.known).length,
    // Chunks that failed as a whole are reported separately: the cause is a
    // chunk-level error (timeout, session, org-side), not a specific type.
    failedChunks: (report?.chunks ?? []).filter((c) => c.status === 'failed'),
  };
}

/** Renders the findings as the job-summary section. */
export function buildUnretrievableSummary({ findings, failedChunks }, canonicalDocs = {}) {
  if (findings.length === 0 && failedChunks.length === 0) {
    return '### Unretrievable metadata\n\nNone — every indexed type was attempted and retrieved.\n';
  }

  const lines = ['### Unretrievable metadata', ''];

  const knownFindings = findings.filter((f) => f.known);
  const unknownFindings = findings.filter((f) => !f.known);

  if (knownFindings.length > 0) {
    lines.push(
      `#### Expected (${knownFindings.length}) — documented Metadata API limitations`,
      '',
      'These are known not to be retrievable. No action needed unless the workaround matters to you.',
      '',
      '| Type | Why | What you can do |',
      '|---|---|---|',
    );
    for (const f of knownFindings) {
      const why = f.source ? `${f.reason} ([source](${f.source}))` : f.reason;
      lines.push(`| \`${f.type}\` | ${cell(why)} | ${cell(f.workaround)} |`);
    }
    lines.push('');
  }

  if (unknownFindings.length > 0) {
    lines.push(
      `#### Unexplained (${unknownFindings.length}) — permissions, or an undocumented gap`,
      '',
      UNKNOWN_GUIDANCE,
      '',
      '| Type | Error |',
      '|---|---|',
    );
    for (const f of unknownFindings) {
      lines.push(`| \`${f.type}\` | ${cell(f.error ?? 'no error text captured')} |`);
    }
    lines.push('');
  }

  if (failedChunks.length > 0) {
    lines.push(
      `#### Failed chunks (${failedChunks.length})`,
      '',
      'A whole retrieve request failed. This is usually a timeout or a transient org-side error rather than a ' +
        'type limitation — re-run the action to retry just these.',
      '',
      '| Chunk | Error |',
      '|---|---|',
    );
    for (const c of failedChunks) {
      lines.push(`| \`${c.file}\` | ${cell(c.error ?? 'unknown')} |`);
    }
    lines.push('');
  }

  if (canonicalDocs.unsupportedMetadataTypes) {
    lines.push(
      `Salesforce's own list of features whose metadata is unavailable API-wide: ${canonicalDocs.unsupportedMetadataTypes}`,
      '',
    );
  }

  return lines.join('\n');
}

/**
 * Escape a value for a Markdown table cell. Mirrors `mdCell` in
 * field-governance-gate and permset-access-gate — same problem, same fix.
 *
 * The text here is a Salesforce CLI error message, i.e. org-controlled rather
 * than ours, so it is escaped rather than trusted.
 *
 * Order matters: the backslash must be escaped BEFORE the pipe. Escaping only
 * the pipe leaves a trailing backslash in the input to pair with the one we add
 * ("\" + "|" -> "\\|"), which Markdown reads as an escaped backslash followed
 * by a live cell delimiter — the row breaks anyway.
 *
 * Whitespace is collapsed with a single `\s+`, not `\s*\n\s*`: `\s` matches `\n`
 * too, so that pattern's quantifiers overlap and it backtracks polynomially on a
 * long whitespace run (CodeQL js/polynomial-redos). One `\s+` is unambiguous and
 * linear. A raw newline would also end the table row, hiding every subsequent
 * finding — and CLI errors are wrapped multi-line text, so runs are collapsed
 * rather than merely replaced (the sibling gates use `[\r\n\t]+`; they format
 * short field names, not wrapped error output). Angle brackets and ampersands
 * are neutralized so an error string cannot inject markup into the job summary.
 */
function cell(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .trim();
}
