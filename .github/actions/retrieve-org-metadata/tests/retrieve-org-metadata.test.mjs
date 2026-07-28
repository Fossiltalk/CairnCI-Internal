import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import fsSync from 'node:fs';
import { runFullRetrieval, exitCodeFor, EXIT } from '../lib/retrieve-org-metadata.mjs';
import { reconcile, hasSfdxProject } from '../lib/retrieve-metadata.mjs';
import { runPaths } from '../lib/paths.mjs';
import { makeStubSf, makeRepo, git } from './helpers.mjs';

const repos = [];
function repo() {
  const r = makeRepo();
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const quiet = { log: () => {}, warn: () => {} };
const members = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}_${i}`);

function run(cwd, org, overrides = {}) {
  return runFullRetrieval({
    sf: makeStubSf(org),
    targetOrg: 'test-org',
    workspace: cwd,
    targetDir: path.join(cwd, 'force-app'),
    maxWeight: 100,
    push: false,
    now: new Date('2026-07-26T04:15:00Z'),
    ...quiet,
    ...overrides,
  });
}

describe('full retrieval run', () => {
  test('every indexed member appears in exactly one chunk manifest', async () => {
    const { cwd } = repo();
    const org = { types: { ApexClass: members('Cls', 250), Flow: members('Flw', 90) } };

    const result = await run(cwd, org);

    const seen = new Set();
    for (const chunk of result.plan.chunks) {
      const sidecar = JSON.parse(
        fs.readFileSync(path.join(runPaths(result.runDir).manifestsDir, chunk.jsonFile), 'utf8'),
      );
      for (const g of sidecar.typeGroups) {
        for (const m of g.members) {
          const key = `${g.type}:${m}`;
          assert.ok(!seen.has(key), `${key} planned into more than one chunk`);
          seen.add(key);
        }
      }
    }

    assert.equal(seen.size, 340, 'all 340 indexed members must be planned');
    for (const member of members('Cls', 250)) assert.ok(seen.has(`ApexClass:${member}`));
    for (const member of members('Flw', 90)) assert.ok(seen.has(`Flow:${member}`));
  });

  test('reconciles the retrieve report against the index with no unaccounted members', async () => {
    const { cwd } = repo();
    const org = { types: { ApexClass: members('Cls', 250), CustomObject: members('Obj', 3) } };

    const result = await run(cwd, org);
    const r = result.reconciliation;

    assert.equal(r.indexedMembers, 253);
    assert.equal(r.plannedMembers, 253, 'nothing indexed may be dropped on the way into a manifest');
    assert.equal(r.attempted, 253, 'every planned member must be attempted');
    assert.equal(r.retrieved, 253);
    assert.equal(r.failedMembers, 0);
    assert.equal(r.allIndexedPlanned, true);
    assert.equal(r.allChunksAttempted, true);
    assert.deepEqual(r.unattemptedChunks, []);
  });

  test('attempts every planned chunk', async () => {
    const { cwd } = repo();
    const org = { types: { ApexClass: members('Cls', 500) } };

    const result = await run(cwd, org);

    assert.ok(result.plan.chunkCount >= 5, 'maxWeight 100 over 500 members must produce several chunks');
    assert.equal(result.report.chunks.length, result.plan.chunkCount, 'each planned chunk must appear in the report');
    const reported = result.report.chunks.map((c) => c.file).sort();
    const planned = result.plan.chunks.map((c) => c.file).sort();
    assert.deepEqual(reported, planned);
  });

  test('continues to remaining chunks after a chunk fails', async () => {
    const { cwd } = repo();
    let calls = 0;
    const org = {
      types: { ApexClass: members('Cls', 500) },
      onRetrieve: () => {
        calls++;
        if (calls === 2) throw new Error('RETRIEVE_FAILED: org said no');
      },
    };

    const result = await run(cwd, org);

    assert.equal(result.report.summary.failed, 1);
    assert.ok(result.report.summary.succeeded >= 4, 'the other chunks must still have run');
    assert.equal(result.report.chunks.length, result.plan.chunkCount, 'a failure must not stop later chunks');
    assert.equal(result.reconciliation.allChunksAttempted, true);
    assert.equal(result.exitCode, EXIT.WARN, 'a partial snapshot is a warning, never an error');
    assert.equal(result.branch.committed, true, 'a partial snapshot is still committed');
  });

  test('survives a type the installed sf CLI does not know, excluding it and retrying', async () => {
    const { cwd } = repo();
    const seen = new Set();
    const org = {
      types: { ApexClass: members('Cls', 50), IdentityVerificationProcDtl: members('Ivp', 5) },
      onRetrieve: (manifestPath) => {
        const xml = fs.readFileSync(manifestPath, 'utf8');
        if (xml.includes('IdentityVerificationProcDtl') && !seen.has(manifestPath)) {
          seen.add(manifestPath);
          throw new Error("Missing metadata type definition in registry for id 'IdentityVerificationProcDtl'");
        }
      },
    };

    const result = await run(cwd, org);

    assert.ok(
      result.report.summary.excludedTypes.includes('IdentityVerificationProcDtl'),
      'the unknown type must be recorded as excluded',
    );
    assert.equal(result.report.summary.failed, 0, 'excluding the bad type must rescue the chunk');
    assert.ok(
      result.findings.findings.some((f) => f.type === 'IdentityVerificationProcDtl' && f.known),
      'the exclusion must be explained from known-unretrievable.json',
    );
  });

  test('records an unlistable type as an unexplained finding without aborting', async () => {
    const { cwd } = repo();
    const org = {
      types: { ApexClass: members('Cls', 20), MysteryType__x: [] },
      listErrors: { MysteryType__x: 'INSUFFICIENT_ACCESS: not visible to this user' },
    };

    const result = await run(cwd, org);

    assert.equal(result.report.summary.succeeded > 0, true, 'the rest of the org still retrieves');
    const mystery = result.findings.findings.find((f) => f.type === 'MysteryType__x');
    assert.ok(mystery, 'the failure must be reported');
    assert.equal(mystery.known, false);
    assert.match(mystery.workaround, /permission/i);
    assert.equal(result.exitCode, EXIT.WARN);
  });

  test('creates a snapshot branch named for when and how the run happened', async () => {
    const { cwd } = repo();
    const org = { id: '00D8b000000XyZaEAK', types: { ApexClass: members('Cls', 20) } };

    const result = await run(cwd, org, { eventName: 'schedule' });

    assert.equal(result.branch.branchName, 'org-snapshot/00D8b000000XyZa/20260726-041500Z-schedule');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd), result.branch.branchName);
    assert.equal(result.branch.committed, true);
    assert.match(git(['log', '-1', '--format=%s'], cwd), /^chore\(org-snapshot\): test-org/);
  });

  test('names the branch manual for a workflow_dispatch run', async () => {
    const { cwd } = repo();
    const result = await run(cwd, { types: { ApexClass: ['A'] } }, { eventName: 'workflow_dispatch' });
    assert.match(result.branch.branchName, /-manual$/);
  });

  test('stops after planning when skipRetrieve is set', async () => {
    const { cwd } = repo();
    const result = await run(cwd, { types: { ApexClass: members('Cls', 50) } }, { skipRetrieve: true });

    assert.equal(result.report, null);
    assert.ok(result.plan.chunkCount > 0, 'manifests are still built');
    assert.equal(result.branch, null, 'no branch is created for a plan-only run');
    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd), 'main');
  });

  test('leaves the working branch alone when createBranch is false', async () => {
    const { cwd } = repo();
    const result = await run(cwd, { types: { ApexClass: ['A'] } }, { createBranch: false });
    assert.equal(result.branch, null);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd), 'main');
  });

  test('requires an sf client and a target org', async () => {
    await assert.rejects(() => runFullRetrieval({ targetOrg: 'o' }), /sf client is required/);
    await assert.rejects(
      () => runFullRetrieval({ sf: makeStubSf({ types: {} }) }),
      /targetOrg is required/,
    );
  });
});

describe('reconciliation', () => {
  test('flags a planned chunk that was never attempted', () => {
    const index = { types: { ApexClass: { members: [{ fullName: 'A' }, { fullName: 'B' }] } } };
    const plan = {
      chunks: [
        { file: 'package-chunk-001.xml', memberCount: 1 },
        { file: 'package-chunk-002.xml', memberCount: 1 },
      ],
    };
    const report = { chunks: [{ file: 'package-chunk-001.xml', status: 'succeeded' }] };

    const r = reconcile(index, plan, report);

    assert.deepEqual(r.unattemptedChunks, ['package-chunk-002.xml']);
    assert.equal(r.allChunksAttempted, false);
    assert.equal(r.attempted, 1);
  });

  test('flags indexed members that never made it into a manifest', () => {
    const index = { types: { ApexClass: { members: [{ fullName: 'A' }, { fullName: 'B' }, { fullName: 'C' }] } } };
    const plan = { chunks: [{ file: 'package-chunk-001.xml', memberCount: 2 }] };
    const report = { chunks: [{ file: 'package-chunk-001.xml', status: 'succeeded' }] };

    const r = reconcile(index, plan, report);

    assert.equal(r.indexedMembers, 3);
    assert.equal(r.plannedMembers, 2);
    assert.equal(r.allIndexedPlanned, false);
  });

  test('counts members of a failed chunk as failed, not retrieved', () => {
    const index = { types: { ApexClass: { members: [{ fullName: 'A' }, { fullName: 'B' }] } } };
    const plan = {
      chunks: [
        { file: 'package-chunk-001.xml', memberCount: 1 },
        { file: 'package-chunk-002.xml', memberCount: 1 },
      ],
    };
    const report = {
      chunks: [
        { file: 'package-chunk-001.xml', status: 'succeeded' },
        { file: 'package-chunk-002.xml', status: 'failed' },
      ],
    };

    const r = reconcile(index, plan, report);
    assert.equal(r.retrieved, 1);
    assert.equal(r.failedMembers, 1);
  });
});

// Org-verified: `sf project convert mdapi` returns RequiresProjectError when
// cwd is not inside a Salesforce project, so every chunk would retrieve fine
// and then fail at conversion. Because this tool never fails the job, that
// would surface as an empty snapshot with a vague warning — hence a preflight.
describe('sfdx project preflight', () => {
  test('detects an sfdx-project.json at the workspace root', () => {
    const { cwd } = repo();
    assert.equal(hasSfdxProject(cwd), false, 'the fixture repo has none');
    fsSync.writeFileSync(path.join(cwd, 'sfdx-project.json'), '{"packageDirectories":[]}');
    assert.equal(hasSfdxProject(cwd), true);
  });

  test('finds one in an ancestor directory, since the CLI searches upward', () => {
    const { cwd } = repo();
    fsSync.writeFileSync(path.join(cwd, 'sfdx-project.json'), '{"packageDirectories":[]}');
    const nested = path.join(cwd, 'a', 'b', 'c');
    fsSync.mkdirSync(nested, { recursive: true });
    assert.equal(hasSfdxProject(nested), true);
  });

  test('warns once, up front, when the workspace is not a Salesforce project', async () => {
    const { cwd } = repo();
    const warnings = [];
    await run(cwd, { types: { ApexClass: ['A'] } }, { warn: (m) => warnings.push(String(m)) });

    const preflight = warnings.filter((w) => /no sfdx-project\.json/.test(w));
    assert.equal(preflight.length, 1, 'exactly one preflight warning, not one per chunk');
    assert.match(preflight[0], /RequiresProjectError/);
    assert.match(preflight[0], /convert mdapi/);
  });

  test('stays quiet when the workspace is a Salesforce project', async () => {
    const { cwd } = repo();
    fsSync.writeFileSync(path.join(cwd, 'sfdx-project.json'), '{"packageDirectories":[]}');
    const warnings = [];
    await run(cwd, { types: { ApexClass: ['A'] } }, { warn: (m) => warnings.push(String(m)) });

    assert.equal(warnings.filter((w) => /no sfdx-project\.json/.test(w)).length, 0);
  });
});

describe('exit codes', () => {
  const clean = { allChunksAttempted: true, allIndexedPlanned: true };
  const noFindings = { knownCount: 0, unknownCount: 0 };

  test('a fully clean run exits 0', () => {
    const code = exitCodeFor({
      report: { summary: { succeeded: 3, failed: 0, total: 3 } },
      reconciliation: clean,
      findings: noFindings,
    });
    assert.equal(code, EXIT.OK);
  });

  test('a partial run warns rather than erroring', () => {
    const code = exitCodeFor({
      report: { summary: { succeeded: 2, failed: 1, total: 3 } },
      reconciliation: clean,
      findings: noFindings,
    });
    assert.equal(code, EXIT.WARN);
  });

  test('a run where nothing at all came back is an error', () => {
    assert.equal(
      exitCodeFor({ report: { summary: { succeeded: 0, failed: 3, total: 3 } }, reconciliation: clean, findings: noFindings }),
      EXIT.ERROR,
    );
    assert.equal(exitCodeFor({ report: null, reconciliation: clean, findings: noFindings }), EXIT.ERROR);
  });

  test('unretrievable findings warn even when every chunk succeeded', () => {
    const code = exitCodeFor({
      report: { summary: { succeeded: 3, failed: 0, total: 3 } },
      reconciliation: clean,
      findings: { knownCount: 1, unknownCount: 0 },
    });
    assert.equal(code, EXIT.WARN);
  });
});
