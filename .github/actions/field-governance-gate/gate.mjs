#!/usr/bin/env node
// field-governance-gate CLI — orchestrates the gate: load config -> git diff ->
// classify new/modified fields -> audit against the governance policy -> report
// (console, GitHub annotations, step summary, sticky PR comment) -> exit with
// the extension exit-code contract (0 ok, 10 warn, 1 error, 2 config/env).
//
// All pure logic lives in lib/field-governance-gate.mjs; this file only does IO.

import fs from "node:fs";
import path from "node:path";

import {
  ConfigError,
  loadConfig,
  resolveBaseRef,
  gitChangedFiles,
  classifyFields,
  audit,
  exitCodeForFindings,
  buildStepSummary,
  buildCommentBody,
  upsertStickyComment,
} from "./lib/field-governance-gate.mjs";

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

/**
 * Annotations are anchored to the field file so they land inline on the PR
 * diff — the whole point of a governance gate is that the fix is in that file.
 */
function emitAnnotations(findings, logger) {
  for (const f of findings) {
    const level = f.severity === "warn" ? "warning" : "error";
    logger.log(`::${level} file=${f.file},line=1::${f.detail} (found: ${f.actual})`);
  }
}

function reportConsole(result, logger) {
  const { findings, skipped, bypassed, satisfied, audited } = result;
  if (findings.length === 0) {
    logger.log("field-governance-gate: all changed fields carry the required governance metadata.");
  } else {
    logger.log(`field-governance-gate: ${findings.length} finding(s):`);
    for (const f of findings) {
      logger.log(`  - [${f.severity}] ${f.component}: ${f.problem} (found: ${f.actual})${f.rule ? ` [rule: ${f.rule}]` : ""}`);
    }
  }
  logger.log(
    `field-governance-gate tally: ${findings.length} finding(s), ${audited} field(s) audited, ` +
      `${satisfied} requirement(s) satisfied, ${skipped.length} skipped, ${bypassed.length} bypassed.`,
  );
}

function writeStepSummary(result, env) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, buildStepSummary(result) + "\n");
}

async function maybeComment(args, result, env, logger) {
  const commenting = (args.comment ?? "true") !== "false";
  if (!commenting) {
    logger.log("::notice::field-governance-gate: PR commenting disabled (--comment false).");
    return;
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const prNumber = resolvePrNumber(args, env);
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !prNumber || !repo) {
    logger.log("::notice::field-governance-gate: no token / PR number / repo in env — skipping the PR comment (annotations and summary still carry the result).");
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
  logger.log(`::notice::field-governance-gate: sticky comment ${res.action}.`);
}

async function main() {
  const logger = console;
  const env = process.env;
  const args = parseArgs(process.argv.slice(2));

  const workspace = path.resolve(args.workspace || env.CAIRNCI_WORKSPACE || process.cwd());
  const sourceDir = args.sourceDir || env.SOURCE_DIR || "force-app";
  const configFile = path.resolve(workspace, args.config || env.CONFIG_FILE || ".cairnci/field-governance-gate.json");

  let config;
  try {
    config = loadConfig(configFile);
  } catch (e) {
    if (e instanceof ConfigError) {
      logger.log(`::error::field-governance-gate: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  if (config === null) {
    logger.log(`::notice::field-governance-gate: no config at '${path.relative(workspace, configFile)}' — skipping (the gate is opt-in).`);
    process.exit(0);
  }

  const baseRef = resolveBaseRef({ baseRefArg: args.baseRef, env });
  let changed;
  try {
    changed = gitChangedFiles({ workspace, baseRef });
  } catch (e) {
    logger.log(`::error::field-governance-gate: ${e.message}`);
    process.exit(2);
  }

  const fields = classifyFields({ changed, sourceDir, workspace });
  if (fields.length === 0) {
    logger.log("::notice::field-governance-gate: no new or modified field metadata in this diff.");
  }

  const result = audit({ config, fields });

  reportConsole(result, logger);
  emitAnnotations(result.findings, logger);
  writeStepSummary(result, env);
  await maybeComment(args, result, env, logger);

  process.exit(exitCodeForFindings(result.findings));
}

main().catch((e) => {
  console.log(`::error::field-governance-gate: unexpected failure: ${e?.stack || e?.message || e}`);
  process.exit(2);
});
