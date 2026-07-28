import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildBranchName,
  buildCommitMessage,
  triggerFor,
  startSnapshotBranch,
  commitSnapshot,
  PROVENANCE_DIR,
} from '../lib/snapshot-branch.mjs';
import { makeIndex, makeRepo, git } from './helpers.mjs';

const repos = [];
function repo(opts) {
  const r = makeRepo(opts);
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const quiet = { log: () => {}, warn: () => {} };
const report = { summary: { succeeded: 3, failed: 1, total: 4, excludedTypes: ['IdentityVerificationProcDtl'] }, chunks: [] };
const reconciliation = { retrieved: 42, indexedMembers: 50, plannedMembers: 50 };

describe('branch naming', () => {
  test('branch name encodes org, UTC timestamp and trigger', () => {
    const name = buildBranchName({
      orgId: '00D8b000000XyZaEAK',
      runId: '20260726-041500',
      trigger: 'schedule',
    });

    assert.equal(name, 'org-snapshot/00D8b000000XyZa/20260726-041500Z-schedule');
    // Each fact the name is supposed to document:
    assert.match(name, /^org-snapshot\//, 'says what it is');
    assert.match(name, /00D8b000000XyZa/, 'says which org');
    assert.match(name, /20260726-041500Z/, 'says when, in UTC');
    assert.match(name, /-schedule$/, 'says how it was started');
  });

  test('truncates an 18-character org id to 15 so the name is stable per org', () => {
    const long = buildBranchName({ orgId: '00D8b000000XyZaEAK', runId: '20260726-041500' });
    const short = buildBranchName({ orgId: '00D8b000000XyZa', runId: '20260726-041500' });
    assert.equal(long, short);
  });

  test('derives the trigger segment from the GitHub event name', () => {
    assert.equal(triggerFor('schedule'), 'schedule');
    assert.equal(triggerFor('workflow_dispatch'), 'manual');
    assert.equal(triggerFor('repository_dispatch'), 'dispatch');
    assert.equal(triggerFor(undefined), 'local');
    assert.equal(triggerFor('push'), 'manual', 'unrecognised events fall back rather than leaking into the ref');
  });

  test('sanitises a prefix that would be an invalid git ref', () => {
    const name = buildBranchName({ prefix: 'my snapshots~^:', orgId: '00D', runId: '20260726-041500' });
    assert.doesNotMatch(name, /[ ~^:]/);
    assert.match(name, /^my-snapshots\//);
  });

  test('falls back to unknown-org rather than producing a malformed ref', () => {
    assert.match(buildBranchName({ runId: '20260726-041500' }), /^org-snapshot\/unknown-org\//);
  });

  test('requires a run id', () => {
    assert.throws(() => buildBranchName({ orgId: '00D' }), /runId is required/);
  });
});

describe('commit message', () => {
  test('documents org, api version, counts and chunk outcomes', () => {
    const msg = buildCommitMessage({
      index: makeIndex({ ApexClass: ['A'] }),
      report,
      reconciliation,
      branchName: 'org-snapshot/00D/20260726-041500Z-schedule',
    });

    assert.match(msg, /^chore\(org-snapshot\): test-org @ 2026-07-26T00:00:00\.000Z/);
    assert.match(msg, /API version:\s+62\.0/);
    assert.match(msg, /Chunks:\s+3 succeeded, 1 failed, 4 total/);
    assert.match(msg, /Excluded types:\s+IdentityVerificationProcDtl/);
    assert.match(msg, /42 retrieved/);
  });
});

describe('branch lifecycle', () => {
  test('creates and commits the snapshot branch replacing force-app', () => {
    const { cwd } = repo();
    const targetDir = path.join(cwd, 'force-app');
    const branchName = 'org-snapshot/00D/20260726-041500Z-schedule';

    startSnapshotBranch({ cwd, branchName, targetDir, ...quiet });

    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd), branchName);
    assert.ok(
      !fs.existsSync(path.join(targetDir, 'main', 'default', 'classes', 'Existing.cls')),
      'the prior tree must be cleared so org deletions show as deletions',
    );

    // Stand in for the retrieve writing converted source.
    const classes = path.join(targetDir, 'main', 'default', 'classes');
    fs.mkdirSync(classes, { recursive: true });
    fs.writeFileSync(path.join(classes, 'Fresh.cls'), 'public class Fresh {}');

    const result = commitSnapshot({
      cwd,
      branchName,
      targetDir,
      index: makeIndex({ ApexClass: ['Fresh'] }),
      report,
      reconciliation,
      summaryMarkdown: '# Metadata index summary\n',
      push: false,
      ...quiet,
    });

    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    assert.ok(result.changedFiles >= 2);

    const files = git(['show', '--name-only', '--format=', 'HEAD'], cwd).split('\n');
    assert.ok(files.includes('force-app/main/default/classes/Fresh.cls'), 'new component committed');
    assert.ok(files.includes('force-app/main/default/classes/Existing.cls'), 'deleted component recorded as a deletion');
  });

  test('the branch diff against main is exactly the org drift', () => {
    const { cwd } = repo();
    const targetDir = path.join(cwd, 'force-app');
    startSnapshotBranch({ cwd, branchName: 'snap/x', targetDir, ...quiet });

    const classes = path.join(targetDir, 'main', 'default', 'classes');
    fs.mkdirSync(classes, { recursive: true });
    fs.writeFileSync(path.join(classes, 'Fresh.cls'), 'public class Fresh {}');

    commitSnapshot({
      cwd,
      branchName: 'snap/x',
      targetDir,
      index: makeIndex({ ApexClass: ['Fresh'] }),
      report,
      reconciliation,
      summaryMarkdown: '#\n',
      push: false,
      ...quiet,
    });

    const diff = git(['diff', '--name-status', 'main..snap/x', '--', 'force-app'], cwd);
    assert.match(diff, /^D\tforce-app\/main\/default\/classes\/Existing\.cls$/m, 'org deletion appears as D');
    assert.match(diff, /^A\tforce-app\/main\/default\/classes\/Fresh\.cls$/m, 'org addition appears as A');
  });

  test('commits the run provenance alongside the metadata', () => {
    const { cwd } = repo();
    const targetDir = path.join(cwd, 'force-app');
    startSnapshotBranch({ cwd, branchName: 'snap/y', targetDir, ...quiet });
    fs.mkdirSync(path.join(targetDir, 'main', 'default'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'main', 'default', 'x.txt'), 'x');

    commitSnapshot({
      cwd,
      branchName: 'snap/y',
      targetDir,
      index: makeIndex({ ApexClass: ['A'] }),
      report,
      reconciliation,
      summaryMarkdown: '# Metadata index summary\n\n- Total components: **1**\n',
      push: false,
      ...quiet,
    });

    const files = git(['show', '--name-only', '--format=', 'HEAD'], cwd).split('\n');
    assert.ok(files.includes(`${PROVENANCE_DIR}/metadata-index-summary.md`));
    assert.ok(files.includes(`${PROVENANCE_DIR}/retrieve-report.json`));
    assert.ok(files.includes(`${PROVENANCE_DIR}/reconciliation.json`));

    const recon = JSON.parse(fs.readFileSync(path.join(cwd, PROVENANCE_DIR, 'reconciliation.json'), 'utf8'));
    assert.equal(recon.org, 'test-org');
    assert.equal(recon.apiVersion, '62.0');
  });

  test('pushes the branch to origin when push is enabled', () => {
    const { cwd, origin } = repo();
    const targetDir = path.join(cwd, 'force-app');
    const branchName = 'org-snapshot/00D/20260726-041500Z-manual';

    startSnapshotBranch({ cwd, branchName, targetDir, ...quiet });
    fs.mkdirSync(path.join(targetDir, 'main', 'default'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'main', 'default', 'x.txt'), 'x');

    const result = commitSnapshot({
      cwd,
      branchName,
      targetDir,
      index: makeIndex({ ApexClass: ['A'] }),
      report,
      reconciliation,
      summaryMarkdown: '#\n',
      push: true,
      ...quiet,
    });

    assert.equal(result.pushed, true);
    assert.match(git(['ls-remote', '--heads', origin, branchName], cwd), new RegExp(branchName));
  });

  test('reports no commit rather than failing when the org tree is unchanged', () => {
    const { cwd } = repo();
    const targetDir = path.join(cwd, 'force-app');
    startSnapshotBranch({ cwd, branchName: 'snap/z', targetDir, ...quiet });

    // Put the identical tree back: the org has not drifted.
    const classes = path.join(targetDir, 'main', 'default', 'classes');
    fs.mkdirSync(classes, { recursive: true });
    fs.writeFileSync(path.join(classes, 'Existing.cls'), 'public class Existing {}');

    const args = {
      cwd,
      branchName: 'snap/z',
      targetDir,
      index: makeIndex({ ApexClass: ['Existing'] }),
      report,
      reconciliation,
      summaryMarkdown: '#\n',
      push: false,
      ...quiet,
    };

    // First call commits the provenance files (they are new).
    const first = commitSnapshot(args);
    assert.equal(first.committed, true);

    // Second call writes byte-identical content, so nothing is staged and the
    // run must report that plainly instead of failing on an empty commit.
    const second = commitSnapshot(args);
    assert.equal(second.committed, false);
    assert.equal(second.pushed, false);
    assert.equal(second.changedFiles, 0);
    assert.equal(second.branchName, 'snap/z');
  });

  test('starts a snapshot cleanly on a repo with no prior force-app tree', () => {
    const { cwd } = repo();
    fs.rmSync(path.join(cwd, 'force-app'), { recursive: true, force: true });
    git(['add', '-A'], cwd);
    git(['commit', '-qm', 'drop force-app'], cwd);

    assert.doesNotThrow(() =>
      startSnapshotBranch({ cwd, branchName: 'snap/first', targetDir: path.join(cwd, 'force-app'), ...quiet }),
    );
  });
});

// Regression: the failure that killed the first live full-org run. The
// retrieval succeeded, then commitSnapshot threw, because `git diff --cached
// --name-only` over ~30,000 staged paths produced ~2.5 MB of output and
// spawnSync's default 1 MB maxBuffer made Node kill git mid-write. `status`
// came back null, the helper read "not 0" as a git failure, and the error
// message was a megabyte of truncated file paths.
//
// Scale is the whole point of this suite, so the fixture is built to exceed
// 1 MB of PATH TEXT with as few files as possible: long, deeply nested names
// rather than 30,000 real ones. The assertion on the listing size is there so
// the test cannot quietly stop covering the bug if git's output shrinks.
describe('snapshots larger than the default spawn buffer', () => {
  const DEEP = 'd'.repeat(180);
  const NAME = 'n'.repeat(180);

  function writeWideTree(cwd, fileCount) {
    const rel = [];
    for (let i = 0; i < fileCount; i++) {
      const dir = path.join('force-app', 'main', 'default', `${DEEP}${i % 8}`, `${DEEP}${i % 4}`);
      fs.mkdirSync(path.join(cwd, dir), { recursive: true });
      const file = path.join(dir, `${NAME}${i}.cls`);
      fs.writeFileSync(path.join(cwd, file), 'public class C {}');
      rel.push(file);
    }
    return rel;
  }

  test('commits a staged listing far larger than 1 MB instead of dying on it', () => {
    const { cwd } = repo();
    const targetDir = path.join(cwd, 'force-app');

    startSnapshotBranch({ cwd, branchName: 'snap/huge', targetDir, ...quiet });
    const files = writeWideTree(cwd, 2000);

    // The bug only reproduces above 1 MB of output, so prove the fixture is
    // actually over it. +1 for each newline git prints.
    const listingBytes = files.reduce((n, f) => n + Buffer.byteLength(f) + 1, 0);
    assert.ok(
      listingBytes > 1024 * 1024,
      `fixture only produces ${listingBytes} bytes of path listing; it no longer exercises the 1 MB default`,
    );

    const result = commitSnapshot({
      cwd,
      branchName: 'snap/huge',
      targetDir,
      index: makeIndex({ ApexClass: ['A'] }),
      report,
      reconciliation,
      summaryMarkdown: '#\n',
      push: false,
      ...quiet,
    });

    assert.equal(result.committed, true, 'a large snapshot must still commit');
    assert.ok(
      result.changedFiles >= files.length,
      `only ${result.changedFiles} of ${files.length} files counted as changed`,
    );

    // And the committed tree really holds them — a count taken from a
    // truncated listing would pass the assertion above while losing files.
    const tracked = git(['ls-tree', '-r', '--name-only', 'snap/huge'], cwd).split('\n');
    assert.equal(tracked.filter((f) => f.startsWith('force-app/')).length, files.length);
  });

  test('reports a real git failure as a git failure, not as a wall of output', () => {
    const { cwd } = repo();
    // A branch name git will reject, so the error path runs on a real failure.
    assert.throws(
      () => startSnapshotBranch({ cwd, branchName: 'snap/..bad', targetDir: path.join(cwd, 'force-app'), ...quiet }),
      (err) => {
        assert.match(err.message, /^git checkout/, 'the message must name the command that failed');
        assert.ok(err.message.length < 4000, `error message is ${err.message.length} chars; it must stay readable`);
        return true;
      },
    );
  });
});
