# Moved

This tooling is now the **Full Org Metadata Retrieval** admin tool at
[`.github/actions/retrieve-org-metadata/`](../../.github/actions/retrieve-org-metadata/),
where it has unit tests, a GitHub Action wrapper, snapshot-branch creation, and
scheduled/manual triggers — and ships to CairnCI-Public with the core release.

Run it locally the same way, against a checkout with an authenticated `sf`:

```bash
node .github/actions/retrieve-org-metadata/retrieve.mjs \
  --target-org CairnCI-Main --create-branch false
```

| Was | Now |
|---|---|
| `run-all.mjs` | `retrieve.mjs` (all three phases) |
| `run-all.mjs --skip-retrieve` | `retrieve.mjs --skip-retrieve true` |
| `index-metadata.mjs` / `plan-manifests.mjs` / `retrieve-metadata.mjs` | `lib/` modules, called by `retrieve.mjs` |
| `--target-org`, `--target-dir`, `--max-weight`, `--concurrency`, `--wait`, `--keep-staging`, `--api-version` | unchanged |
| `--run-dir`, `--only-chunk` | dropped — a run is now one atomic snapshot; re-run the action to retry failed chunks |

See the action's [README](../../.github/actions/retrieve-org-metadata/README.md)
for the chunking model, the unretrievable-metadata handling, and the
`@salesforce/cli` workarounds this tool encodes.
