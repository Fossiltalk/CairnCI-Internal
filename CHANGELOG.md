# Changelog

All notable changes to CairnCI are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Consumers pin the reusable
workflows by major tag (e.g. `@v1`); see
[docs/consumer-setup.md](docs/consumer-setup.md).

## [Unreleased]

### Added

- **field-governance-gate extension** — an org-free PR gate
  (`.github/actions/field-governance-gate/`) that verifies newly created **and
  modified** Salesforce fields carry the governance metadata the repo requires:
  Description, Help Text, Data Owner, Field Usage, Data Sensitivity Level and
  Compliance Categorization. No org connection and no `sf` CLI — pure git plus
  filesystem. Policy is source-tracked in the consumer repo (default
  `.cairnci/field-governance-gate.json`; see
  `examples/field-governance-gate.json`) and layered: repository-level
  `severity`/`require`, then per-object-family `objectTypes`, then the first
  matching scoped rule, then per-object `objectOverrides`, then per-tag.
  Requirements support `severity`, `minLength`, `allowed` and `pattern`
  constraints, not just presence. Bypass patterns for objects and fields work
  globally and per rule (they union). Follows the extension exit-code contract
  (0 ok, 10 warn, 1 error, 2 config), and annotations are anchored to the field
  file so they land on the PR diff. Released as `field-governance-gate/v1.0.0`.

- **Per-tag severity in `field-governance-gate`** (`field-governance-gate/v1.1.0`)
  — `severity` inside a `require` entry sets the severity for that one tag,
  overriding every layer including `objectOverrides`. It is the only way to
  express "a missing description blocks the PR but a missing tooltip only
  warns": scoped rules match per *field*, not per tag, so every tag in one rule
  otherwise shares its severity. Tags that omit it inherit the resolved layer
  severity, so only the exceptions need naming. Supports the usual adoption
  path — enable a requirement as `warn` everywhere, then promote tags to
  `error` one at a time.

  Because it only audits fields the PR touched, adopting a standard does not
  require backfilling existing metadata first.

### Changed

- **`field-permset-gate` is renamed to `field-governance-gate`** and rewritten
  onto the current extension pattern (`run.sh` + `gate.mjs` + pure `lib/`,
  JSON config, exit-code contract, sticky PR comment). Its permission-set
  *access* checks are not carried over — those belong to `permset-access-gate`,
  which shipped in v1.3.0. `forbid-breaking-field-changes` is dropped as
  out of scope for a governance gate. See the migration table in
  `.github/actions/field-governance-gate/README.md`. Docs and examples that
  used `field-permset-gate` as the running example now reference the new name.

### Fixed

- **`field-governance-gate` silently ignored unknown `require` constraints.** A
  typo'd or unsupported key inside a constraints object was dropped, so a
  policy that looked configured did nothing — a `severty` typo would leave a
  requirement blocking merges with no indication why. Unknown keys are now a
  config error (exit 2) naming the valid set. Shipped in
  `field-governance-gate/v1.1.0`; stricter than v1.0.0, but v1.0.0 was
  published the same day and no consumer config predates it.
- **Data Owner was checked against an element Salesforce rejects.**
  `field-permset-gate` looked for `<businessOwner>`; a check-only deploy against
  a live org fails that outright (`Element ...businessOwner invalid at this
  location in type CustomField`). The real elements are `<businessOwnerUser>`
  and `<businessOwnerGroup>`, either of which now satisfies the requirement.

## [v1.3.0] - 2026-07-21

### Added

- **`omnistudioStandardRuntimeFirst` deploy setting** — opt-in 2-step deploy
  path on `sf-deploy.yml` (config key `omnistudioStandardRuntimeFirst`, input
  `omnistudio-standard-runtime-first`): changed OmniStudio Standard Runtime
  content (`OmniScript`, `OmniIntegrationProcedure`, `OmniDataTransform`,
  `OmniUiCard`) deploys in its own step before the rest of the changed
  metadata, mirroring the `ruleDeploy` split pattern. Adjacent OmniStudio
  config/tracking types stay in the main deploy. Delta mode only; quick deploy
  is bypassed when OmniStudio changes are present. Does not apply to
  managed-package (`vlocity_cmt`) OmniStudio. See
  [docs/consumer-setup.md](docs/consumer-setup.md) §5e.
