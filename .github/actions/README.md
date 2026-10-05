# CairnCI Composite Actions

Composite actions developed and validated here before publishing. **Not all of
them publish to the same place** — check which class you are adding first.

| Class | Naming | Publishes to | On tag |
|---|---|---|---|
| Core framework | `extension-caller` | CairnCI-Public | `v1.2.3` |
| Admin tool | `name: "Tool: …"` | CairnCI-Public | `v1.2.3` |
| Extension | everything else | CairnCI-Extensions | `<name>/v1.2.3` |

## Adding an extension

1. Create `.github/actions/<extension-name>/action.yml`
2. Add unit tests under `.github/actions/<extension-name>/tests/`
3. Add an integration workflow at `.github/workflows/integration-<extension-name>.yml`
4. Tag and publish: `git tag field-governance-gate/v1.0.0 && git push origin field-governance-gate/v1.0.0`

See [docs/extensions.md](../../docs/extensions.md) for the full development and
publishing guide.

## Adding an admin tool

Admin tools set up and maintain a CairnCI repo rather than gating a change
inside a pipeline. They never fail the calling job, ship no `run.sh`, and ride
the core `v*` release to CairnCI-Public — which means adding one requires
editing **both** `PUBLISH_PATHS` and the safety-net grep regex in
`publish-tag.yml`, plus the rejection `case` in `publish-extension.yml`.

See [docs/admin-tools.md](../../docs/admin-tools.md) for the rules and the full
checklist.
