// Unit tests for the activation driver's environment/dependency handling:
// browser present, browser absent, and browser broken. All fakes — no
// Chrome, no puppeteer-core, no org. The invariant under test: a missing or
// failing browser dependency NEVER throws out of activateAll and never
// produces anything stronger than warn outcomes (design §9 — some runners
// legitimately have no Chrome).
//   node --test .github/actions/omnistudio-standard-runtime-cache-refresh/tests/activator.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { activateAll } from "../lib/activator.mjs";
import { resolveSettings } from "../lib/cache-refresh.mjs";

const SETTINGS = resolveSettings({ inputs: { activationTimeoutSeconds: "1", activationRetries: "0" } });
const SESSION = { instanceUrl: "https://x.my.salesforce.com", accessToken: "t" };
const ENTRIES = [
  { uniqueName: "Probe_One_English_1", family: "OmniProcess", recordId: "0jN1" },
  { uniqueName: "CardProbe_Auth_1", family: "OmniUiCard", recordId: "0jF1" },
];
const quiet = { log: () => {} };

/** Minimal fake of the puppeteer surface activateAll touches. */
function fakeBrowser({ verdict = "ok", gotoError = null } = {}) {
  const calls = { goto: [], closed: 0 };
  const page = {
    goto: async (url) => {
      calls.goto.push(url);
      if (gotoError) throw new Error(gotoError);
    },
    waitForFunction: async () => ({ jsonValue: async () => verdict }),
    evaluate: async () => "full page text for diagnostics",
  };
  const browser = {
    newPage: async () => page,
    close: async () => {
      calls.closed++;
    },
  };
  return { browser, calls };
}

describe("activateAll dependency scenarios", () => {
  test("no browser installed: every entry warns, launch is never attempted, nothing throws", async () => {
    let launched = 0;
    const outcomes = await activateAll({
      entries: ENTRIES,
      settings: SETTINGS,
      session: SESSION,
      recheck: async () => new Set(),
      logger: quiet,
      findExecutable: () => null,
      launch: async () => {
        launched++;
        throw new Error("must not be called");
      },
    });
    assert.equal(launched, 0);
    assert.equal(outcomes.length, ENTRIES.length);
    for (const o of outcomes) {
      assert.equal(o.ok, false);
      assert.match(o.detail, /no Chrome\/Chromium executable found/);
    }
  });

  test("browser dependency broken (launch throws, e.g. puppeteer-core missing): all entries warn with the cause", async () => {
    const outcomes = await activateAll({
      entries: ENTRIES,
      settings: SETTINGS,
      session: SESSION,
      recheck: async () => new Set(),
      logger: quiet,
      findExecutable: () => "/fake/chrome",
      launch: async () => {
        throw new Error("Cannot find module 'puppeteer-core'");
      },
    });
    assert.equal(outcomes.length, ENTRIES.length);
    for (const o of outcomes) {
      assert.equal(o.ok, false);
      assert.match(o.detail, /Cannot find module 'puppeteer-core'/);
    }
  });

  test("browser present and page succeeds: outcomes ok only when the SOQL re-check confirms", async () => {
    const { browser, calls } = fakeBrowser({ verdict: "ok" });
    const outcomes = await activateAll({
      entries: ENTRIES,
      settings: SETTINGS,
      session: SESSION,
      // Only the first component is confirmed active by the re-query.
      recheck: async () => new Set([ENTRIES[0].uniqueName]),
      logger: quiet,
      findExecutable: () => "/fake/chrome",
      launch: async () => browser,
    });
    assert.equal(outcomes[0].ok, true);
    assert.equal(outcomes[1].ok, false);
    assert.match(outcomes[1].detail, /re-check does not show the component active/);
    // frontdoor navigation + one compile page per entry, then teardown.
    assert.match(calls.goto[0], /frontdoor\.jsp/);
    assert.equal(calls.closed, 1, "browser must be closed after the run");
  });

  test("page reports a terminal error: warn outcome carries the captured page text, browser still closed", async () => {
    const { browser, calls } = fakeBrowser({ verdict: "error" });
    const outcomes = await activateAll({
      entries: [ENTRIES[0]],
      settings: SETTINGS,
      session: SESSION,
      recheck: async () => new Set(),
      logger: quiet,
      findExecutable: () => "/fake/chrome",
      launch: async () => browser,
    });
    assert.equal(outcomes[0].ok, false);
    assert.match(outcomes[0].detail, /full page text for diagnostics/);
    assert.equal(calls.closed, 1);
  });

  test("mid-run navigation crash: entries warn and teardown still happens", async () => {
    const { browser, calls } = fakeBrowser({ gotoError: "net::ERR_TIMED_OUT" });
    const outcomes = await activateAll({
      entries: [ENTRIES[0]],
      settings: SETTINGS,
      session: SESSION,
      recheck: async () => new Set(),
      logger: quiet,
      findExecutable: () => "/fake/chrome",
      launch: async () => browser,
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, false);
    assert.equal(calls.closed, 1, "teardown must run even when navigation fails");
  });
});
