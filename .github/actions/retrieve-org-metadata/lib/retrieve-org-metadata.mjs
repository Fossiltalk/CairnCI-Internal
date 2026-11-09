// Orchestrator: index -> plan -> retrieve -> reconcile -> commit, on one run
// directory and one snapshot branch.
//
// Pure of process concerns (no argv, no process.exit, no ::annotations) so the
// whole flow is testable with a stubbed sf client and a temp git repo.
// retrieve.mjs wraps this with the CLI and GitHub reporting.
import fs from 'node:fs';
import path from 'node:path';
import { runPaths, ensureDir, newRunId, outRoot, defaultTargetDir, resolveWorkspace } from './paths.mjs';
import { runIndexPhase } from './index-metadata.mjs';
import { planManifestsPhase, DEFAULT_MAX_WEIGHT, DEFAULT_WEIGHTS } from './plan-manifests.mjs';
import { retrievePhase, reconcile } from './retrieve-metadata.mjs';
import { collectFindings, loadKnownUnretrievable, skippableTypes } from './unretrievable.mjs';
import { buildBranchName, startSnapshotBranch, commitSnapshot, triggerFor, DEFAULT_BRANCH_PREFIX } from './snapshot-branch.mjs';

/** Exit codes, matching the CairnCI extension contract. */
export const EXIT = { OK: 0, ERROR: 1, CONFIG: 2, WARN: 10 };

export async function runFullRetrieval({
  sf,
  targetOrg,
  workspace,
  targetDir,
  runDir,
  apiVersion,
  concurrency = 6,
  maxWeight = DEFAULT_MAX_WEIGHT,
  weights = DEFAULT_WEIGHTS,
  waitMinutes = 60,
  keepStaging = false,
  skipRetrieve = false,
  branchPrefix = DEFAULT_BRANCH_PREFIX,
  createBranch = true,
  push = true,
  eventName,
  now = new Date(),
  log = console.log,
  warn = console.warn,
} = {}) {
  if (!sf) throw new Error('sf client is required');
  if (!targetOrg) throw new Error('targetOrg is required');

  const cwd = resolveWorkspace(workspace);
  const outputDir = path.resolve(targetDir ?? defaultTargetDir(cwd));
  const runId = newRunId(now);
  const resolvedRunDir = runDir ?? path.join(outRoot(cwd), runId);
  ensureDir(resolvedRunDir);

  // Loaded before phase 1, not after phase 3: the reference data now shapes
  // the run (which types are worth listing at all), not just how it is
  // explained afterwards.
  const known = loadKnownUnretrievable();

  // --- Phase 1: index -------------------------------------------------------
  const { index } = await runIndexPhase({
    sf,
    targetOrg,
    runDir: resolvedRunDir,
    apiVersion,
    concurrency,
    skipTypes: skippableTypes(known),
    log,
    warn,
  });

  // --- Phase 2: plan --------------------------------------------------------
  const { plan } = await planManifestsPhase({ runDir: resolvedRunDir, maxWeight, weights, log });

  if (skipRetrieve) {
    log(`[run] --skip-retrieve set; manifests are ready under ${resolvedRunDir}/manifests`);
    return {
      runId,
      runDir: resolvedRunDir,
      index,
      plan,
      report: null,
      reconciliation: null,
      findings: { findings: [], knownCount: 0, unknownCount: 0, failedChunks: [] },
      branch: null,
      exitCode: EXIT.OK,
    };
  }

  // --- Branch: created BEFORE the retrieve so the wholesale clear of the
  // target tree and the retrieved files land in the same commit. -------------
  const branchName = buildBranchName({
    prefix: branchPrefix,
    orgId: index.orgId,
    runId,
    trigger: triggerFor(eventName),
  });
  if (createBranch) {
    startSnapshotBranch({ cwd, branchName, targetDir: outputDir, log });
  }

  // --- Phase 3: retrieve ----------------------------------------------------
  const { report } = await retrievePhase({
    sf,
    runDir: resolvedRunDir,
    waitMinutes,
    targetDir: outputDir,
    workspace: cwd,
    keepStaging,
    log,
    warn,
  });

  // --- Phase 4: reconcile + classify ---------------------------------------
  const reconciliation = reconcile(index, plan, report);
  const findings = collectFindings({ index, report, known });

  if (!reconciliation.allIndexedPlanned) {
    warn(
      `[run] WARNING: ${reconciliation.indexedMembers} components indexed but ${reconciliation.plannedMembers} planned — some were not written to any manifest.`,
    );
  }
  if (!reconciliation.allChunksAttempted) {
    warn(`[run] WARNING: ${reconciliation.unattemptedChunks.length} planned chunk(s) were never attempted.`);
  }

  // --- Phase 5: commit ------------------------------------------------------
  let branch = null;
  if (createBranch) {
    const paths = runPaths(resolvedRunDir);
    branch = commitSnapshot({
      cwd,
      branchName,
      targetDir: outputDir,
      index,
      report,
      reconciliation,
      summaryMarkdown: fs.readFileSync(paths.summaryFile, 'utf8'),
      push,
      log,
      warn,
    });
  }

  return {
    runId,
    runDir: resolvedRunDir,
    index,
    plan,
    report,
    reconciliation,
    findings,
    known,
    branch,
    exitCode: exitCodeFor({ report, reconciliation, findings }),
  };
}

/**
 * A partial snapshot is a WARN, not an error — the tool's contract is that it
 * always produces the best snapshot it can. EXIT.ERROR is reserved for a run
 * that produced nothing usable. The composite action then maps any nonzero to
 * 0 unless fail-on-error is set; see action.yml.
 */
export function exitCodeFor({ report, reconciliation, findings }) {
  const s = report?.summary;
  if (!s || s.total === 0) return EXIT.ERROR;
  if (s.succeeded === 0) return EXIT.ERROR;
  if (s.failed > 0 || findings.unknownCount > 0 || !reconciliation.allChunksAttempted || !reconciliation.allIndexedPlanned) {
    return EXIT.WARN;
  }
  if (findings.knownCount > 0) return EXIT.WARN;
  return EXIT.OK;
}
