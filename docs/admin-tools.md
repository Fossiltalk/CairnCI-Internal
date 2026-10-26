# Admin Tool Development Guide

An **admin tool** is a capability the administrator of a CairnCI repo needs in
order to *set up and maintain* that repo — as opposed to an extension, which
runs inside a pipeline to gate a change.

Before this class existed, everything under `.github/actions/` was either core
framework or an extension, and there was nowhere sensible to put work like
"retrieve the whole org so we have something to diff against". Admin tools fill
that gap.

## The three classes

| | Core workflows | Admin tools | Extensions |
|---|---|---|---|
| Examples | `sf-validate.yml`, `sf-deploy.yml`, `extension-caller` | `retrieve-org-metadata` | `field-governance-gate`, `permset-access-gate` |
| `name:` in `action.yml` | `CairnCI …` | **`Tool: …`** | `CairnCI <extension-name>` |
| Invoked as | reusable workflow | standalone job (schedule / dispatch) | pipeline job **or** extension-caller phase |
| Ships `run.sh`? | n/a | **No** | Yes |
| Fails the calling job? | yes | **No** (opt in via `fail-on-error`) | yes, per the exit-code contract |
| Published to | CairnCI-Public | **CairnCI-Public** | CairnCI-Extensions |
| Release tag | `v1.2.3` | **`v1.2.3`** (core channel) | `<name>/v1.2.3` |

## The four rules

**1. Named `Tool: <what it does>`.** The prefix is how a reader of a workflow
file, a job log, or the CairnCI-Public tree tells at a glance that this is not
a gate. Extensions keep the `CairnCI <extension-name>` convention.

**2. Standalone jobs only — no `run.sh`.** The extension caller runs extensions
at six deploy/validate lifecycle phases. Admin tools are not lifecycle hooks:
they are long-running, org-wide, and often write to git. A full-org metadata
retrieve inside a `pre-deploy` phase would be actively harmful. Omitting
`run.sh` makes that structural rather than a matter of documentation.

**3. Never fail the calling job by default.** An admin tool reports through
`::warning::` annotations and the job summary, and exits 0 even when it hit
problems. Extensions block a pipeline because blocking is their purpose; a tool
producing a best-effort artifact should hand back what it got. Provide a
`fail-on-error` input (default `"false"`) so an administrator who *wants* to be
paged can opt in, and state the tradeoff in the tool's README — with the
default, a genuinely broken setup also surfaces only as a warning.

Keep the CLI's internal exit codes on the usual `0 / 10 / 1 / 2` contract so
the tool stays debuggable by hand, and do the remap in the composite step:

```bash
set +e
node "${{ github.action_path }}/<entry>.mjs" ...
code=$?
set -e
if [ "$code" -ne 0 ] && [ "$FAIL_ON_ERROR" != "true" ]; then
  echo "::warning::<tool> finished with issues (exit ${code}); see the job summary."
  exit 0
fi
exit "$code"
```

**4. Published on the core `v*` channel.** Admin tools are prerequisites for
using CairnCI's automation at all — you cannot usefully run delta deploys
against a repo that has never been seeded from the org. That makes them part of
the public surface a consumer gets on day one, not an optional add-on they opt
into later. They therefore go to **CairnCI-Public** with the core workflows,
not to CairnCI-Extensions.

Concretely this means two edits when adding one, and **missing either breaks
the publish**:

- add the action's directory to `PUBLISH_PATHS` in `publish-tag.yml`
- add it to the safety-net `grep -Ev` regex a few lines below, which
  hard-fails the publish on any staged file it does not recognise

Also add the name to the `case` guard in `publish-extension.yml` so a
mistakenly pushed `<tool-name>/v*` tag is rejected with a clear message rather
than quietly publishing to the wrong repo.

## Credentials

Admin tools take **no credential inputs and store nothing**. They reuse the org
session the calling job established (`sf org login sfdx-url --alias target-org
--set-default`, the shape `sf-deploy.yml` uses). The caller owns the secret; the
tool only ever sees an org alias.

