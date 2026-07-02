#!/usr/bin/env node
// Phase 1: build a full inventory of every metadata component in an org.
//
// Usage:
//   node index-metadata.mjs [--target-org CairnCI-Main] [--run-dir <path>]
//                            [--api-version 61.0] [--concurrency 6]
import fs from 'node:fs';
import { parseArgs } from './lib/args.mjs';
import { ensureDir, newRunId, DEFAULT_OUT_ROOT, runPaths } from './lib/paths.mjs';
import { sfOrgDisplay, sfListMetadata, sfQuery, mapWithConcurrency } from './lib/sf-cli.mjs';
import { getListableTypes } from './lib/describe.mjs';
import { hasFallback, fetchFullMemberList } from './lib/tooling-fallback.mjs';

const LISTMETADATA_TRUNCATION_LIMIT = 3000;

// Folder-based metadata types and the corresponding value of Folder.Type.
const FOLDER_TYPE_MAP = {
  Report: 'Report',
  Dashboard: 'Dashboard',
  Document: 'Document',
  EmailTemplate: 'Email',
};

export async function runIndexPhase({ targetOrg, runDir, apiVersion: apiVersionArg, concurrency = 6 } = {}) {
  if (!targetOrg) throw new Error('targetOrg is required');

  const paths = runPaths(runDir ?? `${DEFAULT_OUT_ROOT}/${newRunId()}`);
  ensureDir(paths.indexDir);

  console.log(`[index] target org: ${targetOrg}`);
  console.log(`[index] run dir:    ${paths.runDir}`);

  const orgInfo = await sfOrgDisplay(targetOrg);
  const apiVersion = apiVersionArg ?? orgInfo.apiVersion;
  console.log(`[index] api version: ${apiVersion}`);

  const { listable, skipped } = await getListableTypes(targetOrg, apiVersion);
  console.log(`[index] ${listable.length} directly-listable types, ${skipped.length} child-only types skipped`);

  const folderTypes = listable.filter((t) => FOLDER_TYPE_MAP[t.xmlName]);
  const plainTypes = listable.filter((t) => !FOLDER_TYPE_MAP[t.xmlName]);

  const foldersByType = {};
  if (folderTypes.length > 0) {
    const wantedTypeValues = folderTypes.map((t) => `'${FOLDER_TYPE_MAP[t.xmlName]}'`).join(', ');
    const folderRecords = await sfQuery(
      targetOrg,
      `SELECT DeveloperName, Type FROM Folder WHERE Type IN (${wantedTypeValues})`,
    );
    for (const t of folderTypes) {
      const folderValue = FOLDER_TYPE_MAP[t.xmlName];
      foldersByType[t.xmlName] = folderRecords
        .filter((f) => f.Type === folderValue)
        .map((f) => f.DeveloperName);
    }
    console.log(
      `[index] folders discovered: ${folderTypes.map((t) => `${t.xmlName}=${foldersByType[t.xmlName].length}`).join(', ')}`,
    );
  }

  const types = {};
  let completed = 0;
  const totalWork = plainTypes.length + folderTypes.reduce((sum, t) => sum + (foldersByType[t.xmlName]?.length || 0), 0);

  function logProgress(label) {
    completed++;
    if (completed % 25 === 0 || completed === totalWork) {
      console.log(`[index] progress: ${completed}/${totalWork} (${label})`);
    }
  }

  async function resolveType(xmlName, listFn) {
    let rows = await listFn();
    let truncated = false;
    let fallback = 'none';

    if (rows.length === LISTMETADATA_TRUNCATION_LIMIT) {
      truncated = true;
      if (hasFallback(xmlName)) {
        const members = await fetchFullMemberList(targetOrg, xmlName);
        rows = members.map((fullName) => ({ fullName }));
        fallback = 'tooling';
      } else {
        fallback = 'unavailable';
      }
    }

    return { rows, truncated, fallback };
  }

  // Plain (non-folder) types.
  await mapWithConcurrency(plainTypes, concurrency, async (t) => {
    try {
      const { rows, truncated, fallback } = await resolveType(t.xmlName, () => sfListMetadata(targetOrg, t.xmlName, { apiVersion }));
      types[t.xmlName] = {
        count: rows.length,
        truncated,
        fallback,
        members: rows.map((r) => ({ fullName: r.fullName, lastModifiedDate: r.lastModifiedDate ?? null })),
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
    let anyTruncated = false;
    let fallbackUsed = 'none';

    await mapWithConcurrency(folders, concurrency, async (folderName) => {
      try {
        const { rows, truncated, fallback } = await resolveType(t.xmlName, () =>
          sfListMetadata(targetOrg, t.xmlName, { folder: folderName, apiVersion }),
        );
        if (truncated) {
          anyTruncated = true;
          fallbackUsed = fallback === 'tooling' ? fallbackUsed : fallback;
        }
        merged.push(...rows.map((r) => ({ fullName: r.fullName, lastModifiedDate: r.lastModifiedDate ?? null })));
      } catch (err) {
        console.warn(`[index] WARN folder ${t.xmlName}/${folderName} failed: ${err.message}`);
      }
      logProgress(`${t.xmlName}/${folderName}`);
    });

    types[t.xmlName] = {
      count: merged.length,
      truncated: anyTruncated,
      fallback: anyTruncated ? fallbackUsed || 'unavailable' : 'none',
      members: merged,
    };
  }

  const totalComponents = Object.values(types).reduce((sum, t) => sum + t.count, 0);
  const truncatedUnresolved = Object.entries(types)
    .filter(([, t]) => t.truncated && t.fallback === 'unavailable')
    .map(([xmlName]) => xmlName);

  const index = {
    runId: paths.runDir.split('/').pop(),
    targetOrg,
    orgId: orgInfo.id,
    apiVersion,
    generatedAt: new Date().toISOString(),
    totalComponents,
    skippedChildTypes: skipped,
    truncatedUnresolvedTypes: truncatedUnresolved,
    types,
  };

  fs.writeFileSync(paths.indexFile, JSON.stringify(index, null, 2));
  fs.writeFileSync(paths.summaryFile, buildSummaryMarkdown(index));

  console.log(`[index] total components indexed: ${totalComponents}`);
  if (truncatedUnresolved.length > 0) {
    console.warn(`[index] WARNING: ${truncatedUnresolved.length} type(s) hit the 3,000-row cap with no Tooling fallback: ${truncatedUnresolved.join(', ')}`);
  }
  console.log(`[index] wrote ${paths.indexFile}`);
  console.log(`[index] wrote ${paths.summaryFile}`);

  return { paths, index };
}

function buildSummaryMarkdown(index) {
  const rows = Object.entries(index.types)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([xmlName, t]) => {
      const flag = t.truncated ? (t.fallback === 'tooling' ? ' (recovered via Tooling API)' : ' **(TRUNCATED, unresolved)**') : '';
      return `| ${xmlName} | ${t.count}${flag} |`;
    })
    .join('\n');

  return `# Metadata index summary

- Org: ${index.targetOrg} (${index.orgId})
- API version: ${index.apiVersion}
- Generated: ${index.generatedAt}
- Total components: **${index.totalComponents}**
- Child-only types skipped (retrieved with their parent): ${index.skippedChildTypes.length}
${index.truncatedUnresolvedTypes.length > 0 ? `- **Unresolved truncated types (hit 3,000-row cap, no Tooling fallback): ${index.truncatedUnresolvedTypes.join(', ')}**\n` : ''}
## Components per type

| Type | Count |
|---|---|
${rows}
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await runIndexPhase({
    targetOrg: args['target-org'] ?? 'CairnCI-Main',
    runDir: args['run-dir'],
    apiVersion: args['api-version'],
    concurrency: args.concurrency ? Number(args.concurrency) : 6,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[index] FAILED:', err.message);
    process.exit(1);
  });
}
