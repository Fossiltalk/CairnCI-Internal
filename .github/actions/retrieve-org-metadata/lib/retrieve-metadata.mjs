// Phase 3: retrieve each chunked manifest and merge it into a standard
// source-format tree (force-app/main/default/<type>/... by default).
// Runs sequentially — concurrent retrieves against the same org risk
// session/request contention, and this is a bulk export, not a
// latency-sensitive pipeline.
//
// Each chunk is retrieved in metadata API (zip) format into a staging
// directory OUTSIDE the repo (see paths.mjs `stagingRoot` for why), then
// converted to source format directly into --target-dir. Chunks merge
// naturally since every chunk's members are disjoint.
//
// A chunk failure NEVER aborts the run: it is recorded in the report and the
// next chunk proceeds. That is the whole point — a partial org snapshot is
// still a useful org snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, runPaths, resolveWorkspace } from './paths.mjs';
import { buildPackageXml } from './manifest-xml.mjs';

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
async function retrieveChunkWithRegistryFallback(sf, targetOrg, chunk, paths, chunkStagingDir, waitMinutes, cwd, warn) {
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
      await sf.retrieve(targetOrg, manifestPath, chunkStagingDir, { cwd, waitMinutes });
      return { excludedTypes };
    } catch (err) {
      const match = err.message.match(UNSUPPORTED_TYPE_PATTERN);
      if (!match) throw err;

      const badType = match[1];
      warn(
        `[retrieve]   ${chunk.file}: type '${badType}' unsupported by the installed sf CLI's metadata registry — excluding and retrying`,
      );
      excludedTypes.push(badType);
      typeGroups = typeGroups.filter((g) => g.type !== badType);
      if (typeGroups.length === 0) {
        throw new Error(`All types in ${chunk.file} were excluded as unsupported (last: ${badType})`);
      }
    }
  }

  throw new Error(`${chunk.file}: exceeded ${MAX_UNSUPPORTED_TYPE_RETRIES} unsupported-type retries`);
}

/**
 * @param {object} options
 * @param {ReturnType<import('./sf-cli.mjs').createSfClient>} options.sf
 */
