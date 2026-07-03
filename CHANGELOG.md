# Changelog

All notable changes to CairnCI are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Consumers pin the reusable
workflows by major tag (e.g. `@v1`); see
[docs/consumer-setup.md](docs/consumer-setup.md).

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
