# Extension Development Guide

Extensions are composite actions developed and validated in CairnCI-Internal
(on the `CairnCI-External` development branch), then published to
[Fossiltalk/CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions).
They version independently from the core CairnCI workflows.

There are two ways consumers run extensions:

1. **As workflow jobs** — add a job to the caller workflow (see
   `examples/caller-validate.yml`). Good for coarse "after validation" gates.
2. **Via the extension caller** (`.github/actions/extension-caller`) — a
   source-tracked, ordered, phase-pinned runner built into `sf-validate.yml`
   and `sf-deploy.yml`. This is the supported way to hook extensions into
   specific pipeline lifecycle points. Documented below.

## The extension caller

The core reusable workflows invoke the caller at six lifecycle phases:

| Phase | Runs |
|---|---|
| `pre-validate` | before the check-only validation is submitted to the org |
| `post-validate-success` | after the validation (and coverage gate) passed |
| `post-validate-failure` | after the validation pipeline failed |
| `pre-deploy` | before anything is deployed to the org |
| `post-deploy-success` | after a completed deployment |
| `post-deploy-failure` | after a failed deployment (before any git rollback) |

Consumers opt in by committing `.cairnci/extensions.json` (path configurable
via the `extensions-config-file` workflow input). No file means no extensions —
the caller no-ops. See `examples/extensions.json` for a full example:

```json
{
  "extensions": [
    {
      "id": "metadata-naming-gate",
      "phases": ["pre-validate"],
      "blocking": true,
      "run": { "type": "local", "entry": "ci/checks/naming-gate.sh" },
      "env": { "SOURCE_DIR": "force-app" }
    },
    {
      "id": "field-permset-gate",
      "phases": ["post-validate-success"],
      "run": {
        "type": "git",
        "repo": "https://github.com/Fossiltalk/CairnCI-Extensions.git",
        "ref": "field-permset-gate/v1.0.0",
        "entry": ".github/actions/field-permset-gate/run.sh"
      }
    }
  ]
}
```

Because the config lives in the consumer's repo, the extension roster, their
run order, and their phase pinning are all reviewed and versioned like any
other source change — a run is a pure function of the commit being built.

### Run order

Within a phase, extensions run **in the order they appear in the `extensions`
array**. There is no parallelism and no implicit sorting.

### Blocking vs non-blocking, and the exit-code contract

`blocking` defaults to `true`. The extension process communicates status
through its exit code:

| Exit code | Status | Effect |
|---|---|---|
| `0` | ok / info | annotated as a notice |
| `10` | warn | `::warning::` annotation; never fails the pipeline |
| anything else | error | fails the pipeline **only if `blocking: true`**; otherwise downgraded to a warning |

A blocking error in `pre-validate` / `pre-deploy` stops the pipeline before
the org is touched. A blocking error in a post-success phase fails the job
even though the org operation succeeded (for consumers who gate on their own
post-checks). `post-*-failure` phases run on an already-failed job.

### Where extensions run

- `run.type: "local"` — `entry` is a path inside the consumer repo, executed
  with the repo root as the working directory.
- `run.type: "git"` — the caller shallow-clones `repo` at the pinned `ref`
  (tag, branch, or commit SHA — pinning is required) into a temp directory
  **outside the workspace** and runs `entry` from that checkout. Clones are
  cached per `repo@ref` within a run.

`.sh` entries run under `bash` and `.js`/`.mjs`/`.cjs` entries under `node`,
so no executable bit is needed; any other entry is executed directly.

### What an extension sees

Every extension process inherits the job environment (including the
authenticated `sf` CLI) plus:

| Variable | Value |
|---|---|
| `CAIRNCI_PHASE` | the phase being run |
| `CAIRNCI_EXTENSION_ID` | the extension's `id` |
| `CAIRNCI_BLOCKING` | `true` / `false` |
| `CAIRNCI_WORKSPACE` | absolute path of the consumer repo checkout |
| `CAIRNCI_CONTEXT` | JSON with phase-specific pipeline data (deploy dir, validation job-id, coverage, outcomes, …) |
| your `env` map | per-extension static values from the config |

Each phase also writes a results table to the job's step summary.

### Optional per-extension settings

- `timeoutSeconds` — kill the extension after this long (default 600);
  a timeout is an error and follows the blocking rules.

### Caller development and release

The caller itself lives at `.github/actions/extension-caller/` (class in
`lib/extension-caller.mjs`, CLI in `caller.mjs`) with unit tests under
`tests/` run by `integration-extension-caller.yml` (`node --test`, org-free).
It is published to CairnCI-Extensions like any other extension:

```bash
git tag extension-caller/v1.0.0
git push origin extension-caller/v1.0.0
```

**Release order matters:** `sf-validate.yml` / `sf-deploy.yml` pin
`extension-caller@extension-caller/v1.0.0`, so that tag must exist on
CairnCI-Extensions **before** a core `v*` release referencing it is tagged
(and before org-touching internal CI runs of those workflows).

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
