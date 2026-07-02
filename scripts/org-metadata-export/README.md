# org-metadata-export

Indexes every metadata component in a connected Salesforce org and retrieves
all of it, split into `package.xml` chunks that stay under the Metadata API's
retrieve ceiling (10,000 files per request), merging the result into a
standard source-format tree at `force-app/main/default/...`. Built for large
Industries / Public Sector Solutions orgs where a single org-wide manifest
would exceed that limit.

`force-app/` here is this CI-tooling repo's own scratch directory (not a
registered `packageDirectory` in `sfdx-project.json`, so nothing in the
`sf-validate`/`sf-deploy` CI workflows will pick it up) — this is meant as
your working copy of the org's metadata, not something published alongside
the CairnCI-Public/CairnCI-Extensions split.

Dependency-free Node (`.mjs`, built-ins only) that shells out to the `sf`
CLI, matching how the rest of this repo's CI workflows only ever call `sf`
rather than talking to the REST/Tooling API directly.

## Usage

```bash
# Full run: index -> plan chunks -> retrieve everything
node scripts/org-metadata-export/run-all.mjs --target-org CairnCI-Main

# Just build the index + manifests, skip the actual retrieve
node scripts/org-metadata-export/run-all.mjs --skip-retrieve

# Re-run phases independently against an existing run directory
node scripts/org-metadata-export/index-metadata.mjs --target-org CairnCI-Main
node scripts/org-metadata-export/plan-manifests.mjs --run-dir .metadata-export/<run-id>
node scripts/org-metadata-export/retrieve-metadata.mjs --run-dir .metadata-export/<run-id>

# Retrieve a single chunk (e.g. to retry a failed one, or sanity-check first)
node scripts/org-metadata-export/retrieve-metadata.mjs --run-dir .metadata-export/<run-id> --only-chunk 003

# Merge into a different directory instead of force-app/
node scripts/org-metadata-export/run-all.mjs --target-dir org-export
```

Index/manifest/report bookkeeping lands in `.metadata-export/<run-id>/`
(gitignored); the actual retrieved metadata is merged into `force-app/`
(tracked, not gitignored):

```
.metadata-export/<run-id>/
  index/metadata-index.json   # every component, by type
  index/summary.md            # counts per type, truncation warnings
  manifests/package-chunk-NNN.xml
  manifests/manifest-plan.json
  retrieve-report.json        # per-chunk succeeded/failed

force-app/main/default/       # merged, standard source-format output
  classes/*.cls
  objects/**
  ...
```

Raw per-chunk mdapi retrieve output is staged under the OS temp directory
(`$TMPDIR/cairnci-metadata-export/<run-id>/`, see "Retrieval" below for why)
and deleted automatically after a successful conversion; pass
`--keep-staging` to retain it for debugging.

## Flags

| Flag | Default | Applies to |
|---|---|---|
| `--target-org` | `CairnCI-Main` | index, run-all |
| `--run-dir` | new timestamped dir under `.metadata-export/` | plan, retrieve, run-all |
| `--target-dir` | `force-app` | retrieve, run-all — where converted source is merged |
| `--api-version` | org's current API version | index, run-all |
| `--concurrency` | `6` | index, run-all — parallel `sf org list metadata` calls |
| `--max-weight` | `9000` | plan, run-all — see "Chunking" below |
| `--weights-file` | none | plan — JSON file of type→weight overrides |
| `--wait` | `60` (minutes) | retrieve, run-all — per-chunk retrieve timeout |
| `--only-chunk` | none | retrieve — retrieve a single chunk by number |
| `--keep-staging` | off | retrieve, run-all — don't delete per-chunk mdapi staging after conversion |
| `--skip-retrieve` | off | run-all — stop after building manifests |

## How indexing works

1. `sf org list metadata-types` (describeMetadata) enumerates every metadata
   type in the org (~363 in a typical PSS org).
2. Types that only ever appear as a *child* of another type (e.g.
   `CustomLabel` under `CustomLabels`, `WorkflowAlert` under `Workflow`) are
   skipped — they come along automatically when their parent is retrieved,
   and `listMetadata` calls against them don't return anything useful.
3. Folder-based types (`Report`, `Dashboard`, `Document`, `EmailTemplate`)
   are listed per-folder: all folders are fetched in one `Folder` SOQL
   query, then `sf org list metadata --folder <name>` runs once per folder.
4. Everything else is a single `sf org list metadata --metadata-type <type>`
   call.

### The 3,000-record cap

