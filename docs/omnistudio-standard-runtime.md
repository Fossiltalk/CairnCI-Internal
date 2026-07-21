# OmniStudio Standard Runtime — deployment drift and the cache-refresh extension

**This does not apply to OmniStudio for Managed Packages (`vlocity_cmt`
namespace).** Everything below is scoped to Standard Runtime (the Setup
"Managed Package Runtime" toggle disabled).

## The problem

Salesforce's Metadata API deployment path for OmniStudio Standard Runtime
moves component *definitions* correctly but "keeps the state from your source
org" for active/inactive and "keeps the same version" across orgs — it never
triggers the compile/activation side effects (LWC generation, cache
population) that the Designer's **Activate** button performs. Skipping the
post-deploy reactivation step creates **drift**: the org's active/compiled
artifacts silently fall out of sync with the deployed branch even though the
deploy reported success.

## The two-layer naming trap

The same components have *different names* on the two API layers — conflating
them is the most likely implementation bug in this area:

| Component | Metadata API type (deploy, package.xml) | SObject (SOQL/Tooling) |
|---|---|---|
| OmniScript | `OmniScript` | `OmniProcess` |
| Integration Procedure | `OmniIntegrationProcedure` | `OmniProcess` (`IsIntegrationProcedure = true`) |
| FlexCard | `OmniUiCard` | `OmniUiCard` |
| DataRaptor / Data Mapper | `OmniDataTransform` | `OmniDataTransform` |

Confirmed against a live Standard Runtime org: all three SObjects expose
`UniqueName`, `VersionNumber`, `IsActive`, and the Metadata API member
fullName (e.g. `GrantsAF_AFProjectBudget_English_2`) **equals** the SObject
`UniqueName`, version suffix included.

## Division of responsibility

- **Core (`sf-deploy.yml`)** owns deploy ordering: the
  `omnistudioStandardRuntimeFirst` config deploys the four Omni Metadata API
  types in their own first pass (same pattern as `rule-deploy`), keeping
  quick-deploy reuse and `rollback-strategy` intact. The extension never
  deploys anything.
- **Extension (`omnistudio-standard-runtime-cache-refresh`)** runs after that
  deploy: SOQL drift check, conditional headless reactivation, warn-only
  reporting. See the action's
  [README](../.github/actions/omnistudio-standard-runtime-cache-refresh/README.md)
  for inputs, precedence, and the exit-code contract.

## Activation mechanics (confirmed from a live org's page markup)

- OmniScripts / Integration Procedures:
  `/apex/omnistudio__OmniLwcCompile?id=<OmniProcess.Id>&activate=true` —
  terminal states appear in `<p id="compiler-message">`: `DONE` on success,
  `ERROR: …` on failure. The page also supports `activate=false`
  (deactivate), `download`, and `deploybulk`.
- FlexCards: `/apex/omnistudio__FlexCardCompilePage?id=<OmniUiCard.Id>` —
  success injects a `div.compileMessage` containing `DONE SUCCESSFULLY`.
- DataRaptors are not LWC-compiled; there is no activation page for them.
- These pages surface compile errors the standard Activate UI does not show —
  the extension captures the full page text on any failure.
- The `omnistudio` namespace prefix comes from the OmniStudio foundation
  package; both page paths are configurable should an org differ.
- Known failure mode: these pages can hang on slower orgs (sandboxes
  especially) — hence the configurable per-attempt timeout and retry count.

## Drift-prevention philosophy: visibility + re-detection, no rollback

A failed reactivation is a `::warning` naming the component plus a job-summary
row — never a job failure, never an automatic revert (core's
`rollback-strategy` is for deploy failures; a reactivation warning is not
one). The SOQL check is the source of truth for "actually in sync" and
re-flags the same drifted component on every run until it is fixed, so the
pipeline never silently succeeds while users see a stale component.

## Forward risk

Salesforce's H2 2026 roadmap ("Atomic deployment", "Easy version management")
aims to auto-create an active version in the target org, which could shrink or
eliminate the need for this extension. Re-check against release notes
periodically.
