# Extension Development Guide

Extensions are composite actions developed and validated in CairnCI-Internal,
then published to [Fossiltalk/CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions).
They version independently from the core CairnCI workflows.

## Directory layout

Each extension lives under `.github/actions/<extension-name>/`:

```
.github/actions/
  field-permset-gate/
    action.yml                        ← composite action definition
    tests/
      field_permset_gate.bats         ← unit tests (shell logic)
```

This mirrors the path in CairnCI-Extensions exactly, so local test workflows
and the published path are identical.

## CI coverage

No extra configuration needed. The existing `ci.yml` actionlint and yamllint
steps already scan all of `.github/` including `.github/actions/`.

## Integration testing

Add a per-extension integration workflow at
`.github/workflows/integration-<extension-name>.yml`. It should:

- Trigger on `push` to `main` and `pull_request` when files under the
  extension's directory change
- Call the local action with `uses: ./.github/actions/<extension-name>`
- Use the `main` environment for `SFDX_AUTH_URL` (org-analysis extensions)
  or repo-level secrets for external tool credentials

```yaml
on:
  pull_request:
    paths: [.github/actions/field-permset-gate/**]
  push:
    branches: [main]
    paths: [.github/actions/field-permset-gate/**]
  workflow_dispatch:

jobs:
  test:
    if: github.repository == 'Fossiltalk/CairnCI-Internal'
    runs-on: ubuntu-latest
    environment: main          # provides SFDX_AUTH_URL for org-analysis extensions
    steps:
      - uses: actions/checkout@v7
      - uses: ./.github/actions/field-permset-gate
        with:
          source-dir: force-app
```

## Tagging and publishing

Tags are scoped to the extension name so they don't collide with core tags or
each other:

```bash
git tag field-permset-gate/v1.0.0
git push origin field-permset-gate/v1.0.0
```

`publish-extension.yml` fires automatically and:

1. Validates `.github/actions/field-permset-gate/action.yml` exists
2. Syncs only that extension's directory to CairnCI-Extensions (other extensions
   are untouched)
3. Pushes two tags to CairnCI-Extensions:
   - `field-permset-gate/v1.0.0` — exact, immutable
   - `field-permset-gate/v1` — floating major alias, updated on each release

## Consumer reference

Consumers pin to the floating major alias for automatic patch/minor updates:

```yaml
uses: Fossiltalk/CairnCI-Extensions/.github/actions/field-permset-gate@field-permset-gate/v1
```

Or lock to an exact version for full reproducibility:

```yaml
uses: Fossiltalk/CairnCI-Extensions/.github/actions/field-permset-gate@field-permset-gate/v1.0.0
```

## Setup checklist

- [ ] GitHub App installed on `Fossiltalk/CairnCI-Extensions` with Contents:
      Read and write (same app used for `publish-tag.yml`; just add
      CairnCI-Extensions to its installation)
- [ ] For extensions that query external tools: add the required API key as a
      repo-level secret in CairnCI-Internal and document it in the extension's
      `action.yml` description
