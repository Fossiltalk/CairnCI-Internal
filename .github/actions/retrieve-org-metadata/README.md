# Tool: Full Org Metadata Retrieval

Retrieves **every available metadata component** from a Salesforce org onto a
new branch named for when and how the retrieval happened:

```
org-snapshot/00D8b000000XyZa/20260726-041500Z-schedule
└─ prefix    └─ org id       └─ UTC timestamp └─ trigger
```

The branch replaces the source tree wholesale, so `git diff main..<branch>` is
exactly the org's drift since the last snapshot — **including components
deleted in the org**, which a merge-only export would silently leave behind.

This is a CairnCI **admin tool**, not a pipeline extension. See
[docs/admin-tools.md](../../../docs/admin-tools.md) for what that distinction
means.

## It never fails your job

**This action always exits 0.** Unretrievable metadata, failed chunks, and even
a broken org session are reported as `::warning::` annotations and a job
summary — never as a job failure.

This is a **deliberate deviation** from the fail-on-violation behavior of the
`field-governance-gate` and `permset-access-gate` extensions, which exist to
block a pipeline when they find a problem. This tool has the opposite job: it
produces the best snapshot it can from whatever the org will give it. A
scheduled backup that pages someone because one obscure metadata type is not
retrievable is worse than useless, and a partial org snapshot is still a
genuinely useful org snapshot.

Set `fail-on-error: "true"` to opt back into normal blocking behavior.

> **Tradeoff, stated plainly:** with the default, a broken `SFDX_AUTH_URL` or a
> missing `sf` CLI also surfaces only as a warning. If you run this on a
> schedule and care about knowing it silently stopped working, either set
> `fail-on-error: "true"` or alert on the `branch-name` output being empty.

## Usage

The action takes **no credentials**. It reuses the org session the calling job
already established — the same `sf org login sfdx-url` shape CairnCI's
`sf-deploy.yml` uses. Nothing is stored.

```yaml
permissions:
  contents: write # the action pushes the snapshot branch

jobs:
  snapshot:
    runs-on: ubuntu-latest
    environment: main
    timeout-minutes: 350
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: "22"
      - run: npm install --global @salesforce/cli@latest
      - name: Authenticate
        env:
          SFDX_AUTH_URL: ${{ secrets.SFDX_AUTH_URL }}
        run: |
          authfile="$(mktemp)"
          printf '%s' "$SFDX_AUTH_URL" > "$authfile"
          sf org login sfdx-url --sfdx-url-file "$authfile" --alias target-org --set-default
          rm -f "$authfile"
      - uses: Fossiltalk/CairnCI-Public/.github/actions/retrieve-org-metadata@v1
```

A complete, runnable caller — with both a cron schedule and manual dispatch —
is in [examples/caller-retrieve-org-metadata.yml](../../../examples/caller-retrieve-org-metadata.yml).

### Inputs

| Input | Default | Description |
|---|---|---|
| `target-org` | `target-org` | Org alias or username the calling job authenticated |
| `target-dir` | `force-app` | Source directory written to (replaced wholesale) |
| `branch-prefix` | `org-snapshot` | First segment of the branch name |
| `create-branch` | `"true"` | Create and commit to a snapshot branch |
| `push` | `"true"` | Push the branch to origin (needs `contents: write`) |
| `max-weight` | `"9000"` | Max weighted components per retrieve chunk |
| `concurrency` | `"6"` | Parallel `sf org list metadata` calls while indexing |
| `wait` | `"60"` | Per-chunk retrieve timeout, minutes |
| `api-version` | `""` | Metadata API version; empty uses the org's current |
| `skip-retrieve` | `"false"` | Stop after building the index and manifests |
| `keep-staging` | `"false"` | Retain per-chunk mdapi staging for debugging |
| `fail-on-error` | `"false"` | Fail the job on problems (see above) |

### Outputs

| Output | Description |
|---|---|
| `branch-name` | The snapshot branch created, or empty |
| `total-components` | Components discovered in the org index |
| `chunks-succeeded` / `chunks-failed` | Retrieve chunk outcomes |
| `types-unretrievable` | Comma-separated types that could not be retrieved |

