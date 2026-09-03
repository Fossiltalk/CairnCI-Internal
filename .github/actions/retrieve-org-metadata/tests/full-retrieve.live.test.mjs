// The full-fat live test: a REAL full-org retrieval onto a REAL snapshot
// branch, exercising `runFullRetrieval` exactly as the shipped action calls it.
//
// This is the half neither the unit suites nor `*.org.test.mjs` can reach:
//
//   * the unit suites stub `sf`, so they prove the orchestration but retrieve
//     nothing;
//   * `*.org.test.mjs` is live but deliberately READ-ONLY and scoped to a
//     handful of types, so it proves the Salesforce claims but never plans,
//     retrieves, chunks, commits or pushes at real org volume.
//
// What only this file proves:
//   1. A whole org indexes, plans, retrieves and reconciles end to end with
//      nothing dropped between phases.
//   2. Multi-chunk retrieval actually works against the real 10,000-file
//      ceiling — every chunk, not a two-member sample.
//   3. The snapshot branch is created, the target tree is replaced WHOLESALE
//      (org-side deletions show up as git deletions), provenance is committed,
//      and the push lands.
//   4. The run finishes inside GitHub's 6h job ceiling. That number was a
//      documented guess until this test started measuring it.
//
// WHERE IT WRITES. Never the repo under test. The whole thing happens in a
// throwaway git repo under the OS temp dir whose `origin` is a local bare
// repo, so the push is genuinely exercised — `git push` really runs, the ref
// really lands — without creating branches in CairnCI-Internal. Wiring tests
// at the bottom enforce that structurally.
//
// It is gated on its OWN env var, separate from ORG_METADATA_LIVE_ORG: the
// read-only suite is a two-minute check people run casually, and this is not.
//
//   cd .github/actions/retrieve-org-metadata
//   ORG_METADATA_FULL_RETRIEVE=CairnCI_Production npm run test:retrieve-org-metadata:full
//
// In CI it runs only on pushes to main, or on an explicit workflow_dispatch —
// see the `full-retrieve` job in integration-retrieve-org-metadata.yml.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSfClient } from '../lib/sf-cli.mjs';
import { runFullRetrieval, EXIT } from '../lib/retrieve-org-metadata.mjs';
import { DEFAULT_MAX_WEIGHT } from '../lib/plan-manifests.mjs';
import { GIT_MAX_BUFFER } from '../lib/snapshot-branch.mjs';

const ORG = process.env.ORG_METADATA_FULL_RETRIEVE || '';

// Resolved at module scope: node:test evaluates a suite's `skip` option when
// the suite is REGISTERED, before any hook runs.
const HAS_SF = ORG ? spawnSync('sf', ['--version'], { encoding: 'utf8' }).status === 0 : false;

// Below the 350-minute job timeout in the workflow, so a hung run fails as a
// test with output rather than as a killed job with none.
const FULL_TIMEOUT_MS = Number(process.env.ORG_METADATA_FULL_TIMEOUT_MS || 300 * 60 * 1000);

// GitHub's hard job ceiling is 360 minutes. The example caller documents 350;
// assert against that, since a run that needs longer is unshippable either way.
const JOB_CEILING_MINUTES = 350;

// The shipped default (see action.yml / retrieve.mjs). Not lowered: the point
// of this test is to run what we publish.
const CONCURRENCY = Number(process.env.ORG_METADATA_CONCURRENCY || 6);

// A sanity floor, not a measurement. CairnCI_Production indexes ~7,500
// components; anything under this means the index collapsed rather than that
// the org shrank.
const MIN_EXPECTED_COMPONENTS = 1000;

// Tracked in the seed commit and absent from any org, so the wholesale replace
// MUST record it as a deletion. This is the assertion that separates "replaced
// the tree" from "merged on top of it".
const STALE_SENTINEL = 'CairnCiSnapshotStaleSentinel';

/**
 * Reason to skip, or `false` when the suite can run. It must be exactly
 * `false`: node:test treats every other value — including null — as "skip".
 */
function skipReason() {
  if (!ORG) return 'set ORG_METADATA_FULL_RETRIEVE=<org alias> to run the full retrieval test';
  if (!HAS_SF) return 'the sf CLI is not on PATH';
  return false;
}

const roots = [];
function tmp(prefix = 'rom-full-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

// Same maxBuffer trap the product hit: `ls-tree -r` and `diff --name-status`
// over a full org print megabytes, and spawnSync's 1 MB default would kill git
// and report it as a failure. The assertions here would then "fail" for a
// reason that has nothing to do with the snapshot.
function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  assert.equal(res.error, undefined, `git ${args.join(' ')} could not run: ${res.error?.message}`);
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').trim().slice(0, 2000)}`);
  return (res.stdout ?? '').trim();
}

