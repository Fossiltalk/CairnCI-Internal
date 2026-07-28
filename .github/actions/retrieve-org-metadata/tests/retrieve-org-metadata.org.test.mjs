// Org-gated tests for retrieve-org-metadata.
//
// The unit suites run against a stubbed `sf` client, which proves the logic but
// cannot prove the CLAIMS ABOUT SALESFORCE the logic is built on. This suite
// checks those claims against a real org. Every assertion here corresponds to a
// behaviour the implementation depends on; if Salesforce changes one, this is
// what tells you, rather than a silently short snapshot months later.
//
// READ-ONLY. Nothing here creates a branch, commits, pushes, or writes into the
// repo's force-app tree: retrieves go to temp directories and the index is
// scoped to a handful of types. Safe against production.
//
// Never runs in CI and skips unless pointed at an org:
//
//   ORG_METADATA_LIVE_ORG=CairnCI_Production \
//     node --test .github/actions/retrieve-org-metadata/tests/*.org.test.mjs
//
// What it proves:
//   1. `unfiled$public` is a pseudo-folder — absent from the Folder object yet
//      accepted by listMetadata. This is the entire reason folder discovery
//      probes it unconditionally; without it, everything filed there is
//      silently missed (42 EmailTemplates in CairnCI_Production).
//   2. listMetadata really does cap at 3,000 rows, so `=== 3000` is a sound
//      truncation signal.
//   3. Real org weight exceeds the 10,000-file retrieve ceiling, so weighted
//      chunking is load-bearing rather than defensive — and the planner keeps
//      every chunk under it.
//   4. The two documented @salesforce/cli workarounds (retrieve via
//      --target-metadata-dir, convert from outside an sfdx-project.json tree)
//      still produce files.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSfClient } from '../lib/sf-cli.mjs';
import { runIndexPhase, FOLDER_TYPE_MAP, UNFILED_PUBLIC, LISTMETADATA_TRUNCATION_LIMIT } from '../lib/index-metadata.mjs';
import { planChunks, planManifestsPhase, DEFAULT_MAX_WEIGHT, DEFAULT_WEIGHTS } from '../lib/plan-manifests.mjs';
import { retrievePhase, reconcile } from '../lib/retrieve-metadata.mjs';
import { runPaths } from '../lib/paths.mjs';

const ORG = process.env.ORG_METADATA_LIVE_ORG || '';
// A full-org index is minutes; individual listMetadata calls are seconds.
const ORG_TIMEOUT_MS = Number(process.env.ORG_METADATA_TIMEOUT_MS || 15 * 60 * 1000);

// Resolved at module scope, not in a before() hook: node:test evaluates a
// suite's `skip` option when the suite is registered, which happens before any
// hook runs — a hook-assigned flag would always still be false there.
const HAS_SF = ORG ? spawnSync('sf', ['--version'], { encoding: 'utf8' }).status === 0 : false;

/**
 * Reason to skip, or `false` when the suite can run. It must be `false` and not
 * null/undefined: node:test treats any non-false value here as "skip", so a
 * null would silently disable the whole suite.
 */
function skipReason() {
  if (!ORG) return 'set ORG_METADATA_LIVE_ORG=<org alias> to run the org-gated tests';
  if (!HAS_SF) return 'the sf CLI is not on PATH';
  return false;
}

const quiet = { log: () => {}, warn: () => {} };
const sf = createSfClient();

