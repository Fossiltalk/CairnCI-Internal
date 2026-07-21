// Unit tests for the omnistudio-standard-runtime-cache-refresh lib and
// orchestrator. Node built-in runner only; the org and the browser are
// stubbed — nothing here touches a Salesforce org or launches Chrome.
//   node --test .github/actions/omnistudio-standard-runtime-cache-refresh/tests/cache-refresh.test.mjs

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ConfigError,
  DEFAULTS,
  parsePolicy,
  resolveSettings,
  parseManifest,
  versionFromUniqueName,
  sourceIntendsActive,
  buildQueries,
  planActivations,
  compileUrlFor,
  frontdoorUrl,
  resultRows,
  warningLines,
  buildStepSummary,
  exitCodeFor,
  actionExitCode,
} from "../lib/cache-refresh.mjs";
import { findBrowserExecutable } from "../lib/activator.mjs";
import { run } from "../refresh.mjs";

// --- fixtures ---------------------------------------------------------------

const OS_KEY = "GrantsAF_AFProjectBudget_English_2";
const FC_KEY = "AFEducationDetails_Salesforce_1";
const DRT_KEY = "PSSDRTransformClientRecord_1";

function manifestXml(entries) {
  const blocks = entries
    .map(([type, member]) => `  <types>\n    <members>${member}</members>\n    <name>${type}</name>\n  </types>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${blocks}\n  <version>62.0</version>\n</Package>\n`;
}

let dirs = [];
function tmpWorkspace() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omni-refresh-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function captureLogger() {
  const lines = [];
  return { lines, log: (s) => lines.push(String(s)) };
}

/** Workspace with a manifest (and optional policy), plus run() plumbing. */
function harness({ manifestEntries, policy, argv = [] } = {}) {
  const ws = tmpWorkspace();
  fs.mkdirSync(path.join(ws, "changed-sources", "package"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "changed-sources", "package", "package.xml"),
    manifestXml(manifestEntries ?? [["OmniScript", OS_KEY]]),
  );
  if (policy !== undefined) {
    fs.mkdirSync(path.join(ws, ".cairnci"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".cairnci", "omnistudio-standard-runtime-policy.json"), policy);
  }
  const summaryFile = path.join(ws, "summary.md");
  const logger = captureLogger();
  const env = { CAIRNCI_WORKSPACE: ws, GITHUB_STEP_SUMMARY: summaryFile };
  return { ws, summaryFile, logger, env, argv: ["--workspace", ws, ...argv] };
}

function orgRecord(key, { active = true, id = "0jNKa0000012345MAA", version = 2 } = {}) {
  return { Id: id, UniqueName: key, IsActive: active, VersionNumber: version };
}

// --- settings & policy ------------------------------------------------------

describe("parsePolicy", () => {
  test("empty/missing text is an empty policy", () => {
    assert.deepEqual(parsePolicy(null), {});
    assert.deepEqual(parsePolicy("  "), {});
  });

  test("malformed JSON, non-objects, and unknown keys are ConfigErrors", () => {
    assert.throws(() => parsePolicy("{nope"), ConfigError);
    assert.throws(() => parsePolicy("[1]"), ConfigError);
    assert.throws(() => parsePolicy('{"unknownSetting": 1}'), ConfigError);
  });
});

describe("resolveSettings", () => {
  test("defaults apply when nothing is provided", () => {
    const s = resolveSettings({});
    assert.equal(s.omniscriptCompilePage, DEFAULTS.omniscriptCompilePage);
    assert.equal(s.activationTimeoutSeconds, 120);
    assert.equal(s.activationMode, "out-of-sync-only");
  });

  test("policy file overrides defaults", () => {
    const s = resolveSettings({ policy: { activationTimeoutSeconds: 300 } });
    assert.equal(s.activationTimeoutSeconds, 300);
  });

  test("input wins over policy file (documented precedence: input > file > default)", () => {
    const s = resolveSettings({
      inputs: { activationTimeoutSeconds: "33", flexcardCompilePage: "/apex/CustomFC" },
      policy: { activationTimeoutSeconds: 999, flexcardCompilePage: "/apex/PolicyFC" },
    });
    assert.equal(s.activationTimeoutSeconds, 33);
    assert.equal(s.flexcardCompilePage, "/apex/CustomFC");
  });

  test("bad integers and bad modes are ConfigErrors", () => {
    assert.throws(() => resolveSettings({ inputs: { activationRetries: "lots" } }), ConfigError);
    assert.throws(() => resolveSettings({ inputs: { activationTimeoutSeconds: "-5" } }), ConfigError);
    assert.throws(() => resolveSettings({ inputs: { activationMode: "yolo" } }), ConfigError);
  });
});

// --- manifest & source parsing ----------------------------------------------

describe("parseManifest", () => {
  test("extracts the four Omni Metadata API types and maps them to SObject families", () => {
    const xml = manifestXml([
      ["OmniScript", OS_KEY],
      ["OmniIntegrationProcedure", "BM_Determine_Procedure_1"],
      ["OmniUiCard", FC_KEY],
      ["OmniDataTransform", DRT_KEY],
      ["ApexClass", "SomeClass"],
    ]);
    const comps = parseManifest(xml);
    assert.equal(comps.length, 4);
    const families = Object.fromEntries(comps.map((c) => [c.uniqueName, c.family]));
    // OmniScript AND OmniIntegrationProcedure are one SObject: OmniProcess.
    assert.equal(families[OS_KEY], "OmniProcess");
    assert.equal(families.BM_Determine_Procedure_1, "OmniProcess");
    assert.equal(families[FC_KEY], "OmniUiCard");
    assert.equal(families[DRT_KEY], "OmniDataTransform");
  });

  test("ignores empty manifests, wildcards, and non-Omni types", () => {
    assert.deepEqual(parseManifest(""), []);
    assert.deepEqual(parseManifest(manifestXml([["ApexClass", "Foo"]])), []);
    assert.deepEqual(parseManifest(manifestXml([["OmniScript", "*"]])), []);
  });
});

describe("versionFromUniqueName / sourceIntendsActive", () => {
  test("trailing _N is the version", () => {
    assert.equal(versionFromUniqueName(OS_KEY), 2);
    assert.equal(versionFromUniqueName("NoVersionHere"), null);
  });

  test("source intends active unless isActive is explicitly false", () => {
    assert.equal(sourceIntendsActive("<OmniScript><isActive>false</isActive></OmniScript>"), false);
    assert.equal(sourceIntendsActive("<OmniScript><isActive>true</isActive></OmniScript>"), true);
    assert.equal(sourceIntendsActive("<OmniScript/>"), true);
    assert.equal(sourceIntendsActive(null), true);
  });
});

describe("buildQueries", () => {
  test("one query per SObject family, keys quoted, SObject names only", () => {
    const comps = parseManifest(
      manifestXml([
        ["OmniScript", OS_KEY],
        ["OmniIntegrationProcedure", "IP_One_Procedure_1"],
        ["OmniUiCard", FC_KEY],
      ]),
    );
    const queries = buildQueries(comps);
    assert.equal(queries.length, 2);
    const byFamily = Object.fromEntries(queries.map((q) => [q.family, q.soql]));
    assert.match(byFamily.OmniProcess, /FROM OmniProcess WHERE UniqueName IN \('GrantsAF_AFProjectBudget_English_2', 'IP_One_Procedure_1'\)/);
    assert.match(byFamily.OmniUiCard, /FROM OmniUiCard WHERE/);
    // Never the Metadata API type names on the SOQL layer (design doc §5).
    assert.doesNotMatch(byFamily.OmniProcess, /OmniScript|OmniIntegrationProcedure/);
  });

  test("quotes are escaped", () => {
    const [q] = buildQueries([{ family: "OmniProcess", uniqueName: "O'Brien_1" }]);
    assert.ok(q.soql.includes("'O\\'Brien_1'"));
  });
});

// --- planning ----------------------------------------------------------------

describe("planActivations", () => {
  test("active org record is in sync; inactive is planned for activation", () => {
    const comps = [
      { family: "OmniProcess", uniqueName: OS_KEY },
      { family: "OmniUiCard", uniqueName: FC_KEY },
    ];
    const records = [
      { family: "OmniProcess", ...orgRecord(OS_KEY, { active: true }) },
      { family: "OmniUiCard", ...orgRecord(FC_KEY, { active: false, id: "0jFC" }) },
    ];
    const plan = planActivations({ components: comps, records });
    assert.equal(plan.inSync.length, 1);
    assert.equal(plan.toActivate.length, 1);
    assert.equal(plan.toActivate[0].recordId, "0jFC");
  });

  test("inactive DataRaptor has no page -> noPage (warn only); absent record -> missing", () => {
    const comps = [
      { family: "OmniDataTransform", uniqueName: DRT_KEY },
      { family: "OmniProcess", uniqueName: "Ghost_Component_English_1" },
    ];
    const records = [{ family: "OmniDataTransform", ...orgRecord(DRT_KEY, { active: false }) }];
    const plan = planActivations({ components: comps, records });
    assert.equal(plan.noPage.length, 1);
    assert.equal(plan.missing.length, 1);
    assert.equal(plan.toActivate.length, 0);
  });

  test("source-inactive components are skipped, not activated", () => {
    const comps = [{ family: "OmniProcess", uniqueName: OS_KEY, intendsActive: false }];
    const records = [{ family: "OmniProcess", ...orgRecord(OS_KEY, { active: false }) }];
    const plan = planActivations({ components: comps, records });
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.toActivate.length, 0);
  });

  test("mode 'always' re-activates even active components", () => {
    const comps = [{ family: "OmniProcess", uniqueName: OS_KEY }];
    const records = [{ family: "OmniProcess", ...orgRecord(OS_KEY, { active: true }) }];
    const plan = planActivations({ components: comps, records, mode: "always" });
    assert.equal(plan.toActivate.length, 1);
  });
});

