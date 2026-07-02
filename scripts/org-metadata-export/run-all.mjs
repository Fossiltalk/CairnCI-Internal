#!/usr/bin/env node
// Orchestrator: index -> plan -> retrieve, reusing one run directory.
//
// Usage:
//   node run-all.mjs [--target-org CairnCI-Main] [--max-weight 9000]
//                     [--concurrency 6] [--wait 60] [--skip-retrieve]
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { newRunId, DEFAULT_OUT_ROOT, DEFAULT_TARGET_DIR } from './lib/paths.mjs';
import { runIndexPhase } from './index-metadata.mjs';
import { planManifestsPhase } from './plan-manifests.mjs';
import { retrievePhase } from './retrieve-metadata.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetOrg = args['target-org'] ?? 'CairnCI-Main';
  const runDir = args['run-dir'] ?? `${DEFAULT_OUT_ROOT}/${newRunId()}`;
  const maxWeight = args['max-weight'] ? Number(args['max-weight']) : undefined;
  const concurrency = args.concurrency ? Number(args.concurrency) : undefined;
  const waitMinutes = args.wait ? Number(args.wait) : undefined;
  const targetDir = args['target-dir'] ? path.resolve(args['target-dir']) : DEFAULT_TARGET_DIR;

  await runIndexPhase({ targetOrg, runDir, apiVersion: args['api-version'], concurrency });
  await planManifestsPhase({ runDir, maxWeight });

  if (args['skip-retrieve']) {
    console.log(`[run-all] --skip-retrieve set; manifests are ready under ${runDir}/manifests`);
    return;
  }

  await retrievePhase({ runDir, waitMinutes, targetDir, keepStaging: Boolean(args['keep-staging']) });
  console.log(`[run-all] done. Run directory: ${runDir}`);
  console.log(`[run-all] merged source into: ${targetDir}`);
}

main().catch((err) => {
  console.error('[run-all] FAILED:', err.message);
  process.exit(1);
});
