import { spawn } from 'node:child_process';

const RETRYABLE_PATTERNS = [
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /socket hang up/i,
  /INVALID_SESSION_ID/i,
  /UNABLE_TO_LOCK_ROW/i,
  /Please try again/i,
];

function isRetryable(message) {
  return RETRYABLE_PATTERNS.some((re) => re.test(message));
}

function runOnce(args, timeout, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('sf', [...args, '--json'], { timeout, cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', () => {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(`sf ${args.join(' ')} did not return valid JSON:\n${(stderr || stdout).slice(0, 2000)}`));
        return;
      }
      if (parsed.status !== 0) {
        reject(new Error(`sf ${args.join(' ')} failed: ${parsed.message || JSON.stringify(parsed).slice(0, 2000)}`));
        return;
      }
      resolve(parsed.result);
    });
  });
}

/** Run an `sf` CLI subcommand with --json, retrying transient failures. */
export async function sf(args, { retries = 2, timeout = 10 * 60 * 1000, cwd } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await runOnce(args, timeout, cwd);
    } catch (err) {
      lastError = err;
      if (attempt < retries && isRetryable(err.message)) continue;
      throw lastError;
    }
  }
  throw lastError;
}

export function sfOrgDisplay(targetOrg) {
  return sf(['org', 'display', '--target-org', targetOrg]);
}

export function sfDescribeMetadata(targetOrg, apiVersion) {
  const args = ['org', 'list', 'metadata-types', '--target-org', targetOrg];
  if (apiVersion) args.push('--api-version', apiVersion);
  return sf(args);
}

export async function sfListMetadata(targetOrg, metadataType, { folder, apiVersion } = {}) {
  const args = ['org', 'list', 'metadata', '--target-org', targetOrg, '--metadata-type', metadataType];
  if (folder) args.push('--folder', folder);
  if (apiVersion) args.push('--api-version', apiVersion);
  const result = await sf(args);
  return Array.isArray(result) ? result : [];
}

export async function sfQuery(targetOrg, soql, { toolingApi = false } = {}) {
  const args = ['data', 'query', '--target-org', targetOrg, '--query', soql];
  if (toolingApi) args.push('--use-tooling-api');
  const result = await sf(args, { retries: 2, timeout: 5 * 60 * 1000 });
  return result?.records ?? [];
}

// Metadata API (zip) format, not source format: source-format retrieve via
// `--output-dir` into a directory that isn't one of sfdx-project.json's
// declared packageDirectories silently no-ops in @salesforce/cli 2.140.6
// (server-side retrieve succeeds, "Warning: Nothing retrieved", zero files
// written) — confirmed by hand against this org. `--target-metadata-dir`
// reliably writes files regardless of project structure, so that's what we
// use for an ad hoc export directory outside the project's package tree.
export function sfRetrieve(targetOrg, manifestPath, outputDir, { cwd, waitMinutes = 60 } = {}) {
  const args = [
    'project',
    'retrieve',
    'start',
    '--target-org',
    targetOrg,
    '--manifest',
    manifestPath,
    '--target-metadata-dir',
    outputDir,
    '--unzip',
    '--wait',
    String(waitMinutes),
  ];
  return sf(args, { retries: 1, timeout: (waitMinutes + 5) * 60 * 1000, cwd });
}

// Converts an mdapi-format retrieve into standard source format
// (force-app/main/default/<type>/...). `rootDir` must NOT be nested inside
// a directory tree containing an sfdx-project.json (see the note on
// `stagingRoot` in lib/paths.mjs) or the CLI silently converts zero
// components. `outputDir` (e.g. this repo's `force-app`) can be inside the
// project — the CLI appends `main/default` to it itself.
export function sfConvertMdapi(rootDir, outputDir, { cwd } = {}) {
  const args = ['project', 'convert', 'mdapi', '--root-dir', rootDir, '--output-dir', outputDir];
  return sf(args, { retries: 1, timeout: 5 * 60 * 1000, cwd });
}

/** Runs `items` through `worker` with at most `concurrency` in flight at once. */
export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
  return results;
}