/**
 * A stand-in for a consumer repo: a Salesforce project on `main`, with one
 * stale tracked component, wired to a bare `origin` on the local filesystem.
 *
 * The bare remote is the whole safety story. `commitSnapshot` runs a real
 * `git push`; pointing it at a `file://` repo means the push path is executed
 * for real and lands somewhere disposable.
 */
function seedConsumerRepo() {
  const root = tmp();
  const workspace = path.join(root, 'consumer');
  const origin = path.join(root, 'origin.git');

  fs.mkdirSync(workspace, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', origin], root);
  git(['init', '-q', '-b', 'main'], workspace);
  git(['config', 'user.email', 'test@example.com'], workspace);
  git(['config', 'user.name', 'Full Retrieve Test'], workspace);

  // `sf project convert mdapi` refuses to run outside a Salesforce project
  // (RequiresProjectError) — org-verified, and the reason retrievePhase
  // preflights for this file.
  fs.writeFileSync(
    path.join(workspace, 'sfdx-project.json'),
    `${JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '62.0' }, null, 2)}\n`,
  );

  const classes = path.join(workspace, 'force-app', 'main', 'default', 'classes');
  fs.mkdirSync(classes, { recursive: true });
  fs.writeFileSync(path.join(classes, `${STALE_SENTINEL}.cls`), `public class ${STALE_SENTINEL} {}\n`);
  fs.writeFileSync(
    path.join(classes, `${STALE_SENTINEL}.cls-meta.xml`),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion></ApexClass>\n',
  );

  git(['add', '-A'], workspace);
  git(['commit', '-q', '-m', 'seed consumer repo'], workspace);
  git(['remote', 'add', 'origin', `file://${origin}`], workspace);
  git(['push', '-q', 'origin', 'main'], workspace);

  return { workspace, origin };
}

/** Surfaces the measured runtime in the job summary — the number this test exists to produce. */
function reportRuntime(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, `${markdown}\n`);
  else console.log(markdown);
}

// One retrieval, shared by every assertion below: a full org run is the
// expensive thing, and running it once per test would multiply hours.
let RUN;
async function fullRun() {
  if (RUN) return RUN;
  const { workspace, origin } = seedConsumerRepo();
  const startedAt = Date.now();

  RUN = runFullRetrieval({
    sf: createSfClient(),
    targetOrg: ORG,
    workspace,
    targetDir: path.join(workspace, 'force-app'),
    concurrency: CONCURRENCY,
    // `schedule` is the trigger the scheduled caller uses, so assert on the
    // branch name shape the scheduled path actually produces.
    eventName: 'schedule',
    push: true,
    createBranch: true,
    log: console.log,
    warn: console.warn,
  }).then((result) => {
    const elapsedMinutes = (Date.now() - startedAt) / 60000;
    return { ...result, workspace, origin, elapsedMinutes };
  });

  return RUN;
}

