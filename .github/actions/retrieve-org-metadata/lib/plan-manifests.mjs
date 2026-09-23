// Phase 2: chunk the metadata index into package.xml manifests that stay under
// Salesforce's retrieve ceiling (10,000 files per request).
//
// Two things make this more than a naive member count:
//
// 1. WEIGHTED. The ceiling is on the number of *files* in the result, not the
//    number of <members> in the manifest. CustomObject, Profile and
//    PermissionSet each expand into many more files per member (fields, record
//    types, layouts, ...) than a singleton type like ApexClass does, so members
//    are packed by a weighted total.
//
// 2. TYPE-ATOMIC. Types are placed whole, largest first (first-fit-decreasing
//    bin packing). A type is split across chunks only when the type's own
//    weighted total exceeds maxWeight — i.e. when it cannot fit anywhere.
//    Keeping a type contiguous makes a failed chunk mean "this type didn't
//    come back" rather than "some arbitrary slice of four types didn't", and
//    FFD packs the chunks fuller than sequential fill does, so a run makes
//    fewer round trips to the org and costs less runtime.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, runPaths } from './paths.mjs';
import { buildPackageXml } from './manifest-xml.mjs';

export const DEFAULT_MAX_WEIGHT = 9000;
export const DEFAULT_WEIGHTS = {
  CustomObject: 20,
  Profile: 5,
  PermissionSet: 5,
  default: 1,
};

function newChunk() {
  return { weight: 0, byType: new Map(), splitTypes: new Set() };
}

/**
 * Packs an index's members into chunks whose weighted total never exceeds
 * `maxWeight`.
 *
 * @returns {Array<{weight: number, byType: Map<string, string[]>, splitTypes: Set<string>}>}
 */
export function planChunks(index, { maxWeight = DEFAULT_MAX_WEIGHT, weights = DEFAULT_WEIGHTS } = {}) {
  const weightFor = (type) => weights[type] ?? weights.default ?? 1;

  // Sort descending by total weight so the big types claim their own chunks
  // first and the small ones fill the gaps (first-fit-decreasing). Ties break
  // on name so a given index always plans identically.
  const candidates = Object.keys(index.types)
    .map((type) => {
      const members = index.types[type].members.map((m) => m.fullName);
      const perMember = weightFor(type);
      return { type, members, perMember, totalWeight: members.length * perMember };
    })
    .filter((c) => c.members.length > 0)
    .sort((a, b) => b.totalWeight - a.totalWeight || a.type.localeCompare(b.type));

  const chunks = [];

  function placeWhole(candidate) {
    for (const chunk of chunks) {
      if (chunk.weight + candidate.totalWeight <= maxWeight) return chunk;
    }
    const chunk = newChunk();
    chunks.push(chunk);
    return chunk;
  }

  for (const candidate of candidates) {
    const { type, members, perMember, totalWeight } = candidate;

    if (perMember > maxWeight) {
      throw new Error(`Type ${type} has per-member weight ${perMember} which exceeds --max-weight ${maxWeight}`);
    }

    // Fits somewhere as a unit: place it whole and move on.
    if (totalWeight <= maxWeight) {
      const chunk = placeWhole(candidate);
      chunk.weight += totalWeight;
      chunk.byType.set(type, members);
      continue;
    }

    // Too big for any single chunk — the one case where splitting a type is
    // unavoidable. Give the split its own dedicated chunks. Because candidates
    // are processed largest-first, any slack left in the final slice's chunk
    // still gets filled by later (smaller) types via placeWhole.
    const membersPerChunk = Math.floor(maxWeight / perMember);
    for (let i = 0; i < members.length; i += membersPerChunk) {
      const slice = members.slice(i, i + membersPerChunk);
      const chunk = newChunk();
      chunk.weight = slice.length * perMember;
      chunk.byType.set(type, slice);
      chunk.splitTypes.add(type);
      chunks.push(chunk);
    }
  }

  return chunks;
}

export function planManifestsPhase({
  runDir,
  maxWeight = DEFAULT_MAX_WEIGHT,
  weights = DEFAULT_WEIGHTS,
  log = console.log,
} = {}) {
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
    fs.writeFileSync(
      path.join(paths.manifestsDir, jsonFileName),
      JSON.stringify({ apiVersion: index.apiVersion, typeGroups }, null, 2),
    );

    const memberCount = typeGroups.reduce((sum, g) => sum + g.members.length, 0);
    return {
      file: fileName,
      jsonFile: jsonFileName,
      weightTotal: chunk.weight,
      memberCount,
      types: typeGroups.map((g) => g.type),
      // Types too large to fit any single chunk, so spread across several.
      // Surfaced in the job summary because it changes how a chunk failure
      // should be read: a partial type rather than a whole missing one.
      splitTypes: [...chunk.splitTypes],
    };
  });

  const splitTypes = [...new Set(chunkSummaries.flatMap((c) => c.splitTypes))];

  const plan = {
    runId: index.runId,
    apiVersion: index.apiVersion,
    maxWeight,
    weights,
    chunkCount: chunkSummaries.length,
    totalMembers: chunkSummaries.reduce((sum, c) => sum + c.memberCount, 0),
    splitTypes,
    chunks: chunkSummaries,
  };

  fs.writeFileSync(paths.manifestPlanFile, JSON.stringify(plan, null, 2));

  log(`[plan] ${plan.chunkCount} chunk(s), ${plan.totalMembers} total members, max weight ${maxWeight}`);
  for (const c of chunkSummaries) {
    const splitNote = c.splitTypes.length > 0 ? `, split: ${c.splitTypes.join(', ')}` : '';
    log(`[plan]   ${c.file}: ${c.memberCount} members, weight ${c.weightTotal}, ${c.types.length} types${splitNote}`);
  }
  if (splitTypes.length > 0) {
    log(`[plan] ${splitTypes.length} type(s) exceeded max weight alone and were split across chunks: ${splitTypes.join(', ')}`);
  }
  log(`[plan] wrote ${paths.manifestPlanFile}`);

  return { paths, plan };
}
