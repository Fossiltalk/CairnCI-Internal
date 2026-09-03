// End-to-end tests that spawn retrieve.mjs as a real child process, and
// exercise the composite action's exit-code remap the same way GitHub does.
//
// The `sf` CLI is stubbed by putting a fake `sf` executable first on PATH, so
// nothing here touches an org or the network.
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { triggerFor } from '../lib/snapshot-branch.mjs';
import { makeRepo, git, tempDir } from './helpers.mjs';

const ACTION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ACTION_DIR, 'retrieve.mjs');

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function repo() {
  const r = makeRepo();
  cleanups.push(r.cleanup);
  return r;
}

/**
 * Writes a fake `sf` onto PATH. `behavior` is a JS snippet evaluated with the
 * subcommand available as `cmd` — it prints the CLI's own --json envelope.
 */
function stubSfOnPath({ failRetrieve = false, failRetrieveAfter = null, listErrors = {} } = {}) {
  const dir = tempDir('rom-bin-');
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const cmd = argv.filter((a) => !a.startsWith('--')).join(' ');
const listErrors = ${JSON.stringify(listErrors)};
const ok = (result) => { process.stdout.write(JSON.stringify({ status: 0, result })); process.exit(0); };
const err = (message) => { process.stdout.write(JSON.stringify({ status: 1, message })); process.exit(1); };

if (cmd.startsWith('org display')) ok({ id: '00D8b000000XyZaEAK', apiVersion: '62.0' });
if (cmd.startsWith('org list metadata-types')) ok({ metadataObjects: [{ xmlName: 'ApexClass', childXmlNames: [] }, { xmlName: 'Flow', childXmlNames: [] }] });
if (cmd.startsWith('org list metadata')) {
  const type = arg('--metadata-type');
  if (listErrors[type]) err(listErrors[type]);
  const n = type === 'ApexClass' ? 6 : 3;
  ok(Array.from({ length: n }, (_, i) => ({ fullName: type + '_' + i, lastModifiedDate: '2026-01-01T00:00:00.000Z' })));
}
if (cmd.startsWith('data query')) ok({ records: [] });
if (cmd.startsWith('project retrieve start')) {
  ${failRetrieve ? "err('RETRIEVE_FAILED: simulated org failure');" : ''}
  ${
    failRetrieveAfter === null
      ? ''
      : `// Succeed for the first N chunks, then fail — a PARTIAL retrieval.
  const counter = path.join(require('node:os').tmpdir(), 'rom-retrieve-count-' + process.env.ROM_RUN_ID);
  const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(seen + 1));
  if (seen >= ${failRetrieveAfter}) err('RETRIEVE_FAILED: simulated failure on chunk ' + (seen + 1));`
  }
  fs.mkdirSync(path.join(arg('--target-metadata-dir'), 'unpackaged', 'unpackaged'), { recursive: true });
  ok({});
}
if (cmd.startsWith('project convert mdapi')) {
  const out = path.join(arg('--output-dir'), 'main', 'default', 'classes');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'Retrieved' + Date.now() + Math.random() + '.cls'), 'public class C {}');
  ok({});
}
err('unexpected sf invocation: ' + cmd);
`;
  const file = path.join(dir, 'sf');
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return dir;
}

function runCli(cwd, { args = [], env = {}, stubOptions } = {}) {
  const binDir = stubSfOnPath(stubOptions);
  const outputs = path.join(cwd, '.gh-output');
  const summary = path.join(cwd, '.gh-summary');
  fs.writeFileSync(outputs, '');
  fs.writeFileSync(summary, '');

  const res = spawnSync(process.execPath, [CLI, '--push', 'false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      ROM_RUN_ID: `${process.pid}-${Math.random().toString(36).slice(2)}`,
      ...env,
    },
  });

  const parsedOutputs = Object.fromEntries(
    fs
      .readFileSync(outputs, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );

  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    outputs: parsedOutputs,
    summary: fs.readFileSync(summary, 'utf8'),
  };
}

describe('argument parsing', () => {
  test('accepts --key value, --key=value and bare boolean flags', () => {
    const args = parseArgs(['--target-org', 'prod', '--max-weight=500', '--keep-staging', '--push', 'false']);
    assert.equal(args['target-org'], 'prod');
    assert.equal(args['max-weight'], '500');
    assert.equal(args['keep-staging'], true);
    assert.equal(args.push, 'false');
  });
});

describe('trigger derivation', () => {
  test('derives the trigger segment from GITHUB_EVENT_NAME schedule and workflow_dispatch', () => {
    // Both entry points the tool supports: a cron schedule and a manual run.
    assert.equal(triggerFor('schedule'), 'schedule');
    assert.equal(triggerFor('workflow_dispatch'), 'manual');
  });

  test('a scheduled run names its branch schedule', () => {
    const { cwd } = repo();
    const result = runCli(cwd, { env: { GITHUB_EVENT_NAME: 'schedule' } });
    assert.match(result.outputs['branch-name'], /^org-snapshot\/00D8b000000XyZa\/\d{8}-\d{6}Z-schedule$/);
  });

  test('a manually dispatched run names its branch manual', () => {
    const { cwd } = repo();
    const result = runCli(cwd, { env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } });
    assert.match(result.outputs['branch-name'], /Z-manual$/);
  });

  test('the shipped example caller is runnable both on a schedule and manually', () => {
    // examples/ publishes to CairnCI-Public alongside this action, so the
    // relative path holds in both repos.
    const caller = path.join(ACTION_DIR, '..', '..', '..', 'examples', 'caller-retrieve-org-metadata.yml');
    assert.ok(fs.existsSync(caller), 'the example caller must ship with the tool');

    const yml = fs.readFileSync(caller, 'utf8');
    const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));

    assert.match(on, /^\s+schedule:/m, 'must declare a cron schedule trigger');
    assert.match(on, /^\s+- cron: "[^"]+"/m, 'the schedule needs an actual cron expression');
    assert.match(on, /^\s+workflow_dispatch:/m, 'must declare a manual trigger');
    assert.match(yml, /uses: Fossiltalk\/CairnCI-Public\/\.github\/actions\/retrieve-org-metadata@v1/);
    // The tool pushes a branch, so the caller must grant write.
    assert.match(yml, /^permissions:\n\s+contents: write\b/m);
  });
});

describe('CLI end to end', () => {
  test('retrieves an org onto a new branch and exits 0', () => {
    const { cwd } = repo();
    const result = runCli(cwd, { env: { GITHUB_EVENT_NAME: 'schedule' } });

    assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.outputs['total-components'], '9', '6 ApexClass + 3 Flow');
    assert.equal(result.outputs['chunks-failed'], '0');
    assert.ok(Number(result.outputs['chunks-succeeded']) >= 1);

    const branch = result.outputs['branch-name'];
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd), branch);
    assert.match(git(['log', '-1', '--format=%s'], cwd), /chore\(org-snapshot\)/);
  });

  test('writes a job summary describing the run', () => {
    const { cwd } = repo();
    const result = runCli(cwd);

    assert.match(result.summary, /## Full Org Metadata Retrieval/);
    assert.match(result.summary, /\| Components indexed \| 9 \|/);
    assert.match(result.summary, /Metadata API ceiling is 10,000 files\/request/);
    assert.match(result.summary, /### Unretrievable metadata/);
  });

  test('exits 10 and still commits the branch when only some chunks fail', () => {
    const { cwd } = repo();
    // 9 components at max weight 2 plans several chunks; the first two
    // succeed and the rest fail — a genuinely partial retrieval.
    const result = runCli(cwd, { stubOptions: { failRetrieveAfter: 2 }, args: ['--max-weight', '2'] });

    assert.equal(result.code, 10, 'a partial snapshot warns rather than erroring');
    assert.equal(result.outputs['chunks-succeeded'], '2');
    assert.ok(Number(result.outputs['chunks-failed']) > 0, 'some chunks must have failed');
    assert.match(result.stdout, /::warning::Chunk package-chunk-\d+\.xml failed/);
    assert.doesNotMatch(result.stdout, /::error::/, 'this tool never emits an error annotation');
    assert.match(result.summary, /#### Failed chunks/);

    // The partial snapshot is still committed — that is the whole contract.
    assert.match(result.outputs['branch-name'], /^org-snapshot\//);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd), result.outputs['branch-name']);
    assert.match(git(['log', '-1', '--format=%s'], cwd), /chore\(org-snapshot\)/);
  });

  test('exits 1 only when nothing at all could be retrieved', () => {
    const { cwd } = repo();
    const result = runCli(cwd, { stubOptions: { failRetrieve: true }, args: ['--max-weight', '2'] });

    assert.equal(result.code, 1, 'nothing retrieved at all is the one error case');
    assert.match(result.stdout, /::warning::/);
    assert.doesNotMatch(result.stdout, /::error::/);
  });

  test('warns rather than failing when a single type cannot be listed', () => {
    const { cwd } = repo();
    const result = runCli(cwd, { stubOptions: { listErrors: { Flow: 'INSUFFICIENT_ACCESS: not visible' } } });

    assert.equal(result.code, 10, 'a partial snapshot is a warn, not an error');
    assert.match(result.stdout, /::warning::Flow could not be retrieved and is not a documented limitation/);
    assert.match(result.stdout, /check the running user's permissions first/);
    assert.match(result.summary, /#### Unexplained \(1\)/);
    assert.equal(result.outputs['types-unretrievable'], 'Flow');
  });

  test('emits no ::error:: annotation on any path', () => {
    const { cwd } = repo();
    for (const stubOptions of [{}, { listErrors: { Flow: 'boom' } }, { failRetrieve: true }]) {
      const result = runCli(cwd, { stubOptions, args: ['--create-branch', 'false'] });
      assert.doesNotMatch(result.stdout, /::error::/, `::error:: emitted with ${JSON.stringify(stubOptions)}`);
    }
  });

  test('exits 2 with a warning when the org session is unusable', () => {
    const { cwd } = repo();
    // No stub on PATH at all: `sf` cannot be spawned.
    const res = spawnSync(process.execPath, [CLI, '--push', 'false'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent' },
    });

    assert.equal(res.status, 2, 'config/env problems are exit 2');
    assert.match(res.stdout, /::warning::Full Org Metadata Retrieval could not run/);
    assert.doesNotMatch(res.stdout, /::error::/);
  });

  test('honours --skip-retrieve without creating a branch', () => {
    const { cwd } = repo();
    const result = runCli(cwd, { args: ['--skip-retrieve', 'true'] });

    assert.equal(result.code, 0);
    assert.equal(result.outputs['branch-name'], '');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd), 'main');
  });

  test('honours --max-weight by splitting into more chunks', () => {
    const { cwd } = repo();
    const wide = runCli(repo().cwd, { args: ['--max-weight', '100'] });
    const narrow = runCli(cwd, { args: ['--max-weight', '2'] });

    assert.ok(
      Number(narrow.outputs['chunks-succeeded']) > Number(wide.outputs['chunks-succeeded']),
      'a smaller max weight must produce more chunks',
    );
  });
});

/**
 * Runs the REAL shell from action.yml's composite step, with the `node
 * retrieve.mjs ...` invocation swapped for a bare `exit <code>`. This is not a
 * reimplementation of the remap — if the YAML's shell logic changes, this
 * breaks. That matters because the never-fail contract lives in that shell.
 */
function compositeRemap(code, failOnError) {
  const yml = fs.readFileSync(path.join(ACTION_DIR, 'action.yml'), 'utf8');

  const runBlock = yml.split(/^ {6}run: \|\n/m)[1];
  assert.ok(runBlock, 'could not find the composite run: block in action.yml');

  const script = runBlock
    .split('\n')
    .map((line) => line.replace(/^ {8}/, ''))
    // The multi-line `node ... \` invocation becomes a plain exit.
    .join('\n')
    .replace(/node "\$\{\{ github\.action_path \}\}\/retrieve\.mjs"(?:[^\n]*\\\n)*[^\n]*\n/, `( exit ${code} )\n`);

  assert.doesNotMatch(script, /retrieve\.mjs/, 'the node invocation should have been replaced');
  assert.match(script, /FAIL_ON_ERROR/, 'the extracted script must still contain the remap');

  const res = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, FAIL_ON_ERROR: failOnError },
  });
  return { exit: res.status, warned: /::warning::/.test(res.stdout ?? '') };
}

describe('composite action exit-code contract', () => {
  test('composite remaps a nonzero CLI exit to 0 with a warning when fail-on-error is false', () => {
    for (const code of [1, 2, 10]) {
      const result = compositeRemap(code, 'false');
      assert.equal(result.exit, 0, `exit ${code} must not fail the job`);
      assert.equal(result.warned, true, `exit ${code} must produce a warning`);
    }
  });

  test('composite propagates the failure when fail-on-error is true', () => {
    for (const code of [1, 2, 10]) {
      assert.equal(compositeRemap(code, 'true').exit, code);
    }
  });

  test('action.yml actually implements that remap', () => {
    const yml = fs.readFileSync(path.join(ACTION_DIR, 'action.yml'), 'utf8');
    assert.match(yml, /name: "Tool: Full Org Metadata Retrieval"/);
    assert.match(yml, /if \[ "\$code" -ne 0 \] && \[ "\$FAIL_ON_ERROR" != "true" \]; then/);
    assert.match(yml, /echo "::warning::Full Org Metadata Retrieval finished with issues/);
    assert.match(yml, /^\s+exit 0$/m);
    assert.doesNotMatch(yml, /::error::/, 'the action must not emit error annotations');
  });

  test('the action declares no credential inputs', () => {
    const yml = fs.readFileSync(path.join(ACTION_DIR, 'action.yml'), 'utf8');
    for (const forbidden of ['sfdx-auth-url', 'auth-url', 'client-secret', 'private-key', 'password', 'consumer-key']) {
      assert.doesNotMatch(yml.toLowerCase(), new RegExp(`^\\s+${forbidden}:`, 'm'), `must not declare ${forbidden}`);
    }
  });

  test('the action ships no run.sh, because admin tools are not caller phases', () => {
    assert.ok(!fs.existsSync(path.join(ACTION_DIR, 'run.sh')));
  });
});