### Exit codes

The CLI keeps the CairnCI contract so it stays debuggable when run by hand.
`action.yml` then maps **every** nonzero code to job success unless
`fail-on-error` is set.

| Code | Meaning |
|---|---|
| `0` | Everything indexed was retrieved |
| `10` | Partial — some chunks failed, or some types were unretrievable |
| `1` | Nothing at all could be retrieved |
| `2` | Could not run: no org session, bad flags |

## How it works

**1. Index.** `describeMetadata` enumerates every type in the org; types that
only ever appear as a child of another (`CustomLabel` under `CustomLabels`) are
skipped, since they come back with their parent. `listMetadata` then enumerates
each type's members — one call per type, or one call per folder for `Report`,
`Dashboard`, `Document` and `EmailTemplate`.

Folder discovery is a SOQL query against `Folder`, **plus an unconditional
probe of `unfiled$public`**. That pseudo-folder accepts `--folder` but has no
`Folder` record, so querying alone never finds it. This is not theoretical: in
`CairnCI_Production` the org had *zero* `Folder` rows of type `Email` and 42
EmailTemplates, all of them in `unfiled$public` — a 100% silent loss for that
type — plus 37 reports there on top of the 67 real report folders. `Folder`
rows with a null `DeveloperName` are filtered out for the same reason: a null
would fall through to an unfoldered `listMetadata` call.

`listMetadata` silently truncates at 3,000 rows with no error and no
pagination. A call returning exactly 3,000 rows is treated as truncated, and
for known high-volume types (`ApexClass`, `CustomField`, `Layout`,
`PermissionSet`, `Flow`, …) the full list is re-fetched through a paginated
Tooling API SOQL query instead. A type that truncates with no registered
fallback is recorded as `truncated: true, fallback: "unavailable"` rather than
silently under-counted — see `lib/tooling-fallback.mjs` to add one.

**2. Plan.** The Metadata API ceiling is **10,000 files per retrieve**, not
10,000 `<members>`. A `CustomObject` expands into far more files per member
(fields, record types, layouts, …) than an `ApexClass` does, so members are
packed by a **weighted** total: `CustomObject` 20, `Profile`/`PermissionSet` 5,
everything else 1, capped at `max-weight` (default 9,000 — headroom under the
hard cap).

Packing is **type-atomic**: types are placed whole, largest first
(first-fit-decreasing). A type is split across chunks **only** when that one
type exceeds the ceiling on its own, and the split is recorded in
`manifest-plan.json` and the job summary. Keeping types contiguous means a
failed chunk reads as "this type didn't come back" rather than "an arbitrary
slice of four types didn't", and FFD packs chunks fuller than sequential fill
does — fewer round trips, less runtime, less cost.

If your org's `CustomObject`s carry an unusually high or low average field
count, tune `max-weight` rather than trusting the defaults blindly.

**3. Retrieve.** Chunks run **sequentially** — concurrent retrieves against one
org risk session and request contention. Each chunk is a two-step
retrieve-then-convert rather than a plain `sf project retrieve start`; both
steps work around empirically confirmed `@salesforce/cli` behavior, not style:

- Source-format retrieve (`--output-dir`) into a directory that isn't a
  declared `packageDirectory` **silently no-ops** — the server-side retrieve
  succeeds, the CLI prints `Warning: Nothing retrieved`, zero files land.
  `--target-metadata-dir` has no such restriction.
- `sf project convert mdapi` has a **two-sided** requirement, and getting
  either half wrong produces no output:
  - `--root-dir <dir>` **converts zero components** when `<dir>` sits inside a
    tree containing an `sfdx-project.json`. Raw mdapi output is therefore
    staged in the OS temp dir, outside the repo.
  - the **working directory must itself be inside a Salesforce project**, or
    the CLI refuses with `RequiresProjectError` and converts nothing.

  So the staging dir must be outside a project while cwd is inside one. If your
  repo has no `sfdx-project.json` at its root, every chunk will retrieve and
  then fail to convert — the run warns about this once, up front, rather than
  letting you discover it as an empty snapshot.