describe('live: full org retrieval onto a snapshot branch', { skip: skipReason(), timeout: FULL_TIMEOUT_MS }, () => {
  test('completes the whole org without ever throwing, and never as a hard error', async () => {
    const { exitCode, index, elapsedMinutes } = await fullRun();

    reportRuntime(
      [
        '### Full org retrieval (live)',
        '',
        `| Org | \`${index.targetOrg}\` (${index.orgId}) |`,
        '|---|---|',
        `| Components indexed | ${index.totalComponents} |`,
        `| Elapsed | ${elapsedMinutes.toFixed(1)} min of the ${JOB_CEILING_MINUTES}-minute budget |`,
        `| Concurrency | ${CONCURRENCY} |`,
        '',
      ].join('\n'),
    );

    // EXIT.OK or EXIT.WARN. A partial snapshot is a warning by design (see the
    // README's never-fails deviation); ERROR means nothing usable came back and
    // CONFIG means it could not start at all.
    assert.ok(
      exitCode === EXIT.OK || exitCode === EXIT.WARN,
      `full retrieval returned exit ${exitCode}; expected ${EXIT.OK} (ok) or ${EXIT.WARN} (partial)`,
    );
  });

  test('indexes the whole org, not a scoped slice', async () => {
    const { index } = await fullRun();

    assert.ok(
      index.totalComponents >= MIN_EXPECTED_COMPONENTS,
      `indexed only ${index.totalComponents} components in ${ORG}; the index has collapsed, ` +
        `or this org is too small (floor is ${MIN_EXPECTED_COMPONENTS}) to exercise a full retrieval`,
    );
    assert.ok(Object.keys(index.types).length > 20, 'a full index should cover far more than 20 metadata types');
  });

  test('splits a real org into multiple chunks, each under the 10,000-file ceiling', async () => {
    const { plan } = await fullRun();

    // If a real org fitted in one chunk the chunker would be dead code. It does
    // not: CustomObject alone weighs ~16,000 in this org.
    assert.ok(plan.chunks.length > 1, `the org planned into ${plan.chunks.length} chunk(s); chunking is not being exercised`);
    for (const chunk of plan.chunks) {
      assert.ok(
        chunk.weightTotal <= DEFAULT_MAX_WEIGHT,
        `${chunk.file} weighs ${chunk.weightTotal}, over the ${DEFAULT_MAX_WEIGHT} budget that keeps a request under 10,000 files`,
      );
    }
  });

  test('retrieves every planned chunk with nothing lost between the phases', async () => {
    const { report, reconciliation } = await fullRun();

    const failed = report.chunks.filter((c) => c.status === 'failed');
    assert.deepEqual(
      failed.map((c) => `${c.file}: ${c.error}`),
      [],
      'a chunk failed against the real org — the snapshot would be partial',
    );
    assert.ok(report.summary.succeeded > 0, 'no chunk succeeded');

    assert.equal(
      reconciliation.allIndexedPlanned,
      true,
      `${reconciliation.indexedMembers} indexed but ${reconciliation.plannedMembers} planned — members were dropped on the way into a manifest`,
    );
    assert.equal(
      reconciliation.allChunksAttempted,
      true,
      `chunks never attempted: ${reconciliation.unattemptedChunks.join(', ')}`,
    );
    assert.equal(reconciliation.retrieved, reconciliation.indexedMembers, 'not every indexed component was retrieved');
  });

  test('classifies every unretrievable type the real org produces', async () => {
    const { findings } = await fullRun();

    // known-unretrievable.json is shipped reference data, and this is the only
    // check that it still matches the org. A failure here is a documentation
    // task, not a code bug: add the type with a category, workaround and source.
    const unknown = findings.findings.filter((f) => !f.known);
    assert.deepEqual(
      unknown.map((f) => `${f.type}: ${f.error ?? 'no error text'}`),
      [],
      'the org produced unretrievable types that known-unretrievable.json does not explain — ' +
        "check the running user's permissions first, then add each with a source",
    );
  });

  test('pays no failed-chunk tax for a registry gap it already knows about', async () => {
    const { report, index } = await fullRun();

    // A type missing from the CLI's local registry does not fail alone — the
    // CLI rejects the manifest before contacting the org, so it fails every
    // member of whatever chunk it landed in, and the chunk is retried without
    // it. Org-verified: two PSS types forced two retries of a 4,983-member
    // chunk. Types in known-unretrievable.json are now dropped before the
    // index, so nothing should reach the retrieve-time fallback.
    assert.deepEqual(
      report.summary.excludedTypes,
      [],
      'a type was excluded mid-retrieve, costing a failed round trip. If it is a genuine registry gap, ' +
        'add it to known-unretrievable.json with skipBeforeRetrieval: true so the next run skips it up front',
    );

    // The flip side: the skip list must actually be doing something here, or
    // the assertion above passes for the wrong reason.
    assert.ok(
      index.skippedTypes.length > 0,
      `no known-unretrievable types were skipped in ${ORG}; the pre-retrieval filter is not being exercised`,
    );
  });

  test('creates the snapshot branch under the documented name', async () => {
    const { branch, index } = await fullRun();

    assert.ok(branch, 'no branch was created');
    assert.match(
      branch.branchName,
      /^org-snapshot\/[A-Za-z0-9]{15}\/\d{8}-\d{6}Z-schedule$/,
      `branch name does not document org, UTC timestamp and trigger: ${branch.branchName}`,
    );
    assert.ok(
      branch.branchName.includes(String(index.orgId).slice(0, 15)),
      `branch name does not name the org that was retrieved: ${branch.branchName}`,
    );
  });

  test('replaces the target tree wholesale, so org-side deletions appear as git deletions', async () => {
    const { workspace, branch } = await fullRun();

    const diff = git(['diff', '--name-status', `main..${branch.branchName}`, '--', 'force-app'], workspace);
    const deleted = diff
      .split('\n')
      .filter((l) => l.startsWith('D\t'))
      .map((l) => l.slice(2));

    assert.ok(
      deleted.some((f) => f.includes(`${STALE_SENTINEL}.cls`)),
      `${STALE_SENTINEL}.cls exists in the branch's base but not in the org, so the snapshot must delete it. ` +
        `Deletions recorded: ${deleted.length}`,
    );
  });

  test('commits a real source tree plus the run provenance', async () => {
    const { workspace, branch } = await fullRun();

    const tracked = git(['ls-tree', '-r', '--name-only', branch.branchName], workspace).split('\n');
    const sources = tracked.filter((f) => f.startsWith('force-app/'));

    assert.ok(
      sources.length >= MIN_EXPECTED_COMPONENTS,
      `only ${sources.length} files committed under force-app; a full snapshot should carry thousands`,
    );
    assert.ok(sources.some((f) => f.endsWith('.cls')), 'no Apex classes in the committed snapshot');

    // Source format is <type-dir>/... under main/default; several distinct type
    // directories is the cheap proof the merge across chunks actually merged.
    const typeDirs = new Set(
      sources.map((f) => f.split('/')[3]).filter(Boolean),
    );
    assert.ok(typeDirs.size >= 5, `only ${typeDirs.size} metadata type directories committed: ${[...typeDirs].join(', ')}`);

    for (const f of ['metadata-index-summary.md', 'retrieve-report.json', 'reconciliation.json']) {
      assert.ok(tracked.includes(`.org-snapshot/${f}`), `missing provenance file .org-snapshot/${f}`);
    }
  });

  test('pushes the branch so the ref exists on the remote', async () => {
    const { branch, origin } = await fullRun();

    assert.equal(branch.committed, true, 'the snapshot was never committed');
    assert.equal(branch.pushed, true, 'the snapshot was never pushed');
    assert.ok(branch.changedFiles > 0, 'the commit changed no files');

    // Read the ref out of the bare remote rather than trusting the return
    // value: this is the only assertion that proves the push itself landed.
    const sha = git(['--git-dir', origin, 'rev-parse', `refs/heads/${branch.branchName}`], origin);
    assert.match(sha, /^[0-9a-f]{40}$/, `origin has no ${branch.branchName}`);
  });

  test('finishes inside GitHub job ceiling', async () => {
    const { elapsedMinutes, index, plan } = await fullRun();

    console.log(
      `[full] ${index.totalComponents} components across ${plan.chunks.length} chunk(s) in ${elapsedMinutes.toFixed(1)} min`,
    );
    assert.ok(
      elapsedMinutes < JOB_CEILING_MINUTES,
      `the run took ${elapsedMinutes.toFixed(1)} min, at or over the ${JOB_CEILING_MINUTES}-minute budget the example ` +
        'caller documents — raise --max-weight, lower --concurrency, or move to a self-hosted runner',
    );
  });
});