// --- URLs -------------------------------------------------------------------

describe("compileUrlFor / frontdoorUrl", () => {
  const settings = resolveSettings({});

  test("OmniProcess uses the OmniScript compiler page with activate=true", () => {
    const url = compileUrlFor({ family: "OmniProcess", recordId: "0jN123" }, settings);
    assert.equal(url, "/apex/omnistudio__OmniLwcCompile?id=0jN123&activate=true");
  });

  test("OmniUiCard uses the FlexCard compile page", () => {
    const url = compileUrlFor({ family: "OmniUiCard", recordId: "0jF456" }, settings);
    assert.equal(url, "/apex/omnistudio__FlexCardCompilePage?id=0jF456");
  });

  test("frontdoor URL embeds the session and encodes the retURL", () => {
    const url = frontdoorUrl("https://x.my.salesforce.com/", "00D!token", "/apex/p?id=1&activate=true");
    assert.ok(url.startsWith("https://x.my.salesforce.com/secur/frontdoor.jsp?sid=00D!token&retURL="));
    assert.ok(url.includes(encodeURIComponent("/apex/p?id=1&activate=true")));
  });
});

describe("findBrowserExecutable", () => {
  test("setting > env > known paths; null when nothing exists", () => {
    const exists = (p) => p === "/from/setting" || p === "/from/env";
    assert.equal(findBrowserExecutable({ browserExecutable: "/from/setting" }, { CHROME_PATH: "/from/env" }, exists), "/from/setting");
    assert.equal(findBrowserExecutable({ browserExecutable: "" }, { CHROME_PATH: "/from/env" }, exists), "/from/env");
    assert.equal(findBrowserExecutable({ browserExecutable: "" }, {}, () => false), null);
  });
});