export async function retrievePhase({
  sf,
  runDir,
  onlyChunk,
  waitMinutes = 60,
  targetDir,
  workspace,
  keepStaging = false,
  log = console.log,
  warn = console.warn,
} = {}) {
  if (!sf) throw new Error('sf client is required');

  const cwd = resolveWorkspace(workspace);
  const paths = runPaths(runDir);
  const index = JSON.parse(fs.readFileSync(paths.indexFile, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(paths.manifestPlanFile, 'utf8'));
  const outDir = path.resolve(targetDir);

  ensureDir(paths.mdapiStagingDir);
  ensureDir(outDir);

  let chunks = plan.chunks;
  if (onlyChunk) {
    const wanted = `package-chunk-${String(onlyChunk).padStart(3, '0')}.xml`;
    chunks = chunks.filter((c) => c.file === wanted);
    if (chunks.length === 0) throw new Error(`No chunk matching ${wanted} in ${paths.manifestPlanFile}`);
  }

  log(`[retrieve] target org: ${index.targetOrg}`);
  log(`[retrieve] merging into: ${outDir}`);
  log(`[retrieve] running ${chunks.length}/${plan.chunks.length} chunk(s) sequentially`);

  // Preflight: `sf project convert mdapi` refuses to run outside a Salesforce
  // project ("RequiresProjectError"). Without this check every chunk would
  // retrieve successfully and then fail at conversion, and because this tool
  // never fails the job the user would get an empty snapshot and a vague
  // warning. Say it once, up front, instead.
  if (!hasSfdxProject(cwd)) {
    warn(
      `[retrieve] WARNING: no sfdx-project.json at or above ${cwd}. ` +
        '`sf project convert mdapi` requires a Salesforce project directory and will reject every chunk ' +
        '(RequiresProjectError). Add an sfdx-project.json to the repo root before running this tool.',
    );
  }

  const report = {
    runId: index.runId,
    targetOrg: index.targetOrg,
    targetDir: outDir,
    startedAt: new Date().toISOString(),
    chunks: [],
  };

  for (const [i, chunk] of chunks.entries()) {
    const chunkStagingDir = path.join(paths.mdapiStagingDir, chunk.file.replace('.xml', ''));
    log(`[retrieve] (${i + 1}/${chunks.length}) ${chunk.file} — ${chunk.memberCount} members, ${chunk.types.length} types`);
    const startedAt = Date.now();
    try {
      const { excludedTypes } = await retrieveChunkWithRegistryFallback(
        sf,
        index.targetOrg,
        chunk,
        paths,
        chunkStagingDir,
        waitMinutes,
        cwd,
        warn,
      );
      const mdapiRoot = path.join(chunkStagingDir, 'unpackaged', 'unpackaged');
      await sf.convertMdapi(mdapiRoot, outDir, { cwd });
      if (!keepStaging) fs.rmSync(chunkStagingDir, { recursive: true, force: true });
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      const excludedNote = excludedTypes.length > 0 ? `, excluded unsupported types: ${excludedTypes.join(', ')}` : '';
      log(`[retrieve]   OK (${seconds}s)${excludedNote}`);
      report.chunks.push({ file: chunk.file, status: 'succeeded', seconds, excludedTypes, types: chunk.types });
    } catch (err) {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      warn(`[retrieve]   FAILED (${seconds}s): ${err.message}`);
      warn(`[retrieve]   staging kept for inspection: ${chunkStagingDir}`);
      report.chunks.push({
        file: chunk.file,
        status: 'failed',
        seconds,
        error: err.message,
        stagingDir: chunkStagingDir,
        types: chunk.types,
      });
    }
  }

  report.finishedAt = new Date().toISOString();
  report.summary = summarize(report.chunks);

  // Merge with any prior report so re-running --only-chunk doesn't clobber
  // results from earlier chunks in the same run dir.
  if (fs.existsSync(paths.retrieveReportFile) && onlyChunk) {
    const prior = JSON.parse(fs.readFileSync(paths.retrieveReportFile, 'utf8'));
    const byFile = new Map(prior.chunks.map((c) => [c.file, c]));
    for (const c of report.chunks) byFile.set(c.file, c);
    report.chunks = [...byFile.values()];
    report.summary = summarize(report.chunks);
  }

  fs.writeFileSync(paths.retrieveReportFile, JSON.stringify(report, null, 2));

  const { succeeded, failed, excludedTypes } = report.summary;
  log(`[retrieve] ${succeeded} succeeded, ${failed} failed`);
  log(`[retrieve] wrote ${paths.retrieveReportFile}`);
  if (excludedTypes.length > 0) {
    warn(
      `[retrieve] WARNING: ${excludedTypes.length} type(s) skipped, unsupported by the installed sf CLI's metadata registry: ${excludedTypes.join(', ')}`,
    );
    warn('[retrieve] a newer @salesforce/cli may carry these types in its registry; upgrade and re-run to capture them');
  }
  if (failed > 0) {
    warn('[retrieve] re-run to retry the failed chunk(s) after investigating');
  }

  return { paths, report };
}

/**
 * Reconciles what was planned against what came back. Every member in the
 * index must be accounted for as retrieved, excluded, or failed — this is what
 * makes "all indexed components were attempted" checkable rather than assumed.
 */
export function reconcile(index, plan, report) {
  const statusByChunk = new Map(report.chunks.map((c) => [c.file, c]));
  const excluded = new Set(report.chunks.flatMap((c) => c.excludedTypes ?? []));

  let attempted = 0;
  let retrieved = 0;
  let failedMembers = 0;
  const unattemptedChunks = [];

  for (const chunk of plan.chunks) {
    const result = statusByChunk.get(chunk.file);
    if (!result) {
      unattemptedChunks.push(chunk.file);
      continue;
    }
    attempted += chunk.memberCount;
    if (result.status === 'succeeded') retrieved += chunk.memberCount;
    else failedMembers += chunk.memberCount;
  }

  const plannedMembers = plan.chunks.reduce((sum, c) => sum + c.memberCount, 0);
  const indexedMembers = Object.values(index.types).reduce((sum, t) => sum + t.members.length, 0);

  return {
    indexedMembers,
    plannedMembers,
    attempted,
    retrieved,
    failedMembers,
    unattemptedChunks,
    excludedTypes: [...excluded],
    // The two invariants worth asserting: nothing indexed was dropped on the
    // way into a manifest, and no planned chunk went unattempted.
    allIndexedPlanned: plannedMembers === indexedMembers,
    allChunksAttempted: unattemptedChunks.length === 0,
  };
}

/**
 * True when `dir` or any ancestor holds an sfdx-project.json — the condition
 * `sf project convert mdapi` checks before it will run at all.
 *
 * Org-verified: with cwd outside a project the CLI returns RequiresProjectError
 * and converts nothing; inside one it proceeds. This is the OTHER half of the
 * convert constraint — see the note on `stagingRoot` in paths.mjs for why the
 * --root-dir must simultaneously live OUTSIDE any such tree.
 */
export function hasSfdxProject(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, 'sfdx-project.json'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function summarize(chunks) {
  return {
    succeeded: chunks.filter((c) => c.status === 'succeeded').length,
    failed: chunks.filter((c) => c.status === 'failed').length,
    total: chunks.length,
    excludedTypes: [...new Set(chunks.flatMap((c) => c.excludedTypes ?? []))],
  };
}
