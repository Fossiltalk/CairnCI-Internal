## [Unreleased]
### Added
- `ci.yml` self-test workflow: actionlint (YAML + embedded-bash shellcheck) and yamllint.
- `org-mode: scratch` on sf-validate: validate against an ephemeral scratch org
  created from a Dev Hub (`DEVHUB_SFDX_AUTH_URL`) and deleted afterward.
- Layer-2 integration test (`integration.yml`) that validates a small fixture
  (`tests/fixtures/`) against a scratch org via CairnCI's own validate workflow.
### Changed
- The optional field-permset-gate moved to the
  [CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions) repo, where it
  gains unit tests. Consumers reference it as
  `Fossiltalk/CairnCI-Extensions/.github/actions/field-permset-gate@v1`.

## [v0.1.0-alpha.1] - 2026-06-03
### Added
- Initial release: sf-validate, sf-deploy reusable workflows
- field-permset-gate composite action
- Delta and full-branch deploy modes
- rollback-strategy: revert-pr and revert-push
