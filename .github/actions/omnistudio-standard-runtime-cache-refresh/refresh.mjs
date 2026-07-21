// omnistudio-standard-runtime-cache-refresh orchestrator — wires the pure lib
// (lib/cache-refresh.mjs) to the IO layers (lib/org.mjs, lib/activator.mjs)
// and the GitHub reporting surfaces (annotations, step summary, exit code).
//
// Executable entry is main.mjs; this module exports run() with every IO
// dependency injectable so the test suite can stub the org and the browser.
//
// Exit codes (CairnCI extension contract, see README):
//   0  — nothing to do, or everything in sync / successfully reactivated
//   10 — warn: one or more components could not be confirmed active. NEVER
//        fails the job: action.yml maps 10 -> warning + exit 0 (design §9).
//   2  — config/environment error (malformed policy JSON, bad manifest path
//        explicitly provided, sf CLI unusable)

import fs from "node:fs";
import path from "node:path";

import {
  ConfigError,
  parsePolicy,
  resolveSettings,
  parseManifest,
  sourceIntendsActive,
  buildQueries,
  planActivations,
  resultRows,
  warningLines,
  buildStepSummary,
  exitCodeFor,
  ANNOTATION_PREFIX,
} from "./lib/cache-refresh.mjs";
import { OrgError, orgSession, soqlQuery } from "./lib/org.mjs";
import { activateAll } from "./lib/activator.mjs";

export function parseArgs(argv) {
  const out = {};
  const map = {
    "--workspace": "workspace",
    "--policy-file": "policyFile",
    "--manifest": "manifest",
    "--deploy-dir": "deployDir",
    "--target-org": "targetOrg",
    "--omniscript-compile-page": "omniscriptCompilePage",
    "--flexcard-compile-page": "flexcardCompilePage",
    "--activation-timeout-seconds": "activationTimeoutSeconds",
    "--activation-retries": "activationRetries",
    "--activation-mode": "activationMode",
    "--browser-executable": "browserExecutable",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = map[argv[i]];
    if (key) out[key] = argv[++i];
  }
  return out;
}

/** Find the deployed source file for a component under the deploy dir. */
function findSourceXml(deployDirAbs, uniqueName) {
  if (!fs.existsSync(deployDirAbs)) return null;
  const stack = [deployDirAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else if (d.name.startsWith(`${uniqueName}.`) && d.name.endsWith("-meta.xml")) {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function writeStepSummary(rows, env) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, buildStepSummary(rows) + "\n");
}

function report(rows, env, logger) {
  for (const r of rows) {
    logger.log(`${r.uniqueName} (${r.family}): ${r.status} — ${r.detail}`);
  }
  for (const line of warningLines(rows)) logger.log(`::warning::${line}`);
  writeStepSummary(rows, env);
  return exitCodeFor(rows);
}

export async function run({
  argv = [],
  env = process.env,
  logger = console,
  io = {},
} = {}) {
  const deps = { orgSession, soqlQuery, activateAll, ...io };
  const args = parseArgs(argv);
  const workspace = path.resolve(args.workspace || env.CAIRNCI_WORKSPACE || process.cwd());

  // --- settings: input wins over policy file wins over defaults ------------
  const policyFile = path.resolve(workspace, args.policyFile || env.POLICY_FILE || ".cairnci/omnistudio-standard-runtime-policy.json");
  const policyText = fs.existsSync(policyFile) ? fs.readFileSync(policyFile, "utf8") : null;
  const policy = parsePolicy(policyText, path.relative(workspace, policyFile));
  const settings = resolveSettings({ inputs: args, policy });

  // --- component discovery from the deploy's own manifest (§8a) ------------
  const manifestPath = path.resolve(workspace, settings.manifest);
  if (!fs.existsSync(manifestPath)) {
    logger.log(`::notice::${ANNOTATION_PREFIX} no deploy manifest at '${settings.manifest}' — nothing to check.`);
    return 0;
  }
  const components = parseManifest(fs.readFileSync(manifestPath, "utf8"));
  if (components.length === 0) {
    logger.log(`::notice::${ANNOTATION_PREFIX} no OmniStudio Standard Runtime components in this deploy — nothing to check.`);
    return 0;
  }

  const deployDirAbs = path.resolve(workspace, settings.deployDir);
  for (const c of components) {
    c.intendsActive = sourceIntendsActive(findSourceXml(deployDirAbs, c.uniqueName));
  }

  // --- sync check via SOQL against the SObject layer (§8b) -----------------
  const records = [];
  for (const { family, soql } of buildQueries(components)) {
    for (const r of deps.soqlQuery(soql, settings.targetOrg, env)) {
      records.push({ family, Id: r.Id, UniqueName: r.UniqueName, IsActive: r.IsActive, VersionNumber: r.VersionNumber });
    }
  }
  const plan = planActivations({ components, records, mode: settings.activationMode });
  logger.log(
    `${ANNOTATION_PREFIX} ${components.length} deployed component(s) — ` +
      `${plan.inSync.length} in sync, ${plan.toActivate.length} to activate, ` +
      `${plan.noPage.length + plan.missing.length} warning(s), ${plan.skipped.length} skipped.`,
  );

  // --- conditional headless activation (§8c) -------------------------------
  let outcomes = [];
  if (plan.toActivate.length > 0) {
    let session;
    try {
      session = deps.orgSession(settings.targetOrg, env);
    } catch (e) {
      // No session = nothing is confirmable. Warn per component; never fail.
      outcomes = plan.toActivate.map((entry) => ({
        uniqueName: entry.uniqueName,
        family: entry.family,
        ok: false,
        detail: `could not reuse the deploy job's org session: ${e.message}`,
      }));
    }
    if (session) {
      const recheck = async (entries) => {
        const confirmed = new Set();
        for (const { family, soql } of buildQueries(entries)) {
          for (const r of deps.soqlQuery(soql, settings.targetOrg, env)) {
            if (r.IsActive) confirmed.add(r.UniqueName);
          }
        }
        return confirmed;
      };
      outcomes = await deps.activateAll({
        entries: plan.toActivate,
        settings,
        session,
        recheck,
        logger,
      });
    }
  }

  // --- report (§8d) --------------------------------------------------------
  return report(resultRows(plan, outcomes), env, logger);
}

export async function main() {
  try {
    process.exit(await run({ argv: process.argv.slice(2) }));
  } catch (e) {
    if (e instanceof ConfigError || e instanceof OrgError) {
      console.log(`::error::${ANNOTATION_PREFIX} ${e.message}`);
      process.exit(2);
    }
    // Unexpected bug: by design still a warning, never a failed job (§9) —
    // the next deploy's run will re-detect anything left out of sync.
    console.log(`::warning::${ANNOTATION_PREFIX} unexpected failure: ${e?.stack || e?.message || e}`);
    process.exit(10);
  }
}
