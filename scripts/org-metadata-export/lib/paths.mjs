import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const REPO_ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
export const DEFAULT_OUT_ROOT = path.join(REPO_ROOT, '.metadata-export');
export const DEFAULT_TARGET_DIR = path.join(REPO_ROOT, 'force-app');

// `sf project convert mdapi --root-dir <dir>` silently converts zero
// components ("No results to format") when <dir> is nested inside a
// directory tree that itself contains an sfdx-project.json (confirmed
// against @salesforce/cli 2.140.6) — as this repo's root does. Raw mdapi
// retrieve output must therefore be staged outside the repo; only the
// converted, source-format --output-dir needs to be inside it.
export function stagingRoot(runId) {
  return path.join(os.tmpdir(), 'cairnci-metadata-export', runId);
}

export function newRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
