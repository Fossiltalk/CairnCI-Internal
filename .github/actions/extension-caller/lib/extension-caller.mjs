// ExtensionCaller — runs consumer-defined pipeline extensions for a CairnCI
// lifecycle phase, in the exact order they appear in the source-tracked config
// file (.cairnci/extensions.json by default).
//
// Extension contract (see docs/extensions.md):
//   - `run.type: "local"`  — entry script committed in the consumer repo.
//   - `run.type: "git"`    — entry script in any external git repo, pinned to a
//     ref (tag/branch/SHA) and cloned into a temp dir OUTSIDE the workspace.
//   - Exit 0  = ok (info), exit 10 = warn (annotated, never blocks),
//     any other exit = error. An error fails the phase only when `blocking`
//     is true; with `blocking: false` the result keeps status "error" but the
//     phase continues and the pipeline only gets a warning annotation.
//
// Zero runtime dependencies: node:child_process + node:fs only, so the class
// runs identically inside the composite action and under `node --test`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PHASES = [
  "pre-validate",
  "post-validate-success",
  "post-validate-failure",
  "pre-deploy",
  "post-deploy-success",
  "post-deploy-failure",
];

export const EXIT_WARN = 10;

export class ConfigError extends Error {}

export class ExtensionCaller {
  /**
   * @param {object} opts
   * @param {string} opts.configFile   Path to the extensions config JSON.
   * @param {string} [opts.workspace]  Consumer repo root (default: cwd).
   * @param {object} [opts.logger]     console-like; also understands GitHub
   *                                   ::error::/::warning::/::notice:: lines.
   * @param {string} [opts.cloneRoot]  Where git-type extensions are cloned
   *                                   (default: a fresh dir under os.tmpdir()).
   * @param {number} [opts.defaultTimeoutSeconds]  Per-extension timeout.
   */
  constructor({ configFile, workspace = process.cwd(), logger = console, cloneRoot = null, defaultTimeoutSeconds = 600 }) {
    if (!configFile) throw new ConfigError("configFile is required");
    this.configFile = configFile;
    this.workspace = path.resolve(workspace);
    this.logger = logger;
    this.cloneRoot = cloneRoot;
    this.defaultTimeoutSeconds = defaultTimeoutSeconds;
    this.cloneCache = new Map(); // "repo@ref" -> checkout dir
  }

  /**
   * Load and validate the config. Returns null when the file does not exist
   * (extensions are optional); throws ConfigError on any invalid content so a
   * committed-but-broken config never silently passes.
   */
  loadConfig() {
    const file = path.resolve(this.workspace, this.configFile);
    if (!fs.existsSync(file)) return null;

    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new ConfigError(`Could not parse ${this.configFile}: ${e.message}`);
    }
    if (typeof cfg !== "object" || cfg === null || !Array.isArray(cfg.extensions)) {
      throw new ConfigError(`${this.configFile} must be an object with an "extensions" array`);
    }

