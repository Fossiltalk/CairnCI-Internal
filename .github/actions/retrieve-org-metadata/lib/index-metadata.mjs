// Phase 1: build a full inventory of every metadata component in an org.
//
// Pure of process concerns — no argv parsing, no process.exit, no annotations.
// retrieve.mjs owns all of that; this module owns the org conversation and the
// index it produces.
import fs from 'node:fs';
import { ensureDir, runPaths } from './paths.mjs';
import { mapWithConcurrency } from './sf-cli.mjs';
import { getListableTypes } from './describe.mjs';
import { hasFallback, fetchFullMemberList } from './tooling-fallback.mjs';

export const LISTMETADATA_TRUNCATION_LIMIT = 3000;

// Folder-based metadata types and the corresponding value of Folder.Type.
export const FOLDER_TYPE_MAP = {
  Report: 'Report',
  Dashboard: 'Dashboard',
  Document: 'Document',
  EmailTemplate: 'Email',
};

// The "Unfiled Public" folder is a pseudo-folder: listMetadata accepts it as a
// --folder value, but it has NO row in the Folder object, so folder discovery
// by SOQL alone never finds it and everything inside is silently missed.
//
// Org-verified against CairnCI_Production (API 67.0): the org had zero
// Folder rows of Type='Email' yet 42 EmailTemplates, all in unfiled$public —
// a 100% silent loss for that type — plus 37 Reports there on top of the 67
// real report folders. Dashboard and Document return an empty list for it
// rather than erroring, so probing it unconditionally is safe.
export const UNFILED_PUBLIC = 'unfiled$public';

/**
 * listMetadata can return the SAME fullName more than once.
 *
 * Org-verified against CairnCI_Production: `listMetadata CustomObject` returned
 * 814 rows for 813 distinct objects, with two byte-identical `Account` rows —
 * same fileName, same ids, same timestamps, nothing to tell them apart. Left
 * alone that duplicate propagates into package.xml as a repeated <members>
 * entry and inflates every count, so members are deduplicated by fullName,
 * keeping the first occurrence.
 */
export function dedupeMembers(members) {
  const seen = new Set();
  return members.filter((m) => {
    if (seen.has(m.fullName)) return false;
    seen.add(m.fullName);
    return true;
  });
}

/**
 * @param {object} options
 * @param {ReturnType<import('./sf-cli.mjs').createSfClient>} options.sf
 */
