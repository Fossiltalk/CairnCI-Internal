# permset-access-gate

An **org-free** CairnCI pipeline extension. It inspects the current PR's git
diff for newly created Salesforce **custom fields** and **objects** and verifies
that the user-defined **permission sets committed in the repo** grant a
configured minimum access level to each.

No Salesforce org connection and no `sf` CLI — the gate reasons purely over the
git diff and the metadata XML on disk, so it runs anywhere a checkout exists and
completes in milliseconds.

## What it checks

For every path added in the PR (`git diff --diff-filter=A <base>...HEAD`) under
the source dir:

- **New fields** — `**/objects/<Object>/fields/<Field>.field-meta.xml`. Each
  configured rule requires `read` or `edit` field-level security (FLS) in its
  permission set.
- **New objects** — `**/objects/<Object>/<Object>.object-meta.xml` (only
  `__c` objects). Each rule requires a set of object-CRUD flags
  (`read`/`create`/`edit`/`delete`/`viewAll`/`modifyAll`).

A permission set grants `read` when `<readable>true</readable>`, `edit` when
`readable` **and** `editable` are both true. A missing `<fieldPermissions>` /
`<objectPermissions>` entry means no access — a finding.

## Salesforce special cases

The gate encodes the deploy-time rules Salesforce enforces, so it never asks for
an access grant that Salesforce would reject:

| Component | Handling |
|---|---|
| Formula field (`<formula>`) | Read-only — `edit` requirement downgrades to `read` |
| Auto-number field (`<type>AutoNumber</type>`) | Read-only — `edit` downgrades to `read` |
| Roll-up summary (`<type>Summary</type>`) | Read-only — `edit` downgrades to `read` |
| Required field (`<required>true</required>`) | **Exempt** — cannot have FieldPermissions rows |
| Master-detail field (`<type>MasterDetail</type>`) | **Exempt** — implicitly required |
| `Id` or any non-`__c` (standard) field | **Exempt** — not created by this PR |
| Field on `__mdt` / `__e` / `__b` object | **Exempt** — no field-level security |
| `__mdt` / `__e` / `__b` / standard object | **Exempt** — no permission-set object CRUD |
| Master-detail **child** object | Full CRUD **and** `viewAll` / `modifyAll` enforced; additionally requires `read` on the master |

Exempt and bypassed components are reported (in the step summary and the
collapsed section of the PR comment) with a reason — never as findings.

### Master-detail objects

A master-detail child object is one whose object-meta declares
`<sharingModel>ControlledByParent</sharingModel>` **or** that has a newly added
`MasterDetail` field in the same PR.

Two behaviors here are easy to get wrong, so both were verified with check-only
deploys against a real org:

- **View All / Modify All are grantable on a detail object.** Salesforce accepts
  them, and real production permission sets carry them on detail objects. The
  gate therefore enforces them like any other flag rather than skipping them.
- **A detail object's permissions depend on its master.** Granting any object
  permission on a detail object requires `allowRead` on its master in the *same*
  permission set. Otherwise the deploy fails with:

  ```text
  Permission Read Child__c depends on permission(s): Read Parent__c
  ```

  When a PR adds a `MasterDetail` field, the gate reads the master from that
  field's `<referenceTo>` and reports a `master-dependency` finding if the
  permission set does not grant it `read`. If the master-detail field itself is
  not part of the diff the master is unknown, and the check is skipped.

Note that `editable` on a read-only field (formula, auto-number, roll-up) is
*accepted* by a deploy but can never be honored by the org — which is why an
`edit` requirement downgrades to `read` instead of failing the PR.

## Config

Source-tracked in the **consumer** repo, default path
`.cairnci/permset-access-gate.json`. Missing config = the gate no-ops with a
notice and exit 0 (it is opt-in). See
[`examples/permset-access-gate.json`](../../../examples/permset-access-gate.json).

```json
{
  "bypass": {
    "objects": ["Legacy_Thing__c"],
    "fields": ["Account.Legacy_Code__c", "Invoice__c.*"]
  },
  "rules": [
    {
      "permissionSet": "Sales_Core",
      "severity": "error",
      "fieldAccess": "edit",
      "objectAccess": ["read", "create", "edit"],
      "bypass": { "objects": [], "fields": [] }
    },
    {
      "permissionSet": "Support_Readonly",
      "severity": "warn",
      "fieldAccess": "read",
      "objectAccess": ["read"]
    }
  ]
}
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `rules` | array | — | Required, non-empty. |
| `rules[].permissionSet` | string | — | Required, non-empty. Duplicates (case-insensitive) are a config error. Resolved by filesystem walk of `<source-dir>/**/permissionsets/`. Not found = a finding at the rule's severity. |
| `rules[].severity` | `error` \| `warn` | `error` | Drives the exit code. |
| `rules[].fieldAccess` | `read` \| `edit` | `read` | |
| `rules[].objectAccess` | array of `read`\|`create`\|`edit`\|`delete`\|`viewAll`\|`modifyAll` | `["read"]` | Unknown value = config error. |
| `bypass` / `rules[].bypass` | `{objects: string[], fields: string[]}` | `{[],[]}` | Optional. Per-rule bypass unions with the global bypass and applies only to that rule. `objects` suppresses object findings; `fields` (`Object.Field`) suppresses field findings. Matching is case-insensitive with a trailing `*` wildcard segment (`Invoice__c.*`, `Temp_*`). |

## Exit codes

Follows the CairnCI extension contract:

| Exit | Meaning |
|---|---|
| `0` | ok — no findings (or no new components / no config) |
| `10` | warn — only warn-severity findings; never blocks |
| `1` | error — at least one error-severity finding |
| `2` | config or environment problem (bad config, git diff failed) |

## Deployment modes

### 1. Standalone job

Needs `pull-requests: write` (for the sticky comment) and a full-history
checkout so the base ref is present.

```yaml
name: permset-access-gate
on:
  pull_request:
    paths: [force-app/**]
permissions:
  contents: read
  pull-requests: write
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: Fossiltalk/CairnCI-Extensions/.github/actions/permset-access-gate@permset-access-gate/v1
        with:
          source-dir: force-app
```

### 2. Extension-caller entry

Reference `run.sh` from `.cairnci/extensions.json`, pinned to an exact tag.
Runs at a pipeline lifecycle phase inside `sf-validate.yml` / `sf-deploy.yml`.

```json
{
  "extensions": [
    {
      "id": "permset-access-gate",
      "phases": ["pre-validate"],
      "blocking": true,
      "run": {
        "type": "git",
        "repo": "https://github.com/Fossiltalk/CairnCI-Extensions.git",
        "ref": "permset-access-gate/v1.0.0",
        "entry": ".github/actions/permset-access-gate/run.sh"
      }
    }
  ]
}
```

In extension-caller mode the sticky **PR comment is skipped unless a
`GITHUB_TOKEN` (or `GH_TOKEN`) is present in the env** — annotations and the
step summary still carry the result, and the exit code feeds the caller's
blocking/non-blocking contract.

> PR commenting requires a token in the environment (`GITHUB_TOKEN` /
> `GH_TOKEN`) plus a resolvable PR number. When either is absent the gate emits
> a `::notice::` and continues — a comment failure is never a gate failure.

## Development

```bash
node --test .github/actions/permset-access-gate/tests/*.test.mjs
```

Pure logic lives in `lib/permset-gate.mjs` (no `process.exit`, no network at
import); `gate.mjs` is the CLI that wires args, env, git, annotations, the step
summary, and the sticky comment around it. Zero runtime dependencies —
`node:` builtins only.