- **permset-access-gate extension** — an org-free PR gate
  (`.github/actions/permset-access-gate/`) that inspects the current PR's git
  diff for newly created Salesforce custom fields and objects and verifies that
  the permission sets committed in the repo grant a configured minimum access
  level to each. No org connection and no `sf` CLI: pure git plus filesystem,
  so it adds no round trips to the pipeline. Config is source-tracked in the
  consumer repo (default `.cairnci/permset-access-gate.json`; see
  `examples/permset-access-gate.json`) with per-permission-set rules, a
  severity of `error` (blocking) or `warn` (non-blocking), and bypass patterns
  that apply globally or to a single rule. Findings surface as GitHub
  annotations, a job-summary table, and a sticky PR comment listing every
  missing permission, with an exit code following the extension contract
  (`0` ok, `10` warn, `1` error, `2` config/environment). Runs standalone or
  through the extension caller. See
  [docs/extensions.md](docs/extensions.md).

  The Salesforce-specific rules it encodes were verified with check-only
  deploys against a live org: required and master-detail fields cannot carry
  field permissions at all (exempt); formula, auto-number and roll-up summary
  fields accept `editable` but can never honor it, so an `edit` requirement
  downgrades to `read` rather than failing the PR; and a master-detail child
  object accepts View All / Modify All but additionally requires `read` on its
  master in the same permission set, which the gate reports as a
  `master-dependency` finding.

  Because Salesforce accepts `editable=true` on a formula, auto-number or
  roll-up field while the org stores `editable=false`, the gate also reports
  that as a `field-drift` finding at the rule's severity — on by default, since
  the grant reads as meaningful in review but has no effect in the org. Turn it
  off with `flagEditableOnReadOnlyFields: false`, globally or on a single rule.

