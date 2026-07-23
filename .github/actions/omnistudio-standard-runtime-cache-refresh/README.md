# OmniStudio Standard Runtime — Cache Refresh

**This does not apply to OmniStudio for Managed Packages (`vlocity_cmt`
namespace).** Managed-package orgs have different objects, a different
activation URL, and established tooling (VBT); see the design notes in
`docs/omnistudio-standard-runtime.md`.

A post-deploy extension for OmniStudio **Standard Runtime** orgs. The Metadata
API path moves OmniScript / Integration Procedure / FlexCard *definitions*
correctly but does not trigger the compile/activation side effects the
Designer's **Activate** button performs, so deployed components can silently
stay stale for end users. After an OmniStudio-first deploy this action:

1. **Discovers** the deployed components from the deploy's own delta manifest
   (`changed-sources/package/package.xml` by default) — Metadata API types
   `OmniScript`, `OmniIntegrationProcedure`, `OmniUiCard`, `OmniDataTransform`.
2. **Checks sync via SOQL** on the *SObject* layer — `OmniProcess` (one
   SObject covering both OmniScripts and Integration Procedures), `OmniUiCard`,
   `OmniDataTransform` — comparing `UniqueName` / `IsActive` /
   `VersionNumber`. The manifest member fullName equals the SObject
   `UniqueName` (version suffix included), so the lookup is exact. In-sync
   components are skipped: re-running against an in-sync org is a fast no-op.
3. **Reactivates only what needs it** by driving the org's own
   compile/activation Visualforce pages with a headless browser
   (puppeteer-core + the runner's preinstalled Chrome), authenticated by
   reusing the deploy job's existing `sf` session via `frontdoor.jsp` — this
   action has **no credential inputs and stores nothing**. The pages surface
   compile errors the Setup UI hides; on failure the full page text is
   captured into the log and job summary.
   - OmniScripts / Integration Procedures:
     `/apex/omnistudio__OmniLwcCompile?id=<recordId>&activate=true`, watching
     `#compiler-message` for `DONE` / `ERROR: …`
   - FlexCards: `/apex/omnistudio__FlexCardCompilePage?id=<recordId>`,
     watching for a `.compileMessage` containing `DONE SUCCESSFULLY`
   - DataRaptors (`OmniDataTransform`) have no compile page (they are not
     LWC-compiled); an out-of-sync DataRaptor is reported as a warning only.
4. **Confirms via SOQL re-query** — a page-reported success only counts once
   the org actually shows the component active — then reports a job-summary
   table plus one `::warning` annotation per unconfirmed component, prefixed
   `OmniStudio (Standard Runtime):`.

## Warn-only by design (deviation from the gate extensions)

The gate extensions (`field-governance-gate`, `permset-access-gate`) fail the
check on an error-severity finding, and severity is theirs to configure.
**This action never fails the job for a reactivation problem** — a failed,
timed-out, or unconfirmable
activation exits 0 (after `::warning` annotations and job-summary rows), and
no rollback is attempted. That is deliberate, not an oversight: a reactivation
failure is not a deploy failure, and the SOQL check re-flags anything still
out of sync on every subsequent run until it is fixed — drift is always either
fixed or loudly visible, never silent. Hence also no `-gate` in the name.

The same applies to missing dependencies: if no Chrome/Chromium is found on
the runner (some self-hosted/container runners ship none), or the browser
fails to launch, every component that needed activation is reported as a
warning and the job still succeeds — install Chrome or set
`browser-executable` / `CHROME_PATH` to enable activation on such runners.

Exit codes (CairnCI extension contract):

| Exit | Meaning | Composite-action effect |
|---|---|---|
| `0` | in sync / reactivated / nothing to do | step succeeds |
| `10` | warn: component(s) unconfirmed | mapped to `::warning` + **exit 0** |
| `2` | config error (e.g. malformed policy JSON) | step fails (a consumer config bug should be loud) |

## Configuration and precedence

Every setting is available as an action input and as a key in an optional
policy file (default `.cairnci/omnistudio-standard-runtime-policy.json`; see
`examples/omnistudio-standard-runtime-policy.json`).

**Precedence: explicit input > policy file > built-in default.** This matches
core CairnCI's `.cairnci/config.json` convention, and deliberately reverses the
file-wins-over-input choice made by the retired `field-permset-gate` —
resolving the known inconsistency between the two conventions in favor of
core's. (The gate extensions have since dropped input-level policy entirely:
their config file is the single source.)