let dirs = [];
function tmp(prefix = 'rom-org-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/**
 * The real client with describeMetadata narrowed to `xmlNames`. Every other
 * call still hits the org — this is the injectable seam from lib/sf-cli.mjs
 * used to keep a live test scoped to seconds instead of a full-org index.
 */
function scopedTo(xmlNames) {
  return {
    ...sf,
    async describeMetadata(targetOrg, apiVersion) {
      const real = await sf.describeMetadata(targetOrg, apiVersion);
      const wanted = new Set(xmlNames);
      return { ...real, metadataObjects: (real.metadataObjects ?? []).filter((m) => wanted.has(m.xmlName)) };
    },
  };
}

function newRunDir() {
  const d = path.join(tmp(), '20260101-000000');
  fs.mkdirSync(path.join(d, 'index'), { recursive: true });
  return d;
}

// Every `sf` call is a fresh Node process, so live tests are bounded by local
// CPU, not by the org. Measured on a laptop: four suites indexing in parallel
// at the default concurrency of 6 pushed load average past 25 and turned
// 40-second tests into 15-minute timeouts, while the org's own API limits were
// barely touched (149,773 of 151,200 daily requests still free). Hence two
// throttles — this one, and `--test-concurrency=1` in the runner (see the npm
// script and the org job in integration-retrieve-org-metadata.yml).
const ORG_INDEX_CONCURRENCY = Number(process.env.ORG_METADATA_CONCURRENCY || 2);

// Indexing is the expensive part of a live run (one listMetadata call per type,
// plus one per folder). Memoise per type-set so several assertions can share a
// single index instead of each paying for the org round trips again.
const HEAVY_TYPES = ['CustomObject', 'ApexClass', 'Layout', 'PermissionSet', 'Profile', 'Flow', 'StaticResource'];
const indexCache = new Map();
function indexOf(xmlNames) {
  const key = [...xmlNames].sort().join(',');
  if (!indexCache.has(key)) {
    indexCache.set(
      key,
      runIndexPhase({
        sf: scopedTo(xmlNames),
        targetOrg: ORG,
        runDir: newRunDir(),
        concurrency: ORG_INDEX_CONCURRENCY,
        ...quiet,
      }).then((r) => r.index),
    );
  }
  return indexCache.get(key);
}

describe('org: the unfiled$public pseudo-folder', { skip: skipReason(), timeout: ORG_TIMEOUT_MS }, () => {
  test('is absent from the Folder object but accepted by listMetadata', async () => {
    const types = Object.values(FOLDER_TYPE_MAP).map((v) => `'${v}'`).join(', ');
    const rows = await sf.query(ORG, `SELECT DeveloperName, Type FROM Folder WHERE Type IN (${types})`);

    // The claim the fix rests on: SOQL folder discovery can never find it.
    assert.ok(
      !rows.some((r) => r.DeveloperName === UNFILED_PUBLIC),
      `the Folder object now returns ${UNFILED_PUBLIC}; folder discovery may no longer need to special-case it`,
    );

    // ...yet the Metadata API accepts it as a folder for every folder-based
    // type, returning a list (possibly empty) rather than erroring.
    for (const xmlName of Object.keys(FOLDER_TYPE_MAP)) {
      const members = await sf.listMetadata(ORG, xmlName, { folder: UNFILED_PUBLIC });
      assert.ok(Array.isArray(members), `${xmlName} rejected --folder ${UNFILED_PUBLIC}`);
    }
  });

  test('holds members that folder discovery by SOQL alone would miss', async () => {
    const found = {};
    for (const xmlName of Object.keys(FOLDER_TYPE_MAP)) {
      found[xmlName] = (await sf.listMetadata(ORG, xmlName, { folder: UNFILED_PUBLIC })).length;
    }

    const total = Object.values(found).reduce((a, b) => a + b, 0);
    assert.ok(
      total > 0,
      `nothing is filed in ${UNFILED_PUBLIC} in ${ORG} (${JSON.stringify(found)}), so this org cannot exercise the gap`,
    );
  });

  test('is indexed, so its members are not silently dropped', async () => {
    const folderTypes = Object.keys(FOLDER_TYPE_MAP);
    const index = await indexOf(folderTypes);

    const unfiled = folderTypes.flatMap((t) =>
      (index.types[t]?.members ?? []).map((m) => m.fullName).filter((n) => n.startsWith(`${UNFILED_PUBLIC}/`)),
    );

    assert.ok(
      unfiled.length > 0,
      `the index found no ${UNFILED_PUBLIC}/* members — the pseudo-folder probe has regressed`,
    );
  });

  test('is not double-counted when it appears alongside real folders', async () => {
    const index = await indexOf(Object.keys(FOLDER_TYPE_MAP));

    for (const [xmlName, entry] of Object.entries(index.types)) {
      const names = entry.members.map((m) => m.fullName);
      assert.equal(new Set(names).size, names.length, `${xmlName} contains duplicate members`);
    }
  });
});

describe('org: listMetadata limits', { skip: skipReason(), timeout: ORG_TIMEOUT_MS }, () => {
  test('never returns more than the 3,000-row cap, so === 3000 is a sound truncation signal', async () => {
    // Sample the types most likely to be large in a real org.
    for (const xmlName of ['ApexClass', 'CustomField', 'Layout', 'CustomObject', 'Flow']) {
      const rows = await sf.listMetadata(ORG, xmlName);
      assert.ok(
        rows.length <= LISTMETADATA_TRUNCATION_LIMIT,
        `${xmlName} returned ${rows.length} rows, above the assumed ${LISTMETADATA_TRUNCATION_LIMIT} cap — ` +
          'truncation detection needs revisiting',
      );
    }
  });

  test('describeMetadata reports folder-based types as inFolder', async () => {
    const described = await sf.describeMetadata(ORG);
    const byName = new Map((described.metadataObjects ?? []).map((m) => [m.xmlName, m]));

    for (const xmlName of Object.keys(FOLDER_TYPE_MAP)) {
      const entry = byName.get(xmlName);
      assert.ok(entry, `${xmlName} is missing from describeMetadata`);
      assert.equal(entry.inFolder, true, `${xmlName} is no longer inFolder; folder handling may be wrong`);
    }
  });
});

describe('org: chunking against real volume', { skip: skipReason(), timeout: ORG_TIMEOUT_MS }, () => {
  test('a real org exceeds the 10,000-file ceiling, so weighted chunking is load-bearing', async () => {
    const index = await indexOf(HEAVY_TYPES);

    const weightFor = (t) => DEFAULT_WEIGHTS[t] ?? DEFAULT_WEIGHTS.default;
    const members = Object.values(index.types).reduce((n, t) => n + t.members.length, 0);
    const weight = Object.entries(index.types).reduce((n, [t, v]) => n + v.members.length * weightFor(t), 0);

    // If weight ever equalled member count, a plain count-based chunker would
    // do — and the weighting could be dropped. It does not: these few types
    // alone weigh several times their member count.
    assert.ok(weight > members, `weighted total ${weight} did not exceed member count ${members}`);
    assert.ok(
      weight > 10000,
      `only ${weight} weighted components across the heaviest types in ${ORG}; ` +
        'this org may be too small to exercise the ceiling',
    );
  });

  test('no planned chunk exceeds maxWeight, and every indexed member is placed exactly once', async () => {
    const index = await indexOf(HEAVY_TYPES);

    const chunks = planChunks(index, { maxWeight: DEFAULT_MAX_WEIGHT });
    const seen = new Set();
    for (const chunk of chunks) {
      assert.ok(chunk.weight <= DEFAULT_MAX_WEIGHT, `chunk weight ${chunk.weight} exceeds ${DEFAULT_MAX_WEIGHT}`);
      for (const [type, ms] of chunk.byType) {
        for (const m of ms) {
          const key = `${type}:${m}`;
          assert.ok(!seen.has(key), `${key} planned into more than one chunk`);
          seen.add(key);
        }
      }
    }

    const indexed = Object.values(index.types).reduce((n, t) => n + t.members.length, 0);
    assert.equal(seen.size, indexed, 'every indexed member must appear in exactly one chunk');
  });
});

describe('org: retrieve and convert round trip', { skip: skipReason(), timeout: ORG_TIMEOUT_MS }, () => {
  test('retrieves a small real chunk and converts it to source format', async () => {
    // A deliberately tiny scope: this proves the two @salesforce/cli
    // workarounds still produce files, not that the org can be fully exported.
    //
    // The type must have real CONTENT, not merely exist. A container type like
    // CustomLabels retrieves as a valid-but-empty <CustomLabels/> in an org
    // with no labels, and converts to zero files — which is correct behaviour
    // and useless as a fixture.
    const runDir = newRunDir();
    const { index } = await runIndexPhase({
      sf: scopedTo(['ApexClass']),
      targetOrg: ORG,
      runDir,
      ...quiet,
    });

    assert.ok(index.types.ApexClass.members.length >= 2, 'org needs at least two ApexClasses for this fixture');

    // Narrow the index to two members so the retrieve is seconds, not minutes,
    // while still exercising the real retrieve -> convert path end to end.
    const sample = index.types.ApexClass.members.slice(0, 2);
    const small = { ...index, types: { ApexClass: { ...index.types.ApexClass, count: 2, members: sample } } };
    fs.writeFileSync(runPaths(runDir).indexFile, JSON.stringify(small));

    const total = sample.length;
    planManifestsPhase({ runDir, ...quiet });
    const plan = JSON.parse(fs.readFileSync(runPaths(runDir).manifestPlanFile, 'utf8'));

    const targetDir = path.join(tmp(), 'out');

    // cwd for the CLI must be INSIDE a Salesforce project or `convert mdapi`
    // refuses to run (RequiresProjectError) — org-verified. The staging
    // --root-dir must simultaneously be OUTSIDE one, which retrievePhase
    // already arranges by staging under the OS temp dir.
    const workspace = tmp();
    fs.writeFileSync(
      path.join(workspace, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [{ path: 'force-src', default: true }], sourceApiVersion: '67.0' }),
    );

    const { report } = await retrievePhase({
      sf,
      runDir,
      targetDir,
      workspace,
      waitMinutes: 10,
      ...quiet,
    });

    assert.equal(report.summary.failed, 0, `chunk(s) failed: ${JSON.stringify(report.chunks, null, 2)}`);
    assert.ok(report.summary.succeeded > 0);

    // The retrieve+convert actually wrote source-format files. The CLI appends
    // main/default to --output-dir itself, so assert on the full shape.
    const classesDir = path.join(targetDir, 'main', 'default', 'classes');
    const written = fs.existsSync(classesDir) ? fs.readdirSync(classesDir) : [];
    assert.ok(
      written.some((f) => f.endsWith('.cls')),
      `convert mdapi produced no .cls files under ${classesDir} (found: ${JSON.stringify(written)})`,
    );
    for (const m of sample) {
      assert.ok(written.includes(`${m.fullName}.cls`), `${m.fullName}.cls missing from the converted output`);
    }

    const r = reconcile(small, plan, report);
    assert.equal(r.allIndexedPlanned, true);
    assert.equal(r.allChunksAttempted, true);
    assert.equal(r.retrieved, total);
  });
});