export async function runIndexPhase({
  sf,
  targetOrg,
  runDir,
  apiVersion: apiVersionArg,
  concurrency = 6,
  // Types to drop before listing. See skippableTypes() in unretrievable.mjs
  // for what earns a place here — the short version is "yields nothing".
  skipTypes,
  log = console.log,
  warn = console.warn,
} = {}) {
  if (!sf) throw new Error('sf client is required');
  if (!targetOrg) throw new Error('targetOrg is required');
  if (!runDir) throw new Error('runDir is required');

  const paths = runPaths(runDir);
  ensureDir(paths.indexDir);

  log(`[index] target org: ${targetOrg}`);
  log(`[index] run dir:    ${paths.runDir}`);

  const orgInfo = await sf.orgDisplay(targetOrg);
  const apiVersion = apiVersionArg ?? orgInfo.apiVersion;
  log(`[index] api version: ${apiVersion}`);

  const { listable: allListable, skipped } = await getListableTypes(sf, targetOrg, apiVersion);

  // Drop known-unretrievable types before a single listMetadata call. Only
  // types the org actually HAS are recorded as skipped, so the summary never
  // claims to have skipped something that was never there.
  const skipSet = skipTypes instanceof Set ? skipTypes : new Set(skipTypes ?? []);
  const listable = allListable.filter((t) => !skipSet.has(t.xmlName));
  const skippedTypes = allListable.filter((t) => skipSet.has(t.xmlName)).map((t) => t.xmlName);

  log(`[index] ${listable.length} directly-listable types, ${skipped.length} child-only types skipped`);
  if (skippedTypes.length > 0) {
    log(`[index] ${skippedTypes.length} known-unretrievable type(s) skipped before listing: ${skippedTypes.join(', ')}`);
  }

  const folderTypes = listable.filter((t) => FOLDER_TYPE_MAP[t.xmlName]);
  const plainTypes = listable.filter((t) => !FOLDER_TYPE_MAP[t.xmlName]);

  const foldersByType = {};
  if (folderTypes.length > 0) {
    const wantedTypeValues = folderTypes.map((t) => `'${FOLDER_TYPE_MAP[t.xmlName]}'`).join(', ');
    const folderRecords = await sf.query(
      targetOrg,
      `SELECT DeveloperName, Type FROM Folder WHERE Type IN (${wantedTypeValues})`,
    );
    for (const t of folderTypes) {
      const folderValue = FOLDER_TYPE_MAP[t.xmlName];
      const named = folderRecords
        .filter((f) => f.Type === folderValue)
        // Org-verified: some Folder rows carry a null DeveloperName (personal
        // folders do). A null would fall through the `if (folder)` guard in
        // sf-cli and silently become an UNFOLDERED listMetadata call for a
        // folder-based type — wasted at best, duplicating members at worst.
        .filter((f) => typeof f.DeveloperName === 'string' && f.DeveloperName !== '')
        .map((f) => f.DeveloperName);
      // Always probe unfiled$public — it is never in the Folder object.
      foldersByType[t.xmlName] = named.includes(UNFILED_PUBLIC) ? named : [...named, UNFILED_PUBLIC];
    }
    log(
      `[index] folders discovered: ${folderTypes
        .map((t) => `${t.xmlName}=${foldersByType[t.xmlName].length}`)
        .join(', ')} (each includes ${UNFILED_PUBLIC})`,
    );
  }

  const types = {};
  let completed = 0;
  const totalWork = plainTypes.length + folderTypes.reduce((sum, t) => sum + (foldersByType[t.xmlName]?.length || 0), 0);

  function logProgress(label) {
    completed++;
    if (completed % 25 === 0 || completed === totalWork) {
      log(`[index] progress: ${completed}/${totalWork} (${label})`);
    }
  }

  async function resolveType(xmlName, listFn) {
    let rows = await listFn();
    let truncated = false;
    let fallback = 'none';

    if (rows.length === LISTMETADATA_TRUNCATION_LIMIT) {
      truncated = true;
      if (hasFallback(xmlName)) {
        const members = await fetchFullMemberList(sf, targetOrg, xmlName);
        rows = members.map((fullName) => ({ fullName }));
        fallback = 'tooling';
      } else {
        fallback = 'unavailable';
      }
    }

    return { rows, truncated, fallback };
  }

  // Plain (non-folder) types. A type that fails to list is recorded with its
  // error rather than aborting the index — a listMetadata failure is one of the
  // two ways an org surfaces an unretrievable type (see unretrievable.mjs).
  await mapWithConcurrency(plainTypes, concurrency, async (t) => {
    try {
      const { rows, truncated, fallback } = await resolveType(t.xmlName, () =>
        sf.listMetadata(targetOrg, t.xmlName, { apiVersion }),
      );
      const members = dedupeMembers(
        rows.map((r) => ({ fullName: r.fullName, lastModifiedDate: r.lastModifiedDate ?? null })),
      );
      types[t.xmlName] = {
        count: members.length,
        truncated,
        fallback,
        members,
        ...(members.length !== rows.length ? { duplicatesDropped: rows.length - members.length } : {}),
      };
    } catch (err) {
      types[t.xmlName] = { count: 0, truncated: false, fallback: 'error', error: err.message, members: [] };
    }
    logProgress(t.xmlName);
  });

  // Folder-based types: one listMetadata call per folder, merged per type.
  for (const t of folderTypes) {
    const folders = foldersByType[t.xmlName] ?? [];
    const merged = [];
    const folderErrors = [];
    let anyTruncated = false;
    let fallbackUsed = 'none';

    await mapWithConcurrency(folders, concurrency, async (folderName) => {
      try {
        const { rows, truncated, fallback } = await resolveType(t.xmlName, () =>
          sf.listMetadata(targetOrg, t.xmlName, { folder: folderName, apiVersion }),
        );
        if (truncated) {
          anyTruncated = true;
          fallbackUsed = fallback === 'tooling' ? fallbackUsed : fallback;
        }
        merged.push(...rows.map((r) => ({ fullName: r.fullName, lastModifiedDate: r.lastModifiedDate ?? null })));
      } catch (err) {
        warn(`[index] WARN folder ${t.xmlName}/${folderName} failed: ${err.message}`);
        folderErrors.push({ folder: folderName, error: err.message });
      }
      logProgress(`${t.xmlName}/${folderName}`);
    });

    // Folder-based types merge results from many calls, so duplicates are even
    // more likely here than for a plain type.
    const mergedUnique = dedupeMembers(merged);
    types[t.xmlName] = {
      count: mergedUnique.length,
      truncated: anyTruncated,
      fallback: anyTruncated ? fallbackUsed || 'unavailable' : 'none',
      members: mergedUnique,
      ...(mergedUnique.length !== merged.length ? { duplicatesDropped: merged.length - mergedUnique.length } : {}),
      ...(folderErrors.length > 0 ? { folderErrors } : {}),
    };
  }

  const totalComponents = Object.values(types).reduce((sum, t) => sum + t.count, 0);
  const truncatedUnresolved = Object.entries(types)
    .filter(([, t]) => t.truncated && t.fallback === 'unavailable')
    .map(([xmlName]) => xmlName);
  const erroredTypes = Object.entries(types)
    .filter(([, t]) => t.fallback === 'error')
    .map(([xmlName, t]) => ({ type: xmlName, error: t.error }));

  const index = {
    runId: paths.runId,
    targetOrg,
    orgId: orgInfo.id,
    apiVersion,
    generatedAt: new Date().toISOString(),
    totalComponents,
    skippedChildTypes: skipped,
    skippedTypes,
    truncatedUnresolvedTypes: truncatedUnresolved,
    erroredTypes,
    types,
  };

  fs.writeFileSync(paths.indexFile, JSON.stringify(index, null, 2));
  fs.writeFileSync(paths.summaryFile, buildSummaryMarkdown(index));

  log(`[index] total components indexed: ${totalComponents}`);
  if (truncatedUnresolved.length > 0) {
    warn(
      `[index] WARNING: ${truncatedUnresolved.length} type(s) hit the 3,000-row cap with no Tooling fallback: ${truncatedUnresolved.join(', ')}`,
    );
  }
  if (erroredTypes.length > 0) {
    warn(`[index] WARNING: ${erroredTypes.length} type(s) could not be listed: ${erroredTypes.map((e) => e.type).join(', ')}`);
  }
  log(`[index] wrote ${paths.indexFile}`);
  log(`[index] wrote ${paths.summaryFile}`);

  return { paths, index };
}

export function buildSummaryMarkdown(index) {
  const rows = Object.entries(index.types)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([xmlName, t]) => {
      let flag = '';
      if (t.fallback === 'error') flag = ' **(LIST FAILED)**';
      else if (t.truncated) flag = t.fallback === 'tooling' ? ' (recovered via Tooling API)' : ' **(TRUNCATED, unresolved)**';
      return `| ${xmlName} | ${t.count}${flag} |`;
    })
    .join('\n');

  return `# Metadata index summary

- Org: ${index.targetOrg} (${index.orgId})
- API version: ${index.apiVersion}
- Generated: ${index.generatedAt}
- Total components: **${index.totalComponents}**
- Child-only types skipped (retrieved with their parent): ${index.skippedChildTypes.length}
${index.skippedTypes?.length > 0 ? `- Known-unretrievable types skipped before listing: ${index.skippedTypes.join(', ')}\n` : ''}${index.truncatedUnresolvedTypes.length > 0 ? `- **Unresolved truncated types (hit 3,000-row cap, no Tooling fallback): ${index.truncatedUnresolvedTypes.join(', ')}**\n` : ''}
## Components per type

| Type | Count |
|---|---|
${rows}
`;
}
