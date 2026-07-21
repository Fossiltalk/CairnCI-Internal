// Shared helpers for tests that exercise the scripts embedded in
// .github/workflows/sf-deploy.yml. The workflow's logic lives in scripts
// embedded in the YAML (it must — the reusable workflow runs in the
// consumer's checkout, so it can't reference files from this repo), so tests
// extract those embedded scripts by step name and run them directly.
//
// Used by tests/unit/ (org-free, fixture-driven) and tests/org/ (org-gated).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const workflowYaml = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "sf-deploy.yml"), "utf8");

// The four OmniStudio Standard Runtime *content* types the split filters on.
export const OMNI_TYPES = [
  "OmniScript", "OmniIntegrationProcedure", "OmniDataTransform", "OmniUiCard",
];

// Adjacent OmniStudio config/tracking Metadata API types — settings, not
// content. The split's strict allowlist keeps them in the main deploy.
// (OmniExtTrackingEventDef was confirmed against a live v67.0 org; it is not
// in older documentation.)
export const EXCLUDED_TYPES = [
  "OmniInteractionConfig", "OmniInteractionAccessConfig", "OmniStudioSettings",
  "OmniSupervisorConfig", "OmniTrackingComponentDef", "OmniTrackingGroup",
  "OmniExtTrackingDef", "OmniExtTrackingEventDef",
];

// --- workflow extraction ------------------------------------------------------
// Steps sit at a fixed indentation in sf-deploy.yml (6 spaces for the list
// item, 10 for `run: |` content), so plain text slicing is reliable here.
export function stepLines(name) {
  const lines = workflowYaml.split("\n");
  const start = lines.findIndex((l) => l === `      - name: ${name}`);
  assert.notEqual(start, -1, `step not found in sf-deploy.yml: ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^      - name: /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

export function stepIf(name) {
  const line = stepLines(name).find((l) => /^        if: /.test(l));
  return line ? line.trim() : "";
}

// Body of the step's `run: |` block, dedented to what bash actually executes.
export function stepRun(name) {
  const lines = stepLines(name);
  const idx = lines.findIndex((l) => /^        run: \|/.test(l));
  assert.notEqual(idx, -1, `no run block in step: ${name}`);
  const body = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === "") { body.push(""); continue; }
    if (!l.startsWith("          ")) break;
    body.push(l.slice(10));
  }
  return body.join("\n");
}

// The embedded Node script between  node <<'EOF'  and  EOF .
export function stepNodeScript(name) {
  const run = stepRun(name);
  const m = run.match(/node <<'EOF'\n([\s\S]*?)\nEOF(\n|$)/);
  assert.ok(m, `no node heredoc in step: ${name}`);
  return m[1];
}

// --- manifests ------------------------------------------------------------------
export function packageXml(types) {
  const blocks = Object.entries(types).map(([t, members]) =>
    `    <types>\n${members.map((mm) => `        <members>${mm}</members>`).join("\n")}\n        <name>${t}</name>\n    </types>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${blocks.join("\n")}\n    <version>62.0</version>\n</Package>`;
}

export function typesIn(manifestPath) {
  const xml = fs.readFileSync(manifestPath, "utf8");
  return [...xml.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1].trim());
}

// --- running the split script ------------------------------------------------------
// Runs the actual "Split OmniStudio Standard Runtime metadata" script from
// sf-deploy.yml with `ws` as cwd (expects changed-sources/ inside it).
// Returns the step's GITHUB_OUTPUT key/values.
export function runSplitScript(ws, extraEnv = {}) {
  const script = path.join(ws, "split-omnistudio.cjs");
  fs.writeFileSync(script, stepNodeScript("Split OmniStudio Standard Runtime metadata"));
  const outFile = path.join(ws, "github-output");
  fs.writeFileSync(outFile, "");
  const res = spawnSync(process.execPath, [script], {
    cwd: ws, encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: outFile, ...extraEnv },
  });
  assert.equal(res.status, 0, `split script failed: ${res.stderr}`);
  return Object.fromEntries(
    fs.readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => l.split(/=(.*)/s).slice(0, 2)));
}
