// Creates the branch a retrieval lands on.
//
// The branch name is the run's primary documentation: reading it alone tells
// you which org, when (UTC), and how the run was started. The commit replaces
// the source tree wholesale, so `git diff main..<branch>` is exactly the org's
// drift since the last snapshot — including components DELETED in the org,
// which a merge-only export would silently leave behind as stale files.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_BRANCH_PREFIX = 'org-snapshot';
export const PROVENANCE_DIR = '.org-snapshot';

/**
 * Maps a GitHub event name to the trigger segment of the branch name.
 * Anything unrecognised falls back to "manual" rather than leaking an
 * arbitrary event name into a git ref.
 */
export function triggerFor(eventName) {
  switch (eventName) {
    case 'schedule':
      return 'schedule';
    case 'workflow_dispatch':
      return 'manual';
    case 'repository_dispatch':
      return 'dispatch';
    case undefined:
    case null:
    case '':
      return 'local';
    default:
      return 'manual';
  }
}

// Git refs disallow a fair amount; org ids and event names are tame, but a
// user-supplied --branch-prefix is not.
function sanitize(segment) {
  return String(segment)
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.\.+/g, '.');
}

/**
 * `org-snapshot/<orgId15>/<runId>Z-<trigger>`
 * e.g. org-snapshot/00D8b000000XyZa/20260726-041500Z-schedule
 *
 * The 15-character org id keeps the name stable whether the CLI hands back a
 * 15- or 18-character id for the same org.
 */
export function buildBranchName({ prefix = DEFAULT_BRANCH_PREFIX, orgId, runId, trigger = 'manual' } = {}) {
  if (!runId) throw new Error('runId is required to build a branch name');
  const org = orgId ? sanitize(String(orgId).slice(0, 15)) : 'unknown-org';
  return `${sanitize(prefix)}/${org}/${runId}Z-${sanitize(trigger)}`;
}

export function buildCommitMessage({ index, report, reconciliation, branchName }) {
  const s = report?.summary ?? { succeeded: 0, failed: 0, total: 0, excludedTypes: [] };
  const lines = [
    `chore(org-snapshot): ${index.targetOrg} @ ${index.generatedAt}`,
    '',
    `Branch:          ${branchName}`,
    `Org:             ${index.targetOrg} (${index.orgId})`,
    `API version:     ${index.apiVersion}`,
    `Components:      ${index.totalComponents} indexed, ${reconciliation?.retrieved ?? 0} retrieved`,
    `Chunks:          ${s.succeeded} succeeded, ${s.failed} failed, ${s.total} total`,
  ];
  if (s.excludedTypes.length > 0) lines.push(`Excluded types:  ${s.excludedTypes.join(', ')}`);
  if (index.truncatedUnresolvedTypes?.length > 0) {
    lines.push(`Truncated types: ${index.truncatedUnresolvedTypes.join(', ')}`);
  }
  lines.push('', 'Retrieved by the CairnCI Full Org Metadata Retrieval tool.');
  return lines.join('\n');
}

/**
 * spawnSync's default maxBuffer is 1 MB, and a full-org snapshot blows straight
 * through it: `git diff --cached --name-only` prints every staged path, which
 * for CairnCI_Production's 7,536 components is roughly 30,000 files and ~2.5 MB
 * of output. On overflow Node KILLS the child and returns `status: null`, which
 * this helper read as a git failure — so a retrieval that had just succeeded
 * died at the commit with an error message made of a megabyte of truncated file
 * paths. Org-verified: 20 minutes of retrieval, then nothing committed.
 *
 * 256 MB is a ceiling, not an allocation. It is set far above any plausible
 * path listing precisely so that hitting it means something is genuinely wrong
 * rather than that the org grew.
 */
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// Error text ends up in a ::warning:: annotation and the job summary, so a
// multi-megabyte message is its own bug. Keep the head, say what was dropped.
function truncate(text, limit = 2000) {
  const s = String(text ?? '').trim();
  return s.length <= limit ? s : `${s.slice(0, limit)}\n… (${s.length - limit} more characters suppressed)`;
}

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  // Checked before `status`: on a spawn problem — including a maxBuffer
  // overflow — status is null, which is "not 0" but is not a git exit code.
  // Reporting it as one is what made the original failure unreadable.
  if (res.error) {
    throw new Error(`git ${args.join(' ')} could not run: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${truncate(res.stderr || res.stdout)}`);
  }
  return (res.stdout ?? '').trim();
}

/** Creates the branch and clears the target tree, before the retrieve runs. */
export function startSnapshotBranch({ cwd, branchName, targetDir, log = console.log }) {
  git(['config', 'user.name', 'github-actions[bot]'], cwd);
  git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], cwd);
  git(['checkout', '-q', '-b', branchName], cwd);
  log(`[branch] created ${branchName}`);

  // Wholesale replace: drop the tracked tree so components deleted in the org
  // show up as deletions rather than lingering. --ignore-unmatch keeps a first
  // run (nothing tracked yet) from failing.
  const relTarget = path.relative(cwd, path.resolve(targetDir)) || '.';
  const mainDefault = path.join(relTarget, 'main', 'default');
  git(['rm', '-r', '-q', '--ignore-unmatch', '--', mainDefault], cwd);
  fs.rmSync(path.join(cwd, mainDefault), { recursive: true, force: true });
  log(`[branch] cleared ${mainDefault} for a full replace`);

  return branchName;
}

/**
 * Commits the retrieved tree plus the run's own provenance, and optionally
 * pushes. Returns what happened so the caller can report it.
 */
export function commitSnapshot({
  cwd,
  branchName,
  targetDir,
  index,
  report,
  reconciliation,
  summaryMarkdown,
  push = true,
  log = console.log,
  warn = console.warn,
}) {
  // The run's index summary and retrieve report normally live under the
  // gitignored .metadata-export/; copy them into the branch so a snapshot
  // carries the evidence of how complete it is.
  const provenance = path.join(cwd, PROVENANCE_DIR);
  fs.mkdirSync(provenance, { recursive: true });
  fs.writeFileSync(path.join(provenance, 'metadata-index-summary.md'), summaryMarkdown);
  fs.writeFileSync(path.join(provenance, 'retrieve-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(provenance, 'reconciliation.json'),
    JSON.stringify({ ...reconciliation, org: index.targetOrg, orgId: index.orgId, apiVersion: index.apiVersion }, null, 2),
  );

  const relTarget = path.relative(cwd, path.resolve(targetDir)) || '.';
  git(['add', '-A', '--', relTarget, PROVENANCE_DIR], cwd);

  const staged = git(['diff', '--cached', '--name-only'], cwd);
  if (!staged) {
    warn('[branch] no changes to commit — the org tree is identical to the base commit');
    return { branchName, committed: false, pushed: false, changedFiles: 0 };
  }

  const changedFiles = staged.split('\n').filter(Boolean).length;
  git(['commit', '-q', '-m', buildCommitMessage({ index, report, reconciliation, branchName })], cwd);
  log(`[branch] committed ${changedFiles} changed file(s)`);

  if (!push) {
    log('[branch] push disabled; branch exists locally only');
    return { branchName, committed: true, pushed: false, changedFiles };
  }

  git(['push', '-q', 'origin', `HEAD:refs/heads/${branchName}`], cwd);
  log(`[branch] pushed ${branchName}`);
  return { branchName, committed: true, pushed: true, changedFiles };
}
