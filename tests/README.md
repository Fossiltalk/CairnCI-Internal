# Integration tests

Layer-2 (org-touching) tests for CairnCI. Layer-1 (lint + unit) lives in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml); this layer proves the
reusable workflows actually work end-to-end against a real Salesforce org.

## How it works

[`.github/workflows/integration.yml`](../.github/workflows/integration.yml) calls
CairnCI's own [`sf-validate.yml`](../.github/workflows/sf-validate.yml) with
`org-mode: scratch`. That mode auths a **Dev Hub**, spins up an **ephemeral
scratch org**, validates the fixture below against it (deploy-check + Apex tests
+ coverage gate), and deletes the org afterward — so each run is hermetic.

It runs on `workflow_dispatch` and a weekly cron, and is gated to the canonical
repo (forks have no secret).

## Setup

Add one repository secret: **`DEVHUB_SFDX_AUTH_URL`** — the Sfdx Auth URL of an
org with Dev Hub enabled:

```bash
sf org login web --alias devhub
sf org display --target-org devhub --verbose   # copy the "Sfdx Auth Url" (force://...)
```

Then **Actions → Integration (scratch org) → Run workflow**.

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
merge deploy reuses the PR's validation), so a fresh-scratch-org-per-run can't
exercise it. To smoke-test reuse and the cross-repo consumer reference path, run
a thin consumer repo against a disposable stable org.
