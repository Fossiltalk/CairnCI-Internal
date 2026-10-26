import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planChunks, planManifestsPhase, DEFAULT_MAX_WEIGHT, DEFAULT_WEIGHTS } from '../lib/plan-manifests.mjs';
import { runPaths } from '../lib/paths.mjs';
import { makeIndex, tempDir } from './helpers.mjs';

const roots = [];
function seededRunDir(index) {
  const root = tempDir();
  roots.push(root);
  const dir = path.join(root, '20260726-041500');
  fs.mkdirSync(path.join(dir, 'index'), { recursive: true });
  fs.writeFileSync(runPaths(dir).indexFile, JSON.stringify(index));
  return dir;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

const quiet = { log: () => {} };
const members = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}_${i}`);
const weightOf = (chunk, weights = DEFAULT_WEIGHTS) =>
  [...chunk.byType.entries()].reduce((sum, [type, ms]) => sum + ms.length * (weights[type] ?? weights.default), 0);

describe('chunk planning', () => {
  test('no chunk exceeds maxWeight', () => {
    // 40,000 raw members which, weighted, come to well over 100,000 — far past
    // the Metadata API's 10,000-file ceiling for a single retrieve.
    const index = makeIndex({
      ApexClass: members('Cls', 12000),
      CustomObject: members('Obj', 4000), // weight 20 each = 80,000
      PermissionSet: members('Ps', 3000), // weight 5 each = 15,000
      Layout: members('Lay', 21000),
    });

    const chunks = planChunks(index, { maxWeight: DEFAULT_MAX_WEIGHT });

    assert.ok(chunks.length > 1, 'a 100k-weight org must not plan into one chunk');
    for (const chunk of chunks) {
      assert.ok(
        chunk.weight <= DEFAULT_MAX_WEIGHT,
        `chunk weight ${chunk.weight} exceeds maxWeight ${DEFAULT_MAX_WEIGHT}`,
      );
      assert.equal(chunk.weight, weightOf(chunk), 'recorded weight must match its contents');
    }
  });

  test('maxWeight stays under the 10,000-file Metadata API ceiling by default', () => {
    assert.ok(DEFAULT_MAX_WEIGHT < 10000, 'default must leave headroom under the hard API cap');
  });

  test('keeps each type in a single chunk unless the type alone exceeds maxWeight', () => {
    const index = makeIndex({
      ApexClass: members('Cls', 4000),
      Flow: members('Flw', 3000),
      Layout: members('Lay', 1500),
      StaticResource: members('Sr', 400),
    });

    const chunks = planChunks(index, { maxWeight: DEFAULT_MAX_WEIGHT });

    // Every type here fits in one chunk on its own, so none may be split.
    const chunksPerType = new Map();
    for (const chunk of chunks) {
      for (const type of chunk.byType.keys()) {
        chunksPerType.set(type, (chunksPerType.get(type) ?? 0) + 1);
      }
    }
    for (const [type, count] of chunksPerType) {
      assert.equal(count, 1, `${type} was split across ${count} chunks but fits in one`);
    }
    for (const chunk of chunks) assert.equal(chunk.splitTypes.size, 0);
  });

  test('splits only the type that alone exceeds maxWeight, and records the split', () => {
    const index = makeIndex({
      ApexClass: members('Cls', 25000), // 25,000 > 9,000: must split
      Flow: members('Flw', 500), // fits: must not split
    });

    const chunks = planChunks(index, { maxWeight: DEFAULT_MAX_WEIGHT });

    const apexChunks = chunks.filter((c) => c.byType.has('ApexClass'));
    const flowChunks = chunks.filter((c) => c.byType.has('Flow'));
    assert.ok(apexChunks.length > 1, 'the oversized type must be split');
    assert.equal(flowChunks.length, 1, 'the type that fits must stay whole');
    for (const c of apexChunks) assert.ok(c.splitTypes.has('ApexClass'));
    for (const c of flowChunks) assert.ok(!c.splitTypes.has('Flow'));
  });

  test('weights CustomObject above simple types so file count, not member count, is bounded', () => {
    // 500 CustomObjects (weight 20) is 10,000 weighted — over the limit — while
    // 500 ApexClasses (weight 1) is nowhere near it.
    const objects = planChunks(makeIndex({ CustomObject: members('Obj', 500) }), { maxWeight: DEFAULT_MAX_WEIGHT });
    const classes = planChunks(makeIndex({ ApexClass: members('Cls', 500) }), { maxWeight: DEFAULT_MAX_WEIGHT });

    assert.ok(objects.length > classes.length, 'heavier types must produce more chunks for the same member count');
    assert.equal(classes.length, 1);
  });

  test('places every indexed member into exactly one chunk', () => {
    const index = makeIndex({
      ApexClass: members('Cls', 9500),
      CustomObject: members('Obj', 700),
      Flow: members('Flw', 120),
    });

    const chunks = planChunks(index, { maxWeight: DEFAULT_MAX_WEIGHT });

    const seen = new Map();
    for (const chunk of chunks) {
      for (const [type, ms] of chunk.byType) {
        for (const m of ms) {
          const key = `${type}:${m}`;
          assert.ok(!seen.has(key), `${key} appears in more than one chunk`);
          seen.set(key, true);
        }
      }
    }
    assert.equal(seen.size, 9500 + 700 + 120);
  });

  test('plans identically across runs for the same index', () => {
    const index = makeIndex({ ApexClass: members('Cls', 900), Flow: members('Flw', 800), Layout: members('Lay', 700) });
    const shape = (cs) => cs.map((c) => [...c.byType.entries()].map(([t, m]) => `${t}:${m.length}`).join('|'));
    assert.deepEqual(shape(planChunks(index, {})), shape(planChunks(index, {})));
  });

  test('rejects a per-member weight larger than maxWeight', () => {
    const index = makeIndex({ CustomObject: members('Obj', 1) });
    assert.throws(() => planChunks(index, { maxWeight: 5 }), /exceeds --max-weight/);
  });

  test('skips types with no members', () => {
    const chunks = planChunks(makeIndex({ ApexClass: [], Flow: ['Only'] }), {});
    assert.equal(chunks.length, 1);
    assert.deepEqual([...chunks[0].byType.keys()], ['Flow']);
  });
});

describe('manifest writing', () => {
  test('writes a package.xml and JSON sidecar per chunk with a valid version', () => {
    const dir = seededRunDir(makeIndex({ ApexClass: members('Cls', 12000) }));

    const { plan } = planManifestsPhase({ runDir: dir, ...quiet });

    assert.ok(plan.chunkCount > 1);
    for (const chunk of plan.chunks) {
      const xml = fs.readFileSync(path.join(runPaths(dir).manifestsDir, chunk.file), 'utf8');
      assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
      assert.match(xml, /<name>ApexClass<\/name>/);
      assert.match(xml, /<version>62\.0<\/version>/);

      const sidecar = JSON.parse(fs.readFileSync(path.join(runPaths(dir).manifestsDir, chunk.jsonFile), 'utf8'));
      assert.equal(sidecar.apiVersion, '62.0');
      assert.equal(
        sidecar.typeGroups.reduce((n, g) => n + g.members.length, 0),
        chunk.memberCount,
      );
    }
  });

  test('records total members in the plan matching the index', () => {
    const dir = seededRunDir(makeIndex({ ApexClass: members('Cls', 2000), CustomObject: members('Obj', 300) }));
    const { plan } = planManifestsPhase({ runDir: dir, ...quiet });
    assert.equal(plan.totalMembers, 2300);
  });

  test('surfaces split types at the plan level', () => {
    const dir = seededRunDir(makeIndex({ ApexClass: members('Cls', 25000) }));
    const { plan } = planManifestsPhase({ runDir: dir, ...quiet });
    assert.deepEqual(plan.splitTypes, ['ApexClass']);
  });

  test('honours a custom maxWeight', () => {
    const dir = seededRunDir(makeIndex({ ApexClass: members('Cls', 1000) }));
    const { plan } = planManifestsPhase({ runDir: dir, maxWeight: 100, ...quiet });
    assert.equal(plan.maxWeight, 100);
    assert.equal(plan.chunkCount, 10);
  });
});