// --- reporting & exit codes -------------------------------------------------

describe("reporting", () => {
  test("warning lines carry the documented prefix, one per warning row", () => {
    const rows = resultRows(
      { inSync: [], skipped: [], missing: [], noPage: [] },
      [{ uniqueName: OS_KEY, family: "OmniProcess", ok: false, detail: "timed out" }],
    );
    const lines = warningLines(rows);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^OmniStudio \(Standard Runtime\): GrantsAF_AFProjectBudget_English_2/);
  });

  test("step summary renders one table row per component", () => {
    const rows = [
      { uniqueName: OS_KEY, family: "OmniProcess", status: "in-sync", detail: "d" },
      { uniqueName: FC_KEY, family: "OmniUiCard", status: "warning", detail: "w" },
    ];
    const md = buildStepSummary(rows);
    assert.ok(md.includes(`\`${OS_KEY}\``));
    assert.ok(md.includes("warning"));
  });

  test("exit codes: warn is 10 at the CLI, 0 at the action; never 1", () => {
    assert.equal(exitCodeFor([{ status: "in-sync" }]), 0);
    assert.equal(exitCodeFor([{ status: "reactivated" }]), 0);
    assert.equal(exitCodeFor([{ status: "warning" }]), 10);
    assert.equal(actionExitCode(10), 0);
    assert.equal(actionExitCode(0), 0);
    assert.equal(actionExitCode(2), 2);
  });
});