describe('full-retrieval suite wiring', () => {
  test('stays skipped unless its own env var is set', () => {
    // ORG_METADATA_LIVE_ORG must NOT be enough to trigger a multi-hour run:
    // that variable belongs to the two-minute read-only suite.
    if (!ORG) {
      assert.match(String(skipReason()), /ORG_METADATA_FULL_RETRIEVE/);
    } else if (HAS_SF) {
      assert.equal(skipReason(), false, 'with an org and the sf CLI present the suite must actually run');
    } else {
      assert.match(String(skipReason()), /sf CLI/);
    }
  });

  test('never touches the repo it is running inside', () => {
    // This suite writes, commits and pushes for real, so "it only works in temp
    // dirs" has to be enforced rather than intended. Structural: the workspace
    // can only come from seedConsumerRepo(), which can only come from tmp().
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');

    assert.ok(/const workspace = path\.join\(root, 'consumer'\)/.test(src), 'the workspace must be built under a tmp() root');
    assert.ok(/const root = tmp\(\);/.test(src), 'seedConsumerRepo must root itself in tmp()');
    assert.ok(/fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\)/.test(src), 'tmp() must allocate under the OS temp dir');
    assert.doesNotMatch(src, /workspace: process\.cwd\(\)/, 'the retrieval must never be pointed at the checkout');
  });

  test('can only push to a local bare remote', () => {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');

    assert.ok(/'remote', 'add', 'origin', `file:\/\/\$\{origin\}`/.test(src), 'origin must be a local file:// bare repo');
    assert.doesNotMatch(src, /github\.com/, 'the suite must not reference a GitHub remote');
  });
});