**4. Commit.** The target tree is cleared, the converted source is committed,
and the run's own provenance goes in alongside it under `.org-snapshot/`
(index summary, retrieve report, reconciliation) so a snapshot carries the
evidence of how complete it is.

### What lands where

| Path | Committed? | What |
|---|---|---|
| `force-app/main/default/**` | yes | the retrieved metadata, source format |
| `.org-snapshot/` | yes | index summary, retrieve report, reconciliation |
| `.metadata-export/<run-id>/` | **no** | working files — the raw index, chunk manifests, `manifest-plan.json` |
| `$TMPDIR/cairnci-metadata-export/` | n/a | raw mdapi staging, deleted after each chunk converts |

`.metadata-export/` is only ever written, never staged — the commit is scoped
to the target dir and `.org-snapshot/`. It will show up as untracked in your
repo after a local run; add it to your `.gitignore` if that bothers you. Keep
it when a run goes wrong: it holds the exact manifests that were sent to the
org, which is what you need to reproduce a failed chunk by hand.

## Unretrievable metadata

Some components are visible to the CLI but cannot be retrieved. Neither kind
aborts the run.

**Expected.** [`known-unretrievable.json`](known-unretrievable.json) is tracked
reference data: types documented as unretrievable, each with a category, the
reason, a workaround, and a **source link**. Findings matching it are reported
as expected, so nobody investigates a limitation Salesforce already documents.
Entries are labeled `verified: "observed"` (confirmed against a real org from
this repo) or `"docs"`.

The file is a **seed, not an exhaustive list** — extend it from real run output
rather than guessing. Salesforce also documents whole features whose metadata
is unavailable API-wide; that list changes every release and is linked rather
than duplicated.

**Unexplained.** Anything else is reported with its raw error and the guidance
that it is *either a missing permission for the user the job authenticated as,
or an undocumented Metadata API incompatibility* — check permissions first,
since the Metadata API only returns what that user can see. If it turns out to
be a real limitation, add it to `known-unretrievable.json` with a source.

A third case is handled automatically: the installed `sf` CLI validates every
manifest member against its own bundled type registry *before* contacting the
org, so one type the CLI doesn't know (confirmed:
`IdentityVerificationProcDtl`, a Public Sector Solutions type) fails the entire
chunk. The run detects this from the error, drops that type, and retries the
chunk. Upgrade `@salesforce/cli` to actually capture such types.

## Runtime

A full retrieve of a large Industries / Public Sector org runs for **hours**.
GitHub's hard job ceiling is 360 minutes; the example caller sets
`timeout-minutes: 350` so the job reports rather than being killed mid-commit.
If you hit the ceiling: raise `max-weight` (fewer, larger chunks), lower
`concurrency` if the org throttles indexing, or run on a self-hosted runner.

## Why there is no `run.sh`

Every extension in this repo ships a `run.sh` so the extension caller can
invoke it at a deploy/validate lifecycle phase. This one deliberately does not.
A multi-hour full-org retrieve has no business running inside a deploy
pipeline — admin tools are standalone scheduled or dispatched jobs. See
[docs/admin-tools.md](../../../docs/admin-tools.md).

## Development

Zero runtime dependencies — `node:` builtins only, no build or bundling step.

```bash
node --test .github/actions/retrieve-org-metadata/tests/*.test.mjs
```

or, from this directory:

```bash
npm run test:retrieve-org-metadata
```

The default suite is org-free: the `sf` layer is injected
(`createSfClient({ run })` in `lib/sf-cli.mjs`) and stubbed, and the CLI suite
puts a fake `sf` on `PATH` and drives real temp git repos.
`integration-retrieve-org-metadata.yml` runs them plus an end-to-end smoke on
every change.

### Org-gated tests

The unit suites prove the logic. They cannot prove the **claims about
Salesforce** the logic rests on — that `unfiled$public` is invisible to a
`Folder` query, that `listMetadata` caps at 3,000 rows, that a real org's
weighted volume exceeds the 10,000-file ceiling, that the two `@salesforce/cli`
workarounds still emit files. `tests/*.org.test.mjs` checks each of those
against a live org:

```bash
cd .github/actions/retrieve-org-metadata
ORG_METADATA_LIVE_ORG=CairnCI_Production npm run test:retrieve-org-metadata:org
```

**Run it serially.** That script passes `--test-concurrency=1` deliberately.
Every `sf` call is a separate Node process, so a live run is bounded by how
fast processes start, not by the org: four suites indexing in parallel at the
default concurrency pushed a laptop's load average past 25 and turned
40-second tests into 15-minute timeouts, while the org's own API limits were
barely touched (149,773 of 151,200 daily requests still free).
`ORG_METADATA_CONCURRENCY` (default 2) throttles the calls within each index.

It is **read-only and safe against production**: it never creates a branch,
commits, pushes, or writes into `force-app`. Retrieves go to temp directories,
and the index is scoped to a handful of types by wrapping the real client and
narrowing only `describeMetadata` — so calls are genuinely live but the suite
runs in a couple of minutes instead of the ~5 a full index takes. Two wiring
tests enforce all of that: one asserts the suite stays skipped without an org
(so CI, which has no org, never runs it), the other asserts the file cannot
even import the branch-creating code.

That glob is matched by `tests/*.test.mjs`, so the org file is loaded in CI —
its suites simply skip, and only the wiring guards run.

### The full-retrieval test

`tests/full-retrieve.live.test.mjs` runs the real thing: a full-org index, a
multi-chunk retrieve of **every** chunk, a snapshot branch, a commit and a
push — `runFullRetrieval` called exactly as `action.yml` calls it, at the
shipped default concurrency. It is what makes "we test what we publish" true;
the two suites above never retrieve at org scale and never create a branch.

```bash
cd .github/actions/retrieve-org-metadata
ORG_METADATA_FULL_RETRIEVE=CairnCI_Production npm run test:retrieve-org-metadata:full
```

It is gated on its **own** variable. `ORG_METADATA_LIVE_ORG` deliberately does
not trigger it: that one belongs to the two-minute read-only suite, and nobody
should start a multi-hour run by setting the casual variable.

It writes into a throwaway git repo under the OS temp dir, seeded as a
Salesforce project with one tracked component that exists in no org. That
sentinel is what proves the replace is **wholesale** rather than a merge — the
branch must record it as a deletion. The temp repo's `origin` is a local bare
repo, so `git push` genuinely runs and the ref is read back out of the remote,
without ever creating `org-snapshot/*` branches in this repository. Three
wiring tests enforce the isolation structurally.

Assertions it alone can make: every indexed component reaches a manifest and
comes back (`reconciliation`), more than one chunk is planned and each stays
under the weight budget, every unretrievable type the org produces is explained
by `known-unretrievable.json`, the branch name matches the documented pattern,
the commit carries thousands of source files across several type directories
plus the three provenance files — and the run finishes inside the 350-minute
budget the example caller documents. That last number was a guess until this
test started measuring it; the measured runtime is written to the job summary
on every run.

In CI it runs on **pull requests into `main`**, and on `workflow_dispatch` with
`run-full-retrieve: true`. That is deliberately a review gate rather than a
post-merge one: a real snapshot is worth seeing before approving, not after.
Because it is hours long, the job cancels its own superseded runs, so pushing
again to an open PR replaces the running retrieval instead of queueing behind
it. PRs from forks are skipped — `environment: main`'s `SFDX_AUTH_URL` is not
exposed to them.

Layout follows the repo convention — `lib/*.mjs` is pure and side-effect-free,
`retrieve.mjs` owns all IO (argv, annotations, job summary, outputs, exit
codes).

## Release

This tool ships on the **core** channel to CairnCI-Public with the
`sf-validate`/`sf-deploy` workflows, on a `v*` tag — not to CairnCI-Extensions.
It is a prerequisite for adopting CairnCI rather than an optional add-on, so it
versions with the core release. `publish-extension.yml` rejects a
`retrieve-org-metadata/v*` tag.