- **omnistudio-standard-runtime-cache-refresh extension** — a post-deploy
  drift check and forced reactivation for OmniStudio **Standard Runtime**
  components (`.github/actions/omnistudio-standard-runtime-cache-refresh/`).
  Not applicable to the `vlocity_cmt` managed-package runtime. Reads the
  deploy's own delta manifest (Metadata API types `OmniScript`,
  `OmniIntegrationProcedure`, `OmniUiCard`, `OmniDataTransform`), SOQL-checks
  active state on the SObject layer (`OmniProcess` / `OmniUiCard` /
  `OmniDataTransform`, where manifest fullName = `UniqueName`), and only for
  out-of-sync components drives the org's own compile/activation Visualforce
  pages (`omnistudio__OmniLwcCompile`, `omnistudio__FlexCardCompilePage`)
  with a headless browser, reusing the deploy job's existing `sf` session via
  `frontdoor.jsp` — no credential inputs. Success requires a SOQL re-check;
  anything unconfirmed becomes an `OmniStudio (Standard Runtime):` `::warning`
  plus a job-summary row and the job still succeeds — **warn-only by design**
  (a deliberate deviation from `field-permset-gate`'s fail-on-violation; no
  rollback, drift is re-detected on every subsequent run). Config via inputs
  and/or `.cairnci/omnistudio-standard-runtime-policy.json`
  (`examples/omnistudio-standard-runtime-policy.json`) with **input > file >
  default** precedence, matching core's `.cairnci/config.json` convention.
  Unlike its dependency-free siblings it bundles `puppeteer-core` via
  `@vercel/ncc` into a checked-in `dist/` (no run-time install; uses the
  runner's preinstalled Chrome). See
  [docs/omnistudio-standard-runtime.md](docs/omnistudio-standard-runtime.md).

## [v1.2.0] - 2026-07-20

### Added

- **Extension caller framework** — an optional, source-tracked way to hook
  consumer-developed extensions into the pipeline. Consumers commit
  `.cairnci/extensions.json` (see `examples/extensions.json`) listing
  extensions in run order, pinned to lifecycle phases (`pre-validate`,
  `post-validate-success`, `post-validate-failure`, `pre-deploy`,
  `post-deploy-success`, `post-deploy-failure`), each configurably blocking or
  non-blocking. Extensions are local scripts in the consumer repo or entries
  in any external git repo pinned to a ref (cloned outside the workspace).
  Exit-code contract: `0` = ok, `10` = warn (never blocks), anything else =
  error (blocks only when `blocking: true`). New `extensions-config-file`
  input on `sf-validate.yml` and `sf-deploy.yml`. The caller
  (`.github/actions/extension-caller/`) is core framework: it publishes to
  CairnCI-Public together with the reusable workflows on every core `v*` tag
  and the workflows reference it at
  `Fossiltalk/CairnCI-Public/.github/actions/extension-caller@v1`, so both
  always come from the same release (`publish-extension.yml` refuses
  `extension-caller/v*` tags). Extension development happens on the
  `CairnCI-External` branch; extensions still release to CairnCI-Extensions
  via the scoped-tag pipeline. See [docs/extensions.md](docs/extensions.md).

## [v1.1.0] - 2026-07-14

Toolchain reproducibility and Node.js compatibility. The reusable workflows now
default to a pinned, validated toolchain instead of floating dist-tags. Consumers
pinning `@v1` pick this up automatically; the workflow inputs are unchanged, so
you can still override any version.

### Changed

- **Default Node.js version is now `22`** (was `20`). `@salesforce/cli` 2.142+
  bundles an `undici` that calls `worker_threads.markAsUncloneable` (Node
  >= 22.10) at CLI load, so Node 20 now crashes with
  `TypeError: markAsUncloneable is not a function`. Override with `node-version`
  if needed (sfdx-git-delta still requires >= 20).
- **Default `@salesforce/cli` is now pinned to `2.142.7`** (was the floating
  `latest` dist-tag), for a reproducible toolchain.
- **Default `sfdx-git-delta` is now pinned to `6.31.0`** (was the floating
  `stable` dist-tag).

### Added

- **[SF CLI compatibility table](docs/compatibility.md)** — the
  `@salesforce/cli` versions CairnCI has validated end-to-end against a real org
  (with Node version and date), so you know which version is safe to pin. Kept
  current automatically.

## [v1.0.0] - 2026-07-03

First stable public release. The `sf-validate` and `sf-deploy` reusable
workflows are published to
[Fossiltalk/CairnCI-Public](https://github.com/Fossiltalk/CairnCI-Public) and
pinnable at `@v1`.

### Added

- **`sf-validate`** reusable workflow — check-only `sf project deploy validate`
  on pull requests, `RunLocalTests` by default, with a configurable
  minimum-coverage gate (`min-coverage`).
- **`sf-deploy`** reusable workflow — branch→environment deploys on merge,
  reusing the PR's validation for a quick deploy with automatic full-deploy
  fallback.
- **Delta and full-branch modes** (`delta`) via
  [sfdx-git-delta](https://github.com/scolladon/sfdx-git-delta); full-branch
  mode skips the plugin entirely.
- **Destructive-change validation** (`allow-destructive-changes`) — validates
  metadata deletions detected between refs.
- **Matching/duplicate rule deploys** (`rule-deploy`) — 3-step
  deactivate→update→activate path, with active-rule-limit preflight checks.
- **`org-mode: scratch`** on `sf-validate` — validate against an ephemeral
  scratch org created from a Dev Hub (`DEVHUB_SFDX_AUTH_URL`) and deleted
  afterward.
- **Rollback strategies** (`rollback-strategy`) — `none`, `revert-pr`, or
  `revert-push` to re-align git with the org after a failed deploy.
- **Configuration** via workflow inputs and/or an in-repo
  `.cairnci/config.json`, freely mixed (explicit input → config file →
  built-in default).
- **Pinnable toolchain** — Node, `@salesforce/cli`, and sfdx-git-delta versions
  are all overridable; runs on GitHub-hosted or self-hosted runners.
- Two adoption paths — reference a pinned `@v1` (recommended) or vendor the
  workflows in-repo (air-gapped / strict-security orgs).

### Notes

- The optional field-permission-set governance gate lives in
  [CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions),
  versioned independently and referenced as
  `Fossiltalk/CairnCI-Extensions/.github/actions/field-permset-gate@v1`.

## [v0.1.0-alpha.1] - 2026-06-03

### Added

- Initial pre-release: `sf-validate`, `sf-deploy` reusable workflows
- `field-permset-gate` composite action (later moved to CairnCI-Extensions)
- Delta and full-branch deploy modes
- `rollback-strategy`: `revert-pr` and `revert-push`
