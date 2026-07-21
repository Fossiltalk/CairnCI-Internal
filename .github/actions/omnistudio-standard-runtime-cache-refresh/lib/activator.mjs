// Headless-browser activation driver. Drives the org's own compile/activation
// Visualforce pages — the same thing the Designer's Activate button does —
// and watches their DOM completion signals, which surface compile errors the
// Setup UI never shows (design doc §5, §8c).
//
// puppeteer-core is imported lazily inside launchBrowser() so unit tests can
// import this module and inject a fake `launch` without node_modules present.
// puppeteer-core ships no browser: we use the runner's preinstalled Chrome.
//
// DOM signals (confirmed from the live pages' markup):
//   OmniLwcCompile        -> <p id="compiler-message"> text becomes "DONE",
//                            or "ERROR: ..." on failure
//   FlexCardCompilePage   -> a div.compileMessage containing "DONE SUCCESSFULLY"
//                            is injected into #lightning on success

import fs from "node:fs";

import { compileUrlFor, frontdoorUrl } from "./cache-refresh.mjs";

const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/opt/google/chrome/chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** Resolve a Chrome/Chromium binary: setting > env vars > known paths. */
export function findBrowserExecutable(settings, env = process.env, exists = fs.existsSync) {
  const candidates = [
    settings.browserExecutable,
    env.PUPPETEER_EXECUTABLE_PATH,
    env.CHROME_PATH,
    env.CHROME_BIN,
    ...CHROME_CANDIDATES,
  ].filter(Boolean);
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

async function launchBrowser(executablePath) {
  const { default: puppeteer } = await import("puppeteer-core");
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

const SIGNALS = {
  // Returns a string verdict once the page reaches a terminal state, else null.
  OmniProcess: `(() => {
    const el = document.getElementById("compiler-message");
    const text = (el && el.textContent || "").trim();
    if (text === "DONE") return "ok";
    if (text.startsWith("ERROR")) return "error";
    return null;
  })()`,
  OmniUiCard: `(() => {
    const els = document.querySelectorAll(".compileMessage");
    for (const el of els) {
      const text = (el.textContent || "").trim();
      if (text.includes("DONE SUCCESSFULLY")) return "ok";
      if (text.toUpperCase().includes("ERROR")) return "error";
    }
    return null;
  })()`,
};

async function pageText(page) {
  try {
    return await page.evaluate("document.body ? document.body.innerText : ''");
  } catch {
    return "(page text unavailable)";
  }
}

async function driveOne(page, entry, settings, session, logger) {
  const url = session.instanceUrl.replace(/\/+$/, "") + compileUrlFor(entry, settings);
  const timeoutMs = settings.activationTimeoutSeconds * 1000;
  const attempts = settings.activationRetries + 1;
  let lastDetail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const handle = await page.waitForFunction(SIGNALS[entry.family], {
        timeout: timeoutMs,
        polling: 500,
      });
      const verdict = await handle.jsonValue();
      if (verdict === "ok") return { ok: true };
      // Terminal error state: capture the page's full text — this is the
      // error detail the Setup UI hides, and the whole point of the browser.
      lastDetail = `activation page reported an error: ${(await pageText(page)).slice(0, 2000)}`;
    } catch (e) {
      lastDetail = `activation attempt timed out or crashed after ${settings.activationTimeoutSeconds}s: ${e.message}. Page text: ${(await pageText(page)).slice(0, 2000)}`;
    }
    logger.log(`${entry.uniqueName}: attempt ${attempt}/${attempts} failed — ${lastDetail.slice(0, 300)}`);
  }
  return { ok: false, detail: lastDetail };
}

/**
 * Activate each planned entry sequentially with one shared browser (§11:
 * launch once per run, clean teardown even on failure). `recheck(entries)`
 * re-runs the SOQL sync check for the entries just activated and returns the
 * set of UniqueNames now confirmed active — the SOQL layer stays the source
 * of truth (§9). `launch` and `findExecutable` are injectable for tests.
 *
 * A missing browser is an expected environment, not an error: some runners
 * (self-hosted, containers) ship no Chrome. Every pending entry then becomes
 * a warn outcome — the job never fails over a missing dependency, and the
 * components are re-detected as out of sync on the next run (§9).
 */
export async function activateAll({
  entries,
  settings,
  session,
  recheck,
  logger = console,
  launch = launchBrowser,
  findExecutable = findBrowserExecutable,
}) {
  const outcomes = [];
  if (entries.length === 0) return outcomes;

  const executablePath = findExecutable(settings);
  if (!executablePath) {
    for (const e of entries) {
      outcomes.push({
        uniqueName: e.uniqueName,
        family: e.family,
        ok: false,
        detail: "no Chrome/Chromium executable found (set browser-executable or CHROME_PATH) — component left unactivated",
      });
    }
    return outcomes;
  }

  let browser;
  try {
    browser = await launch(executablePath);
    const page = await browser.newPage();
    // frontdoor.jsp logs the browser session in with the deploy job's access
    // token; land on the first compile URL directly.
    const first = compileUrlFor(entries[0], settings);
    await page.goto(frontdoorUrl(session.instanceUrl, session.accessToken, first), {
      waitUntil: "domcontentloaded",
      timeout: settings.activationTimeoutSeconds * 1000,
    });

    const driven = [];
    for (const entry of entries) {
      const res = await driveOne(page, entry, settings, session, logger);
      driven.push({ entry, res });
    }

    // Page said OK is not enough — confirm via SOQL re-query (§8c step 4).
    const saidOk = driven.filter((d) => d.res.ok).map((d) => d.entry);
    const confirmed = saidOk.length > 0 ? await recheck(saidOk) : new Set();
    for (const { entry, res } of driven) {
      if (res.ok && confirmed.has(entry.uniqueName)) {
        outcomes.push({ uniqueName: entry.uniqueName, family: entry.family, ok: true });
      } else if (res.ok) {
        outcomes.push({
          uniqueName: entry.uniqueName,
          family: entry.family,
          ok: false,
          detail: "activation page reported success but the SOQL re-check does not show the component active",
        });
      } else {
        outcomes.push({ uniqueName: entry.uniqueName, family: entry.family, ok: false, detail: res.detail });
      }
    }
  } catch (e) {
    // Browser-level failure (launch, frontdoor, crash): every entry without an
    // outcome yet is unconfirmed — a warning, never a job failure.
    const done = new Set(outcomes.map((o) => o.uniqueName));
    for (const entry of entries) {
      if (!done.has(entry.uniqueName)) {
        outcomes.push({
          uniqueName: entry.uniqueName,
          family: entry.family,
          ok: false,
          detail: `headless browser failed before this component could be activated: ${e.message}`,
        });
      }
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* teardown best-effort */
      }
    }
  }
  return outcomes;
}
