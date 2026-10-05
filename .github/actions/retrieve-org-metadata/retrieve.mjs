#!/usr/bin/env node
// CLI for the CairnCI Full Org Metadata Retrieval tool. All IO lives here:
// argv, env fallbacks, ::annotations, the job summary, outputs and exit codes.
// The logic is in lib/ and is org-free testable.
//
// Exit codes follow the CairnCI extension contract — 0 ok, 10 warn, 1 error,
// 2 config/env — but note that action.yml maps EVERY nonzero code to a job
// success unless fail-on-error is set. See the README: this tool is
// deliberately non-blocking.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { createSfClient } from './lib/sf-cli.mjs';
import { resolveWorkspace, defaultTargetDir } from './lib/paths.mjs';
import { runFullRetrieval, EXIT } from './lib/retrieve-org-metadata.mjs';
import { DEFAULT_MAX_WEIGHT, DEFAULT_WEIGHTS } from './lib/plan-manifests.mjs';
import { buildUnretrievableSummary } from './lib/unretrievable.mjs';
import { DEFAULT_BRANCH_PREFIX } from './lib/snapshot-branch.mjs';

function isFalse(value) {
  return String(value).toLowerCase() === 'false';
}

function num(value, fallback) {
  if (value === undefined || value === true || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}=${String(value).replace(/\r?\n/g, ' ')}\n`);
}

function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    console.log(markdown);
    return;
  }
  fs.appendFileSync(file, `${markdown}\n`);
}

export function buildRunSummary({ index, plan, report, reconciliation, findings, branch, known }) {
  const s = report?.summary ?? { succeeded: 0, failed: 0, total: 0, excludedTypes: [] };
  const lines = [
    '## Full Org Metadata Retrieval',
    '',
    '| | |',
    '|---|---|',
    `| Org | \`${index.targetOrg}\` (${index.orgId}) |`,
    `| API version | ${index.apiVersion} |`,
    `| Retrieved at | ${index.generatedAt} |`,
    `| Components indexed | ${index.totalComponents} |`,
    `| Components retrieved | ${reconciliation?.retrieved ?? 0} |`,
    `| Chunks | ${s.succeeded} succeeded, ${s.failed} failed, ${s.total} total |`,
    `| Max chunk weight | ${plan.maxWeight} (Metadata API ceiling is 10,000 files/request) |`,
  ];

  if (plan.splitTypes?.length > 0) {
    lines.push(`| Types split across chunks | ${plan.splitTypes.join(', ')} |`);
  }
  if (branch) {
    lines.push(`| Branch | \`${branch.branchName}\`${branch.pushed ? '' : ' (not pushed)'} |`);
    lines.push(`| Files changed | ${branch.changedFiles} |`);
  }
  lines.push('');

  if (reconciliation && !reconciliation.allIndexedPlanned) {
    lines.push(
      `> **${reconciliation.indexedMembers - reconciliation.plannedMembers} indexed component(s) never made it into a manifest.** ` +
        'This is a planner bug, not an org limitation — please report it.',
      '',
    );
  }
  if (reconciliation?.unattemptedChunks.length > 0) {
    lines.push(`> **${reconciliation.unattemptedChunks.length} planned chunk(s) were never attempted.**`, '');
  }

  lines.push(buildUnretrievableSummary(findings, known?.canonicalDocs ?? {}));
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const targetOrg = args['target-org'] ?? process.env.TARGET_ORG ?? 'target-org';
  const workspace = resolveWorkspace(args.workspace ?? process.env.CAIRNCI_WORKSPACE);
  const targetDir = args['target-dir'] ? path.resolve(workspace, args['target-dir']) : defaultTargetDir(workspace);

  const weights = args['weights-file']
    ? { ...DEFAULT_WEIGHTS, ...JSON.parse(fs.readFileSync(args['weights-file'], 'utf8')) }
    : DEFAULT_WEIGHTS;

  const result = await runFullRetrieval({
    sf: createSfClient(),
    targetOrg,
    workspace,
    targetDir,
    apiVersion: typeof args['api-version'] === 'string' && args['api-version'] ? args['api-version'] : undefined,
    concurrency: num(args.concurrency, 6),
    maxWeight: num(args['max-weight'], DEFAULT_MAX_WEIGHT),
    weights,
    waitMinutes: num(args.wait, 60),
    keepStaging: args['keep-staging'] === true || args['keep-staging'] === 'true',
    skipRetrieve: args['skip-retrieve'] === true || args['skip-retrieve'] === 'true',
    branchPrefix: args['branch-prefix'] ?? DEFAULT_BRANCH_PREFIX,
    createBranch: !isFalse(args['create-branch'] ?? 'true'),
    push: !isFalse(args.push ?? 'true'),
    eventName: process.env.GITHUB_EVENT_NAME,
  });

  const { index, plan, report, reconciliation, findings, branch, known, exitCode } = result;

  if (report) {
    appendSummary(buildRunSummary({ index, plan, report, reconciliation, findings, branch, known }));
  }

  // Annotations. Every one is a ::warning:: — nothing this tool discovers about
  // an org is an error the run should fail on.
  for (const f of findings?.findings ?? []) {
    if (f.known) {
      console.log(`::warning::${f.type} is not retrievable via the Metadata API (expected): ${f.reason}`);
    } else {
      console.log(
        `::warning::${f.type} could not be retrieved and is not a documented limitation — check the running user's permissions first. ${f.error ?? ''}`,
      );
    }
  }
  for (const c of findings?.failedChunks ?? []) {
    console.log(`::warning::Chunk ${c.file} failed: ${c.error}`);
  }

  setOutput('branch-name', branch?.branchName ?? '');
  setOutput('total-components', index.totalComponents);
  setOutput('chunks-succeeded', report?.summary.succeeded ?? 0);
  setOutput('chunks-failed', report?.summary.failed ?? 0);
  setOutput('types-unretrievable', (findings?.findings ?? []).map((f) => f.type).join(','));

  if (exitCode === EXIT.WARN) {
    console.log('::warning::Full Org Metadata Retrieval completed with warnings; the snapshot is partial.');
  }
  process.exit(exitCode);
}

main().catch((err) => {
  // Config/env problems (no org session, bad flags) land here. Still a
  // ::warning::, still exit 2 rather than throwing a stack at the user —
  // action.yml decides whether 2 fails the job.
  console.log(`::warning::Full Org Metadata Retrieval could not run: ${err.message}`);
  console.error(err.stack ?? err.message);
  process.exit(EXIT.CONFIG);
});