describe('org-gated suite wiring', () => {
  test('the suite is skipped without an org and enabled with one', () => {
    // Guards the guard, in both directions: a skipReason() that never returns a
    // reason would run org calls in CI (no org secret there), and one that
    // returns a truthy value when an org IS configured would silently disable
    // the whole suite — node:test skips on anything that is not exactly false.
    if (!ORG) {
      assert.match(String(skipReason()), /ORG_METADATA_LIVE_ORG/);
    } else if (HAS_SF) {
      assert.equal(skipReason(), false, 'with an org and the sf CLI present, the suite must actually run');
    } else {
      assert.match(String(skipReason()), /sf CLI/);
    }
  });

  test('the org suite cannot create a branch, commit, or push', () => {
    // Structural, not textual: this file can only reach the git-writing code
    // paths by importing them, so scan the import block. (Scanning the test
    // bodies instead would match this assertion's own source.)
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    const imports = src.slice(0, src.indexOf('const ORG ='));

    for (const forbidden of ['snapshot-branch.mjs', 'retrieve-org-metadata.mjs']) {
      assert.ok(!imports.includes(forbidden), `org tests must not import ${forbidden} — it creates branches and pushes`);
    }
    assert.ok(!/\bspawnSync\(\s*['"]git['"]/.test(src), 'org tests must not shell out to git');
  });

  test('the org suite never writes into the repo working tree', () => {
    // Every org test writes to mkdtemp dirs. A retrieve pointed at the repo's
    // own source dir would clobber tracked files, so assert it by name.
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    assert.doesNotMatch(src, /['"`]force-app['"`]/, 'org tests must not name the repo source dir');
    // targetDir and workspace must always be temp paths.
    assert.ok(/targetDir = path\.join\(tmp\(\)/.test(src), 'the retrieve target must come from tmp()');
    assert.ok(/const workspace = tmp\(\)/.test(src), 'the retrieve workspace must come from tmp()');
    assert.ok(/runDir: newRunDir\(\)/.test(src), 'index run dirs must come from tmp() via newRunDir()');
  });
});
