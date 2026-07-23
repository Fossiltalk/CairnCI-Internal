# CairnCI Extensions

Composite actions developed and validated here before publishing to
[Fossiltalk/CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions).

## Adding an extension

1. Create `.github/actions/<extension-name>/action.yml`
2. Add unit tests under `.github/actions/<extension-name>/tests/`
3. Add an integration workflow at `.github/workflows/integration-<extension-name>.yml`
4. Tag and publish: `git tag field-governance-gate/v1.0.0 && git push origin field-governance-gate/v1.0.0`

See [docs/extensions.md](../../docs/extensions.md) for the full development and
publishing guide.