`listMetadata` silently truncates at 3,000 results per call — no error, no
pagination. If a call returns exactly 3,000 rows, it's treated as truncated.
For a fixed table of known high-volume types (`ApexClass`, `ApexTrigger`,
`ApexPage`, `ApexComponent`, `StaticResource`, `PermissionSet`, `Flow`,
`LightningComponentBundle`, `AuraDefinitionBundle`, `CustomField`, `Layout`,
`ValidationRule` — see `lib/tooling-fallback.mjs`), the full list is instead
fetched via a paginated Tooling/REST API SOQL query.

**Known gap:** any *other* type that hits the 3,000-row boundary has no
registered fallback and is recorded in the index as
`truncated: true, fallback: "unavailable"` (also surfaced in
`summary.md` and the console output) rather than silently under-counted.
`CustomMetadata` is the most likely candidate in an OmniStudio-heavy org,
since its records span arbitrary `__mdt` objects with no single queryable
Tooling object — recovering it would mean discovering every custom metadata
type and querying each one's records individually, which isn't implemented
here. If you hit this, extend `lib/tooling-fallback.mjs` for that type.

Managed package metadata (`PublicSector`, `OmniStudio`, `wkdw`, etc.) is
**not** filtered out — the index includes everything the API surfaces. Most
managed-package-internal components still won't be independently listable
or retrievable regardless (that's a Metadata API restriction, not something
this tool filters), but any exposed/extension components will be included.

## Chunking

The Metadata API's retrieve ceiling is on the number of *files* in the
result, not the number of `<members>` in the manifest. Types like
`CustomObject`, `Profile`, and `PermissionSet` each expand into many more
files per member (fields, record types, layouts, ...) than a simple
singleton type like `ApexClass` does. `plan-manifests.mjs` therefore packs
members into chunks by a **weighted** total, not a raw count:

- default weight `1` per member
- `CustomObject` → `20`, `Profile`/`PermissionSet` → `5`
- override via `--weights-file <path-to-json>`, e.g. `{"CustomObject": 30}`

A chunk is closed once adding the next member would push its weighted total
past `--max-weight` (default `9000`, safely under the 10,000 hard cap). A
single type's members can and often will split across multiple chunks —
that's valid; the Metadata API doesn't require a type to stay contiguous in
one `package.xml`.

If your org's `CustomObject`s carry an unusually high or low average field
count, tune `--max-weight` or the per-type weights rather than trusting the
defaults blindly for a very large or very small org.

## Retrieval

Chunks retrieve **sequentially**, and each chunk is a two-step
retrieve-then-convert, not a plain `sf project retrieve start`:

1. **Retrieve** (metadata API / zip format) into a per-chunk staging
   directory under the OS temp dir:
   `sf project retrieve start --manifest <chunk> --target-metadata-dir
   $TMPDIR/cairnci-metadata-export/<run-id>/<chunk-name> --unzip`.
2. **Convert** the staged mdapi output to source format, merged straight
   into `--target-dir` (`force-app` by default):
   `sf project convert mdapi --root-dir <staged>/unpackaged/unpackaged
   --output-dir force-app`.

Neither step is a stylistic choice — both work around real, empirically
confirmed bugs/restrictions in `@salesforce/cli` 2.140.6:

- Source-format retrieve (`sf project retrieve start --output-dir <dir>`)
  into any directory that isn't one of `sfdx-project.json`'s declared
  `packageDirectories` **silently no-ops**: the server-side retrieve
  succeeds, but the CLI prints `Warning: Nothing retrieved` and writes zero
  local files. Pointing it *at* the repo's one declared package directory
  (`tests/fixtures/force-app`, the CI test fixtures — not somewhere a real
  org dump belongs anyway) is separately blocked with
  `RetrieveTargetDirOverlapsPackageError`. `--target-metadata-dir` has
  neither restriction and reliably writes files regardless of project
  structure, hence step 1 uses it.
- `sf project convert mdapi --root-dir <dir>` **silently converts zero
  components** (`Error: No results to format`) when `<dir>` is nested
  inside a directory tree that itself contains an `sfdx-project.json` — as
  this repo's root does. So the raw per-chunk mdapi output can't be staged
  inside the repo (e.g. under `.metadata-export/`); it has to live outside
  it (OS temp dir), while `--output-dir` (`force-app`) is fine staying
  *inside* the repo — the CLI itself appends `main/default/` to whatever
  `--output-dir` you give it.

Each chunk's converted output merges naturally into `force-app/main/default`
since every chunk's members are disjoint. Staging directories are deleted
after a successful conversion (`--keep-staging` to retain them).

On failure, a chunk is recorded as failed in `retrieve-report.json` (with
its staging dir path, left in place for inspection) and the run continues
with the remaining chunks. Re-run just the failed ones with `--only-chunk
<NNN>` after investigating — results merge into the existing report rather
than clobbering prior successes.
