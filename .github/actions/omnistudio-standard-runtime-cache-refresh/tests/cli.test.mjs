// CLI-level tests: main.mjs spawned as a child against temp workspaces, with
// the sf CLI replaced by a stub via OMNI_CACHE_REFRESH_SF_BIN. Org-free and
// browser-free (the stub org data never leaves anything out of sync, so the
// activation path — covered in cache-refresh.test.mjs — is never reached).
//   node --test .github/actions/omnistudio-standard-runtime-cache-refresh/tests/cli.test.mjs

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, "..", "main.mjs");

let dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cli-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>GrantsAF_AFProjectBudget_English_2</members>
    <name>OmniScript</name>
  </types>
  <version>62.0</version>
</Package>
`;

/** Stub sf binary answering `org display` and `data query` with canned JSON. */
function writeSfStub(dir, { records = [] } = {}) {
  const bin = path.join(dir, "sf-stub");
  const payload = JSON.stringify(records);
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.startsWith("org display")) {
  console.log(JSON.stringify({ status: 0, result: { instanceUrl: "https://stub.my.salesforce.com", accessToken: "stub-token" } }));
} else if (args.startsWith("data query")) {
  console.log(JSON.stringify({ status: 0, result: { records: ${payload} } }));
} else {
  console.log(JSON.stringify({ status: 1, message: "unexpected sf invocation: " + args }));
}
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

function runCli(ws, { records, args = [] } = {}) {
  const sfBin = writeSfStub(ws, { records });
  const summaryFile = path.join(ws, "summary.md");
  const res = spawnSync(process.execPath, [MAIN, "--workspace", ws, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      OMNI_CACHE_REFRESH_SF_BIN: sfBin,
      GITHUB_STEP_SUMMARY: summaryFile,
      CAIRNCI_WORKSPACE: ws,
    },
  });
  return { ...res, summaryFile };
}

describe("main.mjs CLI", () => {
  test("no manifest -> notice + exit 0 (fast no-op)", () => {
    const ws = tmp();
    const res = runCli(ws);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /no deploy manifest/);
  });

  test("manifest without Omni components -> notice + exit 0", () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, "changed-sources", "package"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "changed-sources", "package", "package.xml"),
      MANIFEST.replace(/OmniScript/g, "ApexClass"),
    );
    const res = runCli(ws);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /no OmniStudio Standard Runtime components/);
  });

  test("in-sync component -> exit 0, summary row, no warnings", () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, "changed-sources", "package"), { recursive: true });
    fs.writeFileSync(path.join(ws, "changed-sources", "package", "package.xml"), MANIFEST);
    const res = runCli(ws, {
      records: [{ Id: "0jN1", UniqueName: "GrantsAF_AFProjectBudget_English_2", IsActive: true, VersionNumber: 2 }],
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /::warning::/);
    assert.match(fs.readFileSync(res.summaryFile, "utf8"), /in-sync/);
  });

  test("source-inactive component is skipped, exit 0", () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, "changed-sources", "package"), { recursive: true });
    fs.writeFileSync(path.join(ws, "changed-sources", "package", "package.xml"), MANIFEST);
    const srcDir = path.join(ws, "changed-sources", "force-app", "main", "default", "omniScripts");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "GrantsAF_AFProjectBudget_English_2.os-meta.xml"),
      '<?xml version="1.0"?><OmniScript><isActive>false</isActive></OmniScript>',
    );
    const res = runCli(ws, {
      records: [{ Id: "0jN1", UniqueName: "GrantsAF_AFProjectBudget_English_2", IsActive: false, VersionNumber: 2 }],
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /skipped/);
    assert.doesNotMatch(res.stdout, /::warning::/);
  });

  test("malformed policy JSON -> ::error + exit 2 (a config bug should be loud)", () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, ".cairnci"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".cairnci", "omnistudio-standard-runtime-policy.json"), "{broken");
    const res = runCli(ws);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /::error::OmniStudio \(Standard Runtime\):/);
  });

  test("inactive DataRaptor -> exactly one ::warning, exit 10 (warn, non-blocking)", () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, "changed-sources", "package"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "changed-sources", "package", "package.xml"),
      MANIFEST.replace(/OmniScript/g, "OmniDataTransform").replace(
        "GrantsAF_AFProjectBudget_English_2",
        "PSSDRTransformClientRecord_1",
      ),
    );
    const res = runCli(ws, {
      records: [{ Id: "0jD1", UniqueName: "PSSDRTransformClientRecord_1", IsActive: false, VersionNumber: 1 }],
    });
    assert.equal(res.status, 10, res.stdout + res.stderr);
    const warnings = res.stdout.split("\n").filter((l) => l.startsWith("::warning::"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /PSSDRTransformClientRecord_1/);
  });
});