// --- required end-to-end orchestrator tests (org + browser stubbed) ---------

describe("run() with stubbed org and browser", () => {
  test("test_in_sync_component_skips_activation", async () => {
    const h = harness();
    let activateCalls = 0;
    const io = {
      soqlQuery: () => [orgRecord(OS_KEY, { active: true })],
      orgSession: () => {
        throw new Error("orgSession must not be called for in-sync components");
      },
      activateAll: async () => {
        activateCalls++;
        return [];
      },
    };
    const code = await run({ argv: h.argv, env: h.env, logger: h.logger, io });
    assert.equal(activateCalls, 0, "in-sync component must never trigger activation");
    assert.equal(code, 0);
  });

  test("test_out_of_sync_success_no_warning", async () => {
    const h = harness();
    const io = {
      soqlQuery: () => [orgRecord(OS_KEY, { active: false })],
      orgSession: () => ({ instanceUrl: "https://x.my.salesforce.com", accessToken: "t" }),
      activateAll: async ({ entries }) =>
        entries.map((e) => ({ uniqueName: e.uniqueName, family: e.family, ok: true })),
    };
    const code = await run({ argv: h.argv, env: h.env, logger: h.logger, io });
    const warnings = h.logger.lines.filter((l) => l.startsWith("::warning::"));
    assert.equal(warnings.length, 0, "successful reactivation must produce no ::warning");
    assert.ok(h.logger.lines.some((l) => l.includes(`${OS_KEY} (OmniProcess): reactivated`)));
    assert.equal(code, 0, "the action's exit code is 0");
    assert.ok(fs.readFileSync(h.summaryFile, "utf8").includes("reactivated"));
  });

  test("test_out_of_sync_failure_emits_warning", async () => {
    const h = harness();
    const io = {
      soqlQuery: () => [orgRecord(OS_KEY, { active: false })],
      orgSession: () => ({ instanceUrl: "https://x.my.salesforce.com", accessToken: "t" }),
      activateAll: async ({ entries }) =>
        entries.map((e) => ({ uniqueName: e.uniqueName, family: e.family, ok: false, detail: "activation timed out" })),
    };
    const code = await run({ argv: h.argv, env: h.env, logger: h.logger, io });

    const warnings = h.logger.lines.filter((l) => l.startsWith("::warning::"));
    assert.equal(warnings.length, 1, "exactly one ::warning for the failed component");
    assert.ok(warnings[0].includes(OS_KEY), "the warning names the component");

    const summary = fs.readFileSync(h.summaryFile, "utf8");
    assert.ok(summary.includes(`\`${OS_KEY}\``), "job summary gets a row for the component");
    assert.ok(summary.includes("warning"));

    assert.equal(code, 10, "CLI signals warn (10) per the extension contract");
    assert.equal(actionExitCode(code), 0, "the action's exit code is still 0 — never fails the job");
  });

  test("test_policy_file_precedence", async () => {
    const h = harness({
      policy: JSON.stringify({ activationTimeoutSeconds: 999, activationMode: "always" }),
      argv: ["--activation-timeout-seconds", "33"],
    });
    let seenSettings = null;
    const io = {
      // mode 'always' (from the policy) forces an activation even though the
      // org shows the component active, so run() must consult the settings.
      soqlQuery: () => [orgRecord(OS_KEY, { active: true })],
      orgSession: () => ({ instanceUrl: "https://x.my.salesforce.com", accessToken: "t" }),
      activateAll: async ({ entries, settings }) => {
        seenSettings = settings;
        return entries.map((e) => ({ uniqueName: e.uniqueName, family: e.family, ok: true }));
      },
    };
    const code = await run({ argv: h.argv, env: h.env, logger: h.logger, io });
    assert.equal(code, 0);
    assert.ok(seenSettings, "activation ran under mode 'always' from the policy file");
    assert.equal(seenSettings.activationMode, "always", "policy value applies where no input was given");
    assert.equal(seenSettings.activationTimeoutSeconds, 33, "explicit input wins over the policy-file value");
  });
});