| Input | Policy key | Default | Notes |
|---|---|---|---|
| `manifest` | `manifest` | `changed-sources/package/package.xml` | deploy's delta manifest; missing file = nothing to check |
| `deploy-dir` | `deployDir` | `changed-sources` | deployed source, read for intended active state (`<isActive>false</isActive>` in source = never force-activated) |
| `policy-file` | — | `.cairnci/omnistudio-standard-runtime-policy.json` | |
| `target-org` | `targetOrg` | *(default org)* | `sf` alias/username of the already-authenticated session |
| `omniscript-compile-page` | `omniscriptCompilePage` | `/apex/omnistudio__OmniLwcCompile` | confirmed against a live Standard Runtime org; override if your namespace differs |
| `flexcard-compile-page` | `flexcardCompilePage` | `/apex/omnistudio__FlexCardCompilePage` | 〃 |
| `activation-timeout-seconds` | `activationTimeoutSeconds` | `120` | per attempt; raise for sandboxes (known to be slower here) |
| `activation-retries` | `activationRetries` | `1` | retries after the first failed attempt |
| `activation-mode` | `activationMode` | `out-of-sync-only` | `always` re-activates every deployed component (for flag-active-but-stale-cache drift SOQL cannot see) |
| `browser-executable` | `browserExecutable` | *(probe)* | falls back to `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` / `CHROME_BIN` / known runner paths |

## Usage

As a job step after the deploy (same job as the authenticated `sf` session,
so the manifest and session are still present), or via the extension caller:

```yaml
- name: OmniStudio Standard Runtime — Cache Refresh
  uses: Fossiltalk/CairnCI-Extensions/.github/actions/omnistudio-standard-runtime-cache-refresh@omnistudio-standard-runtime-cache-refresh/v1
```

```jsonc
// .cairnci/extensions.json
{
  "extensions": [
    {
      "id": "omnistudio-standard-runtime-cache-refresh",
      "phases": ["post-deploy-success"],
      "blocking": false,
      "run": {
        "type": "git",
        "repo": "https://github.com/Fossiltalk/CairnCI-Extensions.git",
        "ref": "omnistudio-standard-runtime-cache-refresh/v1.0.0",
        "entry": ".github/actions/omnistudio-standard-runtime-cache-refresh/run.sh"
      }
    }
  ]
}
```

Pair it with an OmniStudio-first deploy (the core
`omnistudioStandardRuntimeFirst` config) — this extension only checks and
refreshes; it never deploys anything itself.

## Packaging (deviation from the dependency-free convention)

Sibling extensions are dependency-free Node. This one cannot be: driving the
activation pages requires a real headless browser. It therefore carries
`puppeteer-core` as a real `package.json` dependency, **bundled at development
time with `@vercel/ncc` into the checked-in `dist/`** — consumers still get
the standard zero-install experience (`action.yml` runs `node dist/index.mjs`;
no `npm install` at run time, and puppeteer-core downloads no browser: the
runner's preinstalled Chrome is used). After editing source, run `npm run
build` and commit `dist/`; CI fails if `dist/` is stale.

## Development

```bash
cd .github/actions/omnistudio-standard-runtime-cache-refresh
npm test          # node --test tests/*.test.mjs — org and browser stubbed
npm run build     # rebuild dist/ (required before committing source changes)
```

### Live-org validation (read-only)

`tests/live-org.test.mjs` re-verifies every real-org assumption the unit
suite stubs — SObject fields, default compile-page paths, the metadata
`fullName` = SObject `UniqueName` key mapping, session reuse, and the bundled
CLI end-to-end for the in-sync and missing-component paths. It self-skips
unless an org alias is provided, so CI stays org-free:

```bash
OMNI_CACHE_REFRESH_LIVE_ORG=<sf org alias> npm test
```

Everything in that suite is read-only against the org.

### Live-org activation round trip (state-changing)

`tests/live-org-activation.test.mjs` covers the one thing the read-only suite
cannot: the real browser activation. It deploys a dedicated throwaway
OmniScript (`tests/fixtures/CairnCITest_CacheRefreshProbe_English_1`) to the
org **inactive** — the genuine drift state — runs the shipped bundle
end-to-end (frontdoor session reuse → headless Chrome on the real
`omnistudio__OmniLwcCompile` page → SOQL re-check flips `IsActive`), then
verifies that re-deploying the inactive source deactivates the record again
(the Metadata API keeps-source-state behavior this extension exists to
compensate for) and destructively deletes the probe. Cleanup runs before and
after, so crashed runs leave no residue. Because it deploys and deletes
metadata it has its own gate — **point it only at an org designated for CI
testing, never a real production org**:

```bash
OMNI_CACHE_REFRESH_LIVE_ACTIVATION_ORG=<ci test org alias> npm test
```

Requires a local Chrome/Chromium and an authenticated `sf` CLI session for
the alias.
