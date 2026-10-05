import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// The workspace is the consumer repo checkout, NOT this action's own
// directory: when the action runs from ${{ github.action_path }} those are
// different trees. CAIRNCI_WORKSPACE is the variable the extension caller
// exports (see docs/extensions.md); a plain `uses:` step inherits the
// checkout as cwd.
export function resolveWorkspace(explicit) {
  return path.resolve(explicit || process.env.CAIRNCI_WORKSPACE || process.cwd());
}

export const OUT_ROOT_NAME = '.metadata-export';
export const DEFAULT_TARGET_DIR_NAME = 'force-app';

export function outRoot(workspace) {
  return path.join(resolveWorkspace(workspace), OUT_ROOT_NAME);
}

export function defaultTargetDir(workspace) {
  return path.join(resolveWorkspace(workspace), DEFAULT_TARGET_DIR_NAME);
}

// `sf project convert mdapi --root-dir <dir>` silently converts zero
// components ("No results to format") when <dir> is nested inside a
// directory tree that itself contains an sfdx-project.json (confirmed
// against @salesforce/cli 2.140.6) — as a Salesforce repo's root does. Raw
// mdapi retrieve output must therefore be staged outside the repo; only the
// converted, source-format --output-dir needs to be inside it.
export function stagingRoot(runId) {
  return path.join(os.tmpdir(), 'cairnci-metadata-export', runId);
}

/**
 * Run id: UTC timestamp, `YYYYMMDD-HHMMSS`. UTC (not local time) so run ids
 * sort consistently regardless of which runner or laptop produced them, and
 * so the snapshot branch name means the same thing to everyone reading it.
 */
export function newRunId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

export function runPaths(runDir) {
  const dir = path.resolve(runDir);
  const runId = path.basename(dir);
  return {
    runDir: dir,
    runId,
    indexDir: path.join(dir, 'index'),
    indexFile: path.join(dir, 'index', 'metadata-index.json'),
    summaryFile: path.join(dir, 'index', 'summary.md'),
    manifestsDir: path.join(dir, 'manifests'),
    manifestPlanFile: path.join(dir, 'manifests', 'manifest-plan.json'),
    mdapiStagingDir: stagingRoot(runId),
    retrieveReportFile: path.join(dir, 'retrieve-report.json'),
  };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
