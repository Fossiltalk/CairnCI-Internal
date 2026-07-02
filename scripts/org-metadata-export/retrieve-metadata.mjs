#!/usr/bin/env node
// Phase 3: retrieve each chunked manifest and merge it into a standard
// source-format tree (force-app/main/default/<type>/... by default).
// Runs sequentially — concurrent retrieves against the same org risk
// session/request contention, and this is a one-off export, not a
// latency-sensitive pipeline.
//
// Each chunk is retrieved in metadata API (zip) format into a staging
// directory OUTSIDE this repo (see lib/paths.mjs `stagingRoot` for why),
// then converted to source format directly into --target-dir. Chunks merge
// naturally since every chunk's members are disjoint.
//
// Usage:
//   node retrieve-metadata.mjs --run-dir <path> [--target-dir force-app]
//                               [--only-chunk 001] [--wait 60] [--keep-staging]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { ensureDir, runPaths, REPO_ROOT, DEFAULT_TARGET_DIR } from './lib/paths.mjs';
import { sfRetrieve, sfConvertMdapi } from './lib/sf-cli.mjs';
import { buildPackageXml } from './lib/manifest-xml.mjs';

const MAX_UNSUPPORTED_TYPE_RETRIES = 25;
const UNSUPPORTED_TYPE_PATTERN = /Missing metadata type definition in registry for id '([^']+)'/;

// The installed `sf` CLI validates every manifest member against its own
// bundled metadata-type registry before it ever talks to the org. Newer or
// Industries-specific types (confirmed here: IdentityVerificationProcDtl,
// a Public Sector Solutions type) can exist in the org and in
// describeMetadata/listMetadata output while still being unknown to that
// local registry, which fails the *entire* chunk instantly — not just the
// unsupported type's members. Detect the offending type from the error,
// drop it from this chunk's manifest, and retry; repeat for however many
// distinct unsupported types a chunk turns out to contain.
async function retrieveChunkWithRegistryFallback(targetOrg, chunk, paths, chunkStagingDir, waitMinutes) {
  const sidecar = JSON.parse(fs.readFileSync(path.join(paths.manifestsDir, chunk.jsonFile), 'utf8'));
  let typeGroups = sidecar.typeGroups;
  const excludedTypes = [];

  for (let attempt = 0; attempt <= MAX_UNSUPPORTED_TYPE_RETRIES; attempt++) {
    const manifestPath =
      excludedTypes.length === 0
        ? path.join(paths.manifestsDir, chunk.file)
        : path.join(paths.manifestsDir, chunk.file.replace(/\.xml$/, `.retry-${excludedTypes.length}.xml`));

    if (excludedTypes.length > 0) {
      fs.writeFileSync(manifestPath, buildPackageXml(typeGroups, sidecar.apiVersion));
    }

    try {
      await sfRetrieve(targetOrg, manifestPath, chunkStagingDir, { cwd: REPO_ROOT, waitMinutes });
      return { excludedTypes };
    } catch (err) {
      const match = err.message.match(UNSUPPORTED_TYPE_PATTERN);
      if (!match) throw err;

      const badType = match[1];
      console.warn(`[retrieve]   ${chunk.file}: type '${badType}' unsupported by the installed sf CLI's metadata registry — excluding and retrying`);
      excludedTypes.push(badType);
      typeGroups = typeGroups.filter((g) => g.type !== badType);
      if (typeGroups.length === 0) {
        throw new Error(`All types in ${chunk.file} were excluded as unsupported (last: ${badType})`);
      }
    }
  }

  throw new Error(`${chunk.file}: exceeded ${MAX_UNSUPPORTED_TYPE_RETRIES} unsupported-type retries`);
}