## Directory layout

Identical to an extension, minus `run.sh`:

```
.github/actions/retrieve-org-metadata/
  action.yml                       ← composite action; name: "Tool: …"
  retrieve.mjs                     ← CLI: all the IO
  package.json                     ← private; test:<tool-name> script
  README.md
  lib/
    retrieve-org-metadata.mjs      ← pure orchestration
    ...                            ← pure, side-effect-free modules
  tests/
    <tool-name>.test.mjs
    cli.test.mjs
```

Keep `lib/` free of process concerns — no argv, no `process.exit`, no
annotations — so the whole flow is testable. Inject anything that talks to the
outside world (see `createSfClient({ run })` in
`.github/actions/retrieve-org-metadata/lib/sf-cli.mjs`); that seam is what
makes org-free unit tests possible.

## Testing

`node --test`, matching every other action here. Add
`.github/workflows/integration-<tool-name>.yml` with the same shape as the
extension integration workflows: `paths:` filter on the action directory *and*
the workflow file, `push: [main, CairnCI-External]`, `workflow_dispatch`,
`if: github.repository == 'Fossiltalk/CairnCI-Internal'`, Node 22, then the
explicit test glob.

Two things worth asserting for a tool specifically:

- drive the composite action itself in a state where it must fail (e.g. an
  unreachable org) and assert `steps.<id>.outcome == 'success'` — the
  never-fail contract is the easiest thing to regress
- extract the `run:` block from `action.yml` and execute it with a stubbed exit
  code, so the remap is tested as shell rather than as a reimplementation of it

### Org-gated tests

A tool that talks to an org encodes **claims about Salesforce**, and a stubbed
client cannot check any of them — it will happily confirm whatever the stub was
built to believe. Add a `tests/*.org.test.mjs` suite for those claims,
following the convention in `field-governance-gate` and `retrieve-org-metadata`:

- gate on an env var (`ORG_METADATA_LIVE_ORG`) plus `sf` on PATH, resolved at
  **module scope** — `node:test` evaluates a suite's `skip` option when the
  suite is registered, before any hook runs
- `skipReason()` returns `false` (not null) to run; `node:test` skips on
  anything that is not exactly `false`
- include a wiring guard that asserts the suite stays skipped without an org
  **and** runs with one, so the file can sit in the normal `tests/*.test.mjs`
  glob without leaking live calls into CI
- keep it read-only and scoped. `retrieve-org-metadata` wraps the real `sf`
  client and narrows only `describeMetadata`, so calls stay genuinely live
  while the suite runs in minutes rather than exercising the whole org.

This is not ceremony. The live suite for `retrieve-org-metadata` exists because
a live run found two bugs no mock could have: metadata filed in the
`unfiled$public` pseudo-folder was invisible to folder discovery (42
EmailTemplates silently indexed as zero), and `Folder` rows with a null
`DeveloperName` were turning into unfoldered API calls.

`ci.yml`'s actionlint and yamllint already scan all of `.github/`, so a new
tool needs no extra lint wiring. actionlint shellchecks every embedded `run:`
block.

## Checklist

- [ ] `.github/actions/<tool-name>/action.yml` with `name: "Tool: …"`
- [ ] `fail-on-error` input, default `"false"`, and the exit-code remap
- [ ] No `run.sh`
- [ ] No credential inputs
- [ ] `lib/` pure, external calls injected
- [ ] `tests/` incl. a never-fail assertion; `package.json` with `test:<tool-name>`
- [ ] `.github/workflows/integration-<tool-name>.yml`
- [ ] `examples/caller-<tool-name>.yml`
- [ ] `publish-tag.yml`: **both** `PUBLISH_PATHS` and the grep regex
- [ ] `publish-extension.yml`: added to the rejection `case`
- [ ] README stating the never-fail deviation and its tradeoff
- [ ] `CHANGELOG.md` entry naming the core release it ships in
