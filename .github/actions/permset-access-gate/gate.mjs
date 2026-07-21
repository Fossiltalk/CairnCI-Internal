#!/usr/bin/env node
// permset-access-gate CLI — orchestrates the gate: load config -> git diff ->
// classify new fields/objects -> audit against permission sets -> report
// (console, GitHub annotations, step summary, sticky PR comment) -> exit with
// the extension exit-code contract (0 ok, 10 warn, 1 error, 2 config/env).
//
// All pure logic lives in lib/permset-gate.mjs; this file only does IO.

import fs from "node:fs";
import path from "node:path";

import {
  ConfigError,
  loadConfig,
  resolveBaseRef,
  gitAddedFiles,
  classifyComponents,
  findPermissionSets,
  audit,
  exitCodeForFindings,
  buildStepSummary,
  buildCommentBody,
  upsertStickyComment,
} from "./lib/permset-gate.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    switch (a) {
      case "--workspace": out.workspace = take(); break;
      case "--config": out.config = take(); break;
      case "--source-dir": out.sourceDir = take(); break;
      case "--base-ref": out.baseRef = take(); break;
      case "--pr-number": out.prNumber = take(); break;
      case "--comment": out.comment = take(); break;
      default: break;
    }
  }
  return out;
}

/** PR number from --pr-number, PR_NUMBER, or the GITHUB_EVENT_PATH payload. */
function resolvePrNumber(args, env) {
  const raw = args.prNumber || env.PR_NUMBER;
  if (raw) return String(raw);
  if (env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    try {
      const ev = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
      if (ev?.pull_request?.number) return String(ev.pull_request.number);
    } catch {
      /* ignore malformed event payloads */
    }
  }
  return null;
}

function emitAnnotations(findings, logger) {
  for (const f of findings) {
    const level = f.severity === "warn" ? "warning" : "error";
    logger.log(`::${level}::[${f.permissionSet}] ${f.detail} (found: ${f.actual})`);
  }
}

function reportConsole(result, logger) {
  const { findings, exempt, bypassed, satisfied } = result;
  if (findings.length === 0) {
    logger.log("permset-access-gate: no access gaps found for new fields/objects.");
  } else {
    logger.log(`permset-access-gate: ${findings.length} finding(s):`);
    for (const f of findings) logger.log(`  - [${f.severity}] ${f.permissionSet}: ${f.detail} (found: ${f.actual})`);
  }
  logger.log(`permset-access-gate tally: ${findings.length} finding(s), ${satisfied} satisfied, ${exempt.length} exempt, ${bypassed.length} bypassed.`);
}

function writeStepSummary(result, env) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, buildStepSummary(result) + "\n");
}

async function maybeComment(args, result, env, logger) {
  const commenting = (args.comment ?? "true") !== "false";
  if (!commenting) {
    logger.log("::notice::permset-access-gate: PR commenting disabled (--comment false).");
    return;
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const prNumber = resolvePrNumber(args, env);
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !prNumber || !repo) {
    logger.log("::notice::permset-access-gate: no token / PR number / repo in env — skipping the PR comment (annotations and summary still carry the result).");
    return;
  }
  const apiBase = env.GITHUB_API_URL || "https://api.github.com";
  const res = await upsertStickyComment({
    apiBase,
    repo,
    prNumber,
    token,
    body: buildCommentBody(result),
    hasFindings: result.findings.length > 0,
    logger,
  });
  logger.log(`::notice::permset-access-gate: sticky comment ${res.action}.`);
}

async function main() {
  const logger = console;
  const env = process.env;
  const args = parseArgs(process.argv.slice(2));

  const workspace = path.resolve(args.workspace || env.CAIRNCI_WORKSPACE || process.cwd());
  const sourceDir = args.sourceDir || env.SOURCE_DIR || "force-app";
  const configFile = path.resolve(workspace, args.config || env.CONFIG_FILE || ".cairnci/permset-access-gate.json");

  let config;
  try {
    config = loadConfig(configFile);
  } catch (e) {
    if (e instanceof ConfigError) {
      logger.log(`::error::permset-access-gate: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  if (config === null) {
    logger.log(`::notice::permset-access-gate: no config at '${path.relative(workspace, configFile)}' — skipping (the gate is opt-in).`);
    process.exit(0);
  }

  const baseRef = resolveBaseRef({ baseRefArg: args.baseRef, env });
  let addedFiles;
  try {
    addedFiles = gitAddedFiles({ workspace, baseRef });
  } catch (e) {
    logger.log(`::error::permset-access-gate: ${e.message}`);
    process.exit(2);
  }

  const classified = classifyComponents({ addedFiles, sourceDir, workspace });
  const permsets = findPermissionSets({ workspace, sourceDir });
  const result = audit({ config, classified, permsets });

  const nothingNew = classified.fields.length === 0 && classified.objects.length === 0;
  if (nothingNew) {
    logger.log("::notice::permset-access-gate: no new custom fields or objects in this diff.");
  }

  reportConsole(result, logger);
  emitAnnotations(result.findings, logger);
  writeStepSummary(result, env);
  await maybeComment(args, result, env, logger);

  process.exit(exitCodeForFindings(result.findings));
}

main().catch((e) => {
  console.log(`::error::permset-access-gate: unexpected failure: ${e?.stack || e?.message || e}`);
  process.exit(2);
});