export async function retrievePhase({ runDir, onlyChunk, waitMinutes = 60, targetDir = DEFAULT_TARGET_DIR, keepStaging = false } = {}) {
  const paths = runPaths(runDir);
  const index = JSON.parse(fs.readFileSync(paths.indexFile, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(paths.manifestPlanFile, 'utf8'));

  ensureDir(paths.mdapiStagingDir);
  ensureDir(targetDir);

  let chunks = plan.chunks;
  if (onlyChunk) {
    const wanted = `package-chunk-${String(onlyChunk).padStart(3, '0')}.xml`;
    chunks = chunks.filter((c) => c.file === wanted);
    if (chunks.length === 0) throw new Error(`No chunk matching ${wanted} in ${paths.manifestPlanFile}`);
  }

  console.log(`[retrieve] target org: ${index.targetOrg}`);
  console.log(`[retrieve] merging into: ${targetDir}`);
  console.log(`[retrieve] running ${chunks.length}/${plan.chunks.length} chunk(s) sequentially`);

  const report = { runId: index.runId, targetOrg: index.targetOrg, targetDir, startedAt: new Date().toISOString(), chunks: [] };

  for (const [i, chunk] of chunks.entries()) {
    const chunkStagingDir = path.join(paths.mdapiStagingDir, chunk.file.replace('.xml', ''));
    console.log(`[retrieve] (${i + 1}/${chunks.length}) ${chunk.file} — ${chunk.memberCount} members, ${chunk.types.length} types`);
    const startedAt = Date.now();
    try {
      const { excludedTypes } = await retrieveChunkWithRegistryFallback(index.targetOrg, chunk, paths, chunkStagingDir, waitMinutes);
      const mdapiRoot = path.join(chunkStagingDir, 'unpackaged', 'unpackaged');
      await sfConvertMdapi(mdapiRoot, targetDir, { cwd: REPO_ROOT });
      if (!keepStaging) fs.rmSync(chunkStagingDir, { recursive: true, force: true });
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      const excludedNote = excludedTypes.length > 0 ? `, excluded unsupported types: ${excludedTypes.join(', ')}` : '';
      console.log(`[retrieve]   OK (${seconds}s)${excludedNote}`);
      report.chunks.push({ file: chunk.file, status: 'succeeded', seconds, excludedTypes });
    } catch (err) {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.error(`[retrieve]   FAILED (${seconds}s): ${err.message}`);
      console.error(`[retrieve]   staging kept for inspection: ${chunkStagingDir}`);
      report.chunks.push({ file: chunk.file, status: 'failed', seconds, error: err.message, stagingDir: chunkStagingDir });
    }
  }

  report.finishedAt = new Date().toISOString();
  const succeeded = report.chunks.filter((c) => c.status === 'succeeded').length;
  const failed = report.chunks.filter((c) => c.status === 'failed').length;
  const allExcludedTypes = [...new Set(report.chunks.flatMap((c) => c.excludedTypes ?? []))];
  report.summary = { succeeded, failed, total: report.chunks.length, excludedTypes: allExcludedTypes };

  // Merge with any prior report so re-running --only-chunk doesn't clobber
  // results from earlier chunks in the same run dir.
  if (fs.existsSync(paths.retrieveReportFile) && onlyChunk) {
    const prior = JSON.parse(fs.readFileSync(paths.retrieveReportFile, 'utf8'));
    const byFile = new Map(prior.chunks.map((c) => [c.file, c]));
    for (const c of report.chunks) byFile.set(c.file, c);
    report.chunks = [...byFile.values()];
    const mergedExcluded = [...new Set(report.chunks.flatMap((c) => c.excludedTypes ?? []))];
    report.summary = {
      succeeded: report.chunks.filter((c) => c.status === 'succeeded').length,
      failed: report.chunks.filter((c) => c.status === 'failed').length,
      total: report.chunks.length,
      excludedTypes: mergedExcluded,
    };
  }

  fs.writeFileSync(paths.retrieveReportFile, JSON.stringify(report, null, 2));

  console.log(`[retrieve] ${succeeded} succeeded, ${failed} failed (this run)`);
  console.log(`[retrieve] wrote ${paths.retrieveReportFile}`);
  if (report.summary.excludedTypes.length > 0) {
    console.warn(
      `[retrieve] WARNING: ${report.summary.excludedTypes.length} type(s) skipped, unsupported by the installed sf CLI's metadata registry: ${report.summary.excludedTypes.join(', ')}`,
    );
    console.warn(`[retrieve] try 'npm install --global @salesforce/cli@latest' for a newer registry, then re-run with --only-chunk on the affected chunk(s)`);
  }
  if (failed > 0) {
    console.warn(`[retrieve] re-run failed chunks individually with --only-chunk <NNN> after investigating`);
  }

  return { paths, report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['run-dir']) throw new Error('--run-dir is required (point at the output of plan-manifests.mjs)');

  await retrievePhase({
    runDir: args['run-dir'],
    onlyChunk: args['only-chunk'],
    waitMinutes: args.wait ? Number(args.wait) : 60,
    targetDir: args['target-dir'] ? path.resolve(args['target-dir']) : DEFAULT_TARGET_DIR,
    keepStaging: Boolean(args['keep-staging']),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[retrieve] FAILED:', err.message);
    process.exit(1);
  });
}
