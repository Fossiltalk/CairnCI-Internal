# Integration tests

Layer-2 (org-touching) tests for CairnCI. Layer-1 (lint + unit) lives in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml); this layer proves the
reusable workflows actually work end-to-end against a real Salesforce org.

## Local test suites in this directory

- **`unit/`** — org-free tests for the scripts embedded in the reusable
  workflows (extracted by step name via `lib/workflow-scripts.mjs` and run
  against fixture manifests with a stub `sf`). Runs in `ci.yml`:
  `node --test tests/unit/*.test.mjs`.
- **`org/`** — org-gated validation of the same assumptions against a live
  org. Never runs in CI; every test skips unless pointed at an org:

  ```bash
  CAIRNCI_ORG=<sf org alias> node --test tests/org/*.test.mjs
  # additionally opt in to the check-only (dry-run) validate test:
  CAIRNCI_ORG=<alias> CAIRNCI_ORG_VALIDATE=true node --test tests/org/*.test.mjs
  ```

  The default run is org-read-only (describes, listMetadata, a retrieve). The
  end-to-end test needs the `sfdx-git-delta` plugin (pin:
  `sf plugins install sfdx-git-delta@6.31.0`) and skips if it's missing.

## How it works

[`.github/workflows/integration.yml`](../.github/workflows/integration.yml) calls
CairnCI's own [`sf-validate.yml`](../.github/workflows/sf-validate.yml) against
the fixture below whenever `sf-validate.yml` or `sf-deploy.yml` change on `main`.
It performs a full-branch, check-only validation (deploy-check + Apex tests +
coverage gate) against the org from `SFDX_AUTH_URL` — no metadata is actually
committed to the org.

It also runs on `workflow_dispatch` for manual triggering, and is gated to the
canonical repo (forks have no secret).

## Setup

The workflow uses the `main` GitHub environment for the `SFDX_AUTH_URL` secret.
Set that secret in **Settings → Environments → main → Environment secrets**.

## The fixture (`fixtures/force-app/`)

Deliberately tiny, but enough to drive the real paths:

| Metadata | Exercises |
|---|---|
| `CairnCiSmoke.cls` + `CairnCiSmokeTest.cls` | Apex deploy-check, `RunLocalTests`, the coverage gate (100% covered) |
| `Account.CairnCI_Smoke__c` field | custom-field deploy-check |
| `CairnCI_Smoke` permission set | field + permission-set wiring together |

## Why there's a root `sfdx-project.json`

The reusable workflows run `sf project deploy validate` from the repo root, and
the `sf` CLI requires an `sfdx-project.json` there. The root file exists **only**
to point the CLI at this fixture (`tests/fixtures/force-app`); CairnCI itself
ships no Salesforce source.

## Not covered here

Quick-deploy **reuse** is inherently a PR→merge flow against a *stable* org (the
merge deploy reuses the PR's validation job-id), so a single-branch check-only
run can't exercise it. To smoke-test reuse and the cross-repo consumer reference
path, run a thin consumer repo against a sandbox or developer org.