    const seen = new Set();
    cfg.extensions.forEach((ext, i) => {
      const where = `extensions[${i}]`;
      if (typeof ext !== "object" || ext === null) throw new ConfigError(`${where} must be an object`);
      if (typeof ext.id !== "string" || ext.id.trim() === "") throw new ConfigError(`${where}.id must be a non-empty string`);
      if (seen.has(ext.id)) throw new ConfigError(`duplicate extension id "${ext.id}"`);
      seen.add(ext.id);

      if (!Array.isArray(ext.phases) || ext.phases.length === 0) {
        throw new ConfigError(`${where}.phases must be a non-empty array (id "${ext.id}")`);
      }
      for (const p of ext.phases) {
        if (!PHASES.includes(p)) {
          throw new ConfigError(`${where}.phases contains unknown phase "${p}" (id "${ext.id}"). Valid phases: ${PHASES.join(", ")}`);
        }
      }
      if (ext.blocking !== undefined && typeof ext.blocking !== "boolean") {
        throw new ConfigError(`${where}.blocking must be a boolean (id "${ext.id}")`);
      }
      if (ext.env !== undefined) {
        if (typeof ext.env !== "object" || ext.env === null || Array.isArray(ext.env)) {
          throw new ConfigError(`${where}.env must be an object of string values (id "${ext.id}")`);
        }
        for (const [k, v] of Object.entries(ext.env)) {
          if (typeof v !== "string") {
            throw new ConfigError(`${where}.env.${k} must be a string (id "${ext.id}")`);
          }
        }
      }

      const run = ext.run;
      if (typeof run !== "object" || run === null) throw new ConfigError(`${where}.run must be an object (id "${ext.id}")`);
      if (run.type === "local") {
        if (typeof run.entry !== "string" || run.entry === "") throw new ConfigError(`${where}.run.entry is required for type "local" (id "${ext.id}")`);
      } else if (run.type === "git") {
        for (const k of ["repo", "ref", "entry"]) {
          if (typeof run[k] !== "string" || run[k] === "") {
            throw new ConfigError(`${where}.run.${k} is required for type "git" (id "${ext.id}") — refs must be pinned for deterministic runs`);
          }
        }
      } else {
        throw new ConfigError(`${where}.run.type must be "local" or "git" (id "${ext.id}")`);
      }
    });
    return cfg;
  }

  /**
   * The extensions pinned to a phase, in config-file (array) order — the
   * user-defined, source-tracked run order.
   */
  select(phase, cfg) {
    if (!PHASES.includes(phase)) {
      throw new ConfigError(`unknown phase "${phase}". Valid phases: ${PHASES.join(", ")}`);
    }
    if (!cfg) return [];
    return cfg.extensions.filter((e) => e.phases.includes(phase));
  }

  /**
   * Run every extension pinned to `phase`, in order. Never throws for
   * extension failures — returns an aggregate the CLI turns into an exit code.
   *
   * @returns {{phase: string, results: Array<{id: string, status: "ok"|"warn"|"error", blocking: boolean, exitCode: number|null, durationMs: number, detail: string}>, failed: boolean}}
   */
  runPhase(phase, context = {}) {
    const cfg = this.loadConfig();
    if (cfg === null) {
      this.logger.log(`No extensions config at '${this.configFile}' — nothing to run for ${phase}.`);
      return { phase, results: [], failed: false };
    }
    const selected = this.select(phase, cfg);
    if (selected.length === 0) {
      this.logger.log(`No extensions pinned to phase '${phase}'.`);
      return { phase, results: [], failed: false };
    }

    const results = [];
    let failed = false;
    for (const ext of selected) {
      const res = this.runOne(ext, phase, context);
      results.push(res);
      if (res.status === "error" && res.blocking) {
        failed = true;
        this.logger.error(`::error::[${ext.id}] blocking extension failed in phase '${phase}' (exit ${res.exitCode}).`);
      } else if (res.status === "error") {
        this.logger.warn(`::warning::[${ext.id}] non-blocking extension failed in phase '${phase}' (exit ${res.exitCode}) — continuing.`);
      } else if (res.status === "warn") {
        this.logger.warn(`::warning::[${ext.id}] reported a warning in phase '${phase}'.`);
      } else {
        this.logger.log(`::notice::[${ext.id}] ok (${res.durationMs}ms).`);
      }
    }
    this.writeSummary(phase, results);
    return { phase, results, failed };
  }

  /** Run a single extension and classify its exit code. */
  runOne(ext, phase, context) {
    const blocking = ext.blocking !== false; // default: blocking
    const started = Date.now();
    const done = (status, exitCode, detail) => ({
      id: ext.id, status, blocking, exitCode,
      durationMs: Date.now() - started,
      detail,
    });

    let entryPath;
    let cwd;
    try {
      if (ext.run.type === "local") {
        entryPath = path.resolve(this.workspace, ext.run.entry);
        cwd = this.workspace;
        if (!fs.existsSync(entryPath)) {
          return done("error", null, `local entry not found: ${ext.run.entry}`);
        }
      } else {
        const checkout = this.cloneRepo(ext.run.repo, ext.run.ref);
        entryPath = path.resolve(checkout, ext.run.entry);
        cwd = checkout;
        if (!entryPath.startsWith(checkout + path.sep)) {
          return done("error", null, `git entry escapes the checkout: ${ext.run.entry}`);
        }
        if (!fs.existsSync(entryPath)) {
          return done("error", null, `entry not found in ${ext.run.repo}@${ext.run.ref}: ${ext.run.entry}`);
        }
      }
    } catch (e) {
      return done("error", null, e.message);
    }

    // .sh via bash and .mjs/.js via node so entries work without an exec bit;
    // anything else is executed directly.
    let cmd, args;
    if (/\.sh$/.test(entryPath)) { cmd = "bash"; args = [entryPath]; }
    else if (/\.(mjs|cjs|js)$/.test(entryPath)) { cmd = process.execPath; args = [entryPath]; }
    else { cmd = entryPath; args = []; }

    const timeoutSeconds = Number(ext.timeoutSeconds) > 0 ? Number(ext.timeoutSeconds) : this.defaultTimeoutSeconds;
    this.logger.log(`--- [${ext.id}] ${phase} (${ext.run.type}${blocking ? ", blocking" : ", non-blocking"}) ---`);
    let proc;
    try {
      proc = spawnSync(cmd, args, {
        cwd,
        stdio: "inherit",
        timeout: timeoutSeconds * 1000,
        env: {
          ...process.env,
          ...(ext.env || {}),
          CAIRNCI_PHASE: phase,
          CAIRNCI_EXTENSION_ID: ext.id,
          CAIRNCI_BLOCKING: String(blocking),
          CAIRNCI_WORKSPACE: this.workspace,
          CAIRNCI_CONTEXT: JSON.stringify(context),
        },
      });
    } catch (e) {
      return done("error", null, `could not spawn entry: ${e.message}`);
    }

    if (proc.error) {
      const timedOut = proc.error.code === "ETIMEDOUT";
      return done("error", null, timedOut ? `timed out after ${timeoutSeconds}s` : proc.error.message);
    }
    if (proc.status === 0) return done("ok", 0, "");
    if (proc.status === EXIT_WARN) return done("warn", EXIT_WARN, "");
    return done("error", proc.status, `exit code ${proc.status}`);
  }

  /**
   * Shallow-clone `repo` at `ref` into a temp dir outside the workspace.
   * Falls back to a full clone + detached checkout when the ref is a commit
   * SHA (not fetchable with --branch). Cached per repo@ref for the run.
   */
  cloneRepo(repo, ref) {
    const key = `${repo}@${ref}`;
    if (this.cloneCache.has(key)) return this.cloneCache.get(key);

    if (!this.cloneRoot) {
      this.cloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cairnci-ext-"));
    }
    const dir = fs.mkdtempSync(path.join(this.cloneRoot, "checkout-"));

    const git = (args, cwd) => spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
    const fail = (msg) => {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(msg);
    };
    let r = git(["clone", "--depth", "1", "--branch", ref, "--", repo, dir]);
    if (r.status !== 0) {
      // ref may be a commit SHA — full clone, then detach.
      r = git(["clone", "--", repo, dir]);
      if (r.status !== 0) fail(`git clone failed for ${repo}: ${(r.stderr || "").trim()}`);
      r = git(["checkout", "--detach", ref], dir);
      if (r.status !== 0) fail(`ref "${ref}" not found in ${repo}: ${(r.stderr || "").trim()}`);
    }
    this.cloneCache.set(key, dir);
    return dir;
  }

  /** Markdown results table for GITHUB_STEP_SUMMARY, when running in Actions. */
  writeSummary(phase, results) {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryFile || results.length === 0) return;
    const icon = { ok: "✅", warn: "⚠️", error: "❌" };
    let md = `### CairnCI extensions — \`${phase}\`\n\n| # | Extension | Status | Blocking | Exit | Duration |\n|---|---|---|---|---|---|\n`;
    results.forEach((r, i) => {
      md += `| ${i + 1} | \`${r.id}\` | ${icon[r.status]} ${r.status} | ${r.blocking ? "yes" : "no"} | ${r.exitCode ?? "—"} | ${r.durationMs}ms |\n`;
    });
    fs.appendFileSync(summaryFile, md + "\n");
  }
}
