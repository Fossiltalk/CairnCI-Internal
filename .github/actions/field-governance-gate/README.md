# field-governance-gate

An **org-free** CairnCI pipeline extension. It inspects the current PR's git
diff for newly created **and modified** Salesforce fields and verifies that each
one carries the governance metadata your repo requires — description, help text,
data owner, field usage, data sensitivity and compliance categorization.

No Salesforce org connection and no `sf` CLI — the gate reasons purely over the
git diff and the metadata XML on disk, so it runs anywhere a checkout exists and
completes in milliseconds.

> Renamed from `field-permset-gate` in v1.0.0. Permission-set **access**
> checking now lives in its own extension,
> [`permset-access-gate`](../permset-access-gate/README.md); this one is purely
> about field metadata quality. See [Migrating](#migrating-from-field-permset-gate).

## Running-change scope

The gate audits only the fields the PR **added or modified**
(`git diff --diff-filter=AM <base>...HEAD`) under the source dir, matching
`**/objects/<Object>/fields/<Field>.field-meta.xml`.

Untouched legacy fields are never audited, so a repo can adopt a standard
without first backfilling years of debt. Touching a legacy field pulls it into
scope and it gets the full audit — the ratchet only turns forward. Deleting a
field is never a finding.

## Governable attributes

| Config key | Aliases | Metadata element(s) | Salesforce UI name |
|---|---|---|---|
| `description` | — | `<description>` | Description |
| `inlineHelpText` | `helpText`, `tooltip` | `<inlineHelpText>` | Help Text |
| `businessOwner` | `dataOwner`, `owner` | `<businessOwnerUser>` **or** `<businessOwnerGroup>` | Data Owner |
| `businessStatus` | `fieldUsage` | `<businessStatus>` | Field Usage |
| `securityClassification` | `dataSensitivity`, `sensitivity` | `<securityClassification>` | Data Sensitivity Level |
| `complianceGroup` | `compliance` | `<complianceGroup>` | Compliance Categorization |

An element that is present but empty counts as absent.

> **Data Owner is two elements, not one.** Either `<businessOwnerUser>` or
> `<businessOwnerGroup>` satisfies the requirement. A bare `<businessOwner>`
> does **not** — Salesforce rejects that element at deploy time
> (`Element ...businessOwner invalid at this location in type CustomField`).
> The predecessor gate checked `businessOwner`, so that check could never pass
> on metadata that actually deploys.

## Field types and object families

Unlike field-level security, governance metadata has **no platform carve-outs**.
Check-only deploys against a live production org confirmed that every element
above is accepted on formula, auto-number, roll-up summary, required and
master-detail fields, and on `__c`, `__mdt`, `__e`, `__b` and standard objects.

So the gate exempts nothing for platform reasons. Special field types are still
*named* on the finding as context, which is how you can tell the gate handled a
formula field deliberately rather than tripping over it:

```
[error] Invoice__c.Total__c (formula field) missing Description (<description>)
```

What differs between families is **convention**, not capability — so it is
configurable rather than hardcoded:

| Case | Default | How to change it |
|---|---|---|
| Standard fields (API name not ending `__c`) | **Skipped** — the file is usually a partial customization, not a field this PR authored | `"includeStandardFields": true` |
| Built-in fields on `__mdt` / `__e` / `__b` (`DeveloperName`, `ReplayId`, …) | **Skipped** — same rule; they are standard fields | `"includeStandardFields": true` |
| Custom (`__c`) fields on any object family | Audited | `objectTypes.<kind>` |

`objectTypes` keys: `custom`, `standard`, `customMetadata`, `platformEvent`,
`bigObject`, `externalObject` — the family of the **object**, not the field.

## Config

Source-tracked at `.cairnci/field-governance-gate.json` (override with the
`config-file` input or `CONFIG_FILE`). **The gate is opt-in: with no config file
it exits 0 and does nothing.**

```jsonc
{
  // Repository-level defaults.
  "severity": "error",                 // "error" (blocks) | "warn" (never blocks)
  "require": ["description"],
  "includeStandardFields": false,

  // Never audited, at any layer. Case-insensitive, trailing `*` wildcard.
  "bypass": {
    "objects": ["Legacy_Thing__c", "Temp_*"],
    "fields": ["Account.Legacy_Code__c", "Invoice__c.*"]
  },

  // Per object family.
  "objectTypes": {
    "platformEvent": { "require": ["description"], "severity": "warn" },
    "bigObject": { "enabled": false }
  },

  // Scoped rules, matched in order — FIRST match wins.
  "rules": [
    {
      "name": "pii",
      "objects": ["Contact", "Lead"],
      "severity": "error",
      "require": {
        "description": { "minLength": 20 },
        "dataSensitivity": { "allowed": ["Confidential", "Restricted"] },
        "compliance": true
      }
    },
    {
      "name": "house-default",
      "severity": "warn",
      "require": ["description", "helpText"],
      "bypass": { "fields": ["Sandbox__c.*"] }
    }
  ],

  // Per object — the last word, applied after any matching rule.
  "objectOverrides": {
    "Case": { "severity": "warn" },
    "Archive__b": { "enabled": true }
  }
}
```

### How a field's policy is resolved

Layers apply most-general first; each one may override `severity` and `require`:

```
built-in defaults  (severity error, require description)
  -> top-level severity / require            repository level
    -> objectTypes[<object family>]
      -> the FIRST matching rule             scoped by objects / fields
        -> objectOverrides[<Object>]         per object — the last word
```

- A layer that **omits** `severity` or `require` inherits it.
- A layer that **sets** `require` replaces the set wholesale. To drop just one
  requirement, restate the set with `"attributeName": false`.
- `enabled: false` on an `objectTypes` family or an `objectOverrides` object
  turns the gate off for it; an `objectOverrides` entry with `enabled: true`
  re-enables a single object inside a disabled family.

Rules are **first-match-wins**, unlike `permset-access-gate` (whose rules each
target a different permission set and therefore all apply). Every rule here
checks the same family of attributes, so applying every match would just emit
duplicate findings for one field. Put narrow rules first and a catch-all last.

### Requirement constraints

`require` takes an array of attribute names (presence only) or an object with
per-attribute constraints:

| Constraint | Meaning |
|---|---|
| `true` / `{}` | Must be present and non-empty |
| `false` | Not required (drops an inherited requirement) |
| `minLength: <n>` | Value must be at least *n* characters — catches `description: "TBD"` |
| `allowed: [ … ]` | Value must be one of these (case-insensitive) |
| `pattern: "<regex>"` | Value must match |

`allowed` earns its keep: a check-only deploy did **not** reject an arbitrary
`<securityClassification>` or `<businessStatus>` value, so the platform will not
catch a typo'd classification for you.

### Bypasses

`bypass.objects` and `bypass.fields` (`Object.Field`) skip a component
entirely — no findings, reported in the summary as bypassed. Matching is
case-insensitive and supports a trailing `*` wildcard on either segment.

The global bypass **unions** with the matched rule's own bypass; a rule-level
bypass only affects fields that rule governs.

## Exit codes

Follows the CairnCI extension contract:

| Code | Meaning |
|---|---|
| `0` | No findings (or no config / nothing in scope) |
| `10` | Warn-severity findings only — annotated, **never blocks** |
| `1` | At least one error-severity finding — blocks |
| `2` | Config or environment problem (bad JSON, unresolvable base ref) |

Any single error-severity finding escalates the whole run to `1`, even when
other findings are warnings.

## Deployment modes

### 1. Standalone job

```yaml
name: Field governance
on: pull_request

permissions:
  contents: read
  pull-requests: write   # for the sticky PR comment

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0   # the gate diffs against the PR base
      - uses: Fossiltalk/CairnCI-Extensions/.github/actions/field-governance-gate@field-governance-gate/v1
        with:
          source-dir: force-app
```

Posts a sticky PR comment (one comment, updated in place) alongside inline
annotations and a step summary. Annotations are anchored to the field file, so
they land on the PR diff where the fix belongs.

### 2. Extension-caller entry

Reference `run.sh` from `.cairnci/extensions.json`:

```json
{
  "extensions": [
    {
      "id": "field-governance-gate",
      "phases": ["pre-validate"],
      "blocking": true,
      "run": {
        "type": "git",
        "repo": "https://github.com/Fossiltalk/CairnCI-Extensions.git",
        "ref": "field-governance-gate/v1.0.0",
        "entry": ".github/actions/field-governance-gate/run.sh"
      }
    }
  ]
}
```

In this mode PR commenting is skipped unless a `GITHUB_TOKEN` is present in the
env; the exit code feeds the caller's blocking/non-blocking contract.

## Migrating from `field-permset-gate`

| `field-permset-gate` input | Now |
|---|---|
| `require-description` | `"require": ["description"]` |
| `require-help-text` | `"require": ["helpText"]` |
| `require-data-owner` | `"require": ["dataOwner"]` — and it now checks the elements Salesforce actually accepts |
| `require-field-usage` | `"require": ["fieldUsage"]` |
| `require-data-sensitivity` | `"require": ["dataSensitivity"]` |
| `require-compliance` | `"require": ["compliance"]` |
| `require-permission-set`, `required-permission-sets` | Moved to [`permset-access-gate`](../permset-access-gate/README.md) |
| `forbid-breaking-field-changes` | Dropped — not governance metadata |
| Env-var inputs, `.cairnci/field-policy.json` | One source-tracked JSON at `.cairnci/field-governance-gate.json` |

Behavioral changes worth knowing: the gate now audits **modified** fields as
well as new ones, supports `warn` severity (the old gate always failed), and
skips standard fields by default.

## Development

```bash
# Org-free unit + CLI tests (what CI runs)
node --test .github/actions/field-governance-gate/tests/*.test.mjs

# Org-gated tests — check-only deploys that verify the gate's static model
# against real Salesforce behavior. Never runs in CI.
FIELD_GOV_GATE_LIVE_ORG=CairnCI_Production \
  node --test .github/actions/field-governance-gate/tests/*.org.test.mjs
```

The org-gated suite proves the model in both directions: metadata the gate
**passes** also validates against a real org, and the Data Owner tag the gate
**rejects** is exactly the one Salesforce rejects. A check-only deploy creates
nothing, so it is safe against production. Set `FIELD_GOV_GATE_OWNER_USER` to a
real username to include `businessOwnerUser` in the fixture (the value must
resolve to a user in the target org).

All logic lives in `lib/field-governance-gate.mjs` and is side-effect-free;
`gate.mjs` does the IO. Zero runtime dependencies — `node:` builtins only.
