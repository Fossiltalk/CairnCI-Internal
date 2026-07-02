#!/usr/bin/env node
// Phase 2: chunk the metadata index into package.xml manifests that stay
// under Salesforce's retrieve ceiling (10,000 files/request). Chunking is
// weighted, not a naive member count, because some types (CustomObject,
// Profile, PermissionSet) expand into many more files per member than a
// simple singleton type like ApexClass does.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { ensureDir, runPaths } from './lib/paths.mjs';
import { buildPackageXml } from './lib/manifest-xml.mjs';

const DEFAULT_MAX_WEIGHT = 9000;
const DEFAULT_WEIGHTS = {
  CustomObject: 20,
  Profile: 5,
  PermissionSet: 5,
  default: 1,
};

export function planChunks(index, { maxWeight = DEFAULT_MAX_WEIGHT, weights = DEFAULT_WEIGHTS } = {}) {
  const weightFor = (type) => weights[type] ?? weights.default ?? 1;

  const chunks = [];
  let current = { weight: 0, byType: new Map() };

  function pushCurrentIfNonEmpty() {
    if (current.weight > 0) chunks.push(current);
  }

  const typeNames = Object.keys(index.types).sort();
  for (const type of typeNames) {
    const entry = index.types[type];
    const perMember = weightFor(type);
    if (perMember > maxWeight) {
      throw new Error(`Type ${type} has per-member weight ${perMember} which exceeds --max-weight ${maxWeight}`);
    }
    for (const member of entry.members) {
      if (current.weight + perMember > maxWeight) {
        pushCurrentIfNonEmpty();
        current = { weight: 0, byType: new Map() };
      }
      current.weight += perMember;
      if (!current.byType.has(type)) current.byType.set(type, []);
      current.byType.get(type).push(member.fullName);
    }
  }
  pushCurrentIfNonEmpty();

  return chunks;
}

export function planManifestsPhase({ runDir, maxWeight = DEFAULT_MAX_WEIGHT, weights = DEFAULT_WEIGHTS } = {}) {
  const paths = runPaths(runDir);
  const index = JSON.parse(fs.readFileSync(paths.indexFile, 'utf8'));

  ensureDir(paths.manifestsDir);

  const chunks = planChunks(index, { maxWeight, weights });

  const chunkSummaries = chunks.map((chunk, i) => {
    const fileName = `package-chunk-${String(i + 1).padStart(3, '0')}.xml`;
    const typeGroups = [...chunk.byType.entries()].map(([type, members]) => ({ type, members }));
    const xml = buildPackageXml(typeGroups, index.apiVersion);
    fs.writeFileSync(path.join(paths.manifestsDir, fileName), xml);

    // JSON sidecar mirroring the XML's type->members content, so
    // retrieve-metadata.mjs can regenerate a filtered manifest (excluding a
    // type unsupported by the installed CLI's local metadata registry)
    // without re-parsing XML.
    const jsonFileName = fileName.replace(/\.xml$/, '.json');
    fs.writeFileSync(path.join(paths.manifestsDir, jsonFileName), JSON.stringify({ apiVersion: index.apiVersion, typeGroups }, null, 2));

    const memberCount = typeGroups.reduce((sum, g) => sum + g.members.length, 0);
    return {
      file: fileName,
      jsonFile: jsonFileName,
      weightTotal: chunk.weight,
      memberCount,
      types: typeGroups.map((g) => g.type),
    };
  });

  const plan = {
    runId: index.runId,
    apiVersion: index.apiVersion,
    maxWeight,
    weights,
    chunkCount: chunkSummaries.length,
    totalMembers: chunkSummaries.reduce((sum, c) => sum + c.memberCount, 0),
    chunks: chunkSummaries,
  };

  fs.writeFileSync(paths.manifestPlanFile, JSON.stringify(plan, null, 2));

  console.log(`[plan] ${plan.chunkCount} chunk(s), ${plan.totalMembers} total members, max weight ${maxWeight}`);
  for (const c of chunkSummaries) {
    console.log(`[plan]   ${c.file}: ${c.memberCount} members, weight ${c.weightTotal}, ${c.types.length} types`);
  }
  console.log(`[plan] wrote ${paths.manifestPlanFile}`);

  return { paths, plan };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['run-dir']) throw new Error('--run-dir is required (point at the output of index-metadata.mjs)');

  let weights = DEFAULT_WEIGHTS;
  if (args['weights-file']) {
    weights = { ...DEFAULT_WEIGHTS, ...JSON.parse(fs.readFileSync(args['weights-file'], 'utf8')) };
  }

  planManifestsPhase({
    runDir: args['run-dir'],
    maxWeight: args['max-weight'] ? Number(args['max-weight']) : DEFAULT_MAX_WEIGHT,
    weights,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[plan] FAILED:', err.message);
    process.exit(1);
  });
}
