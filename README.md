# CairnCI — an open-source CI/CD pipeline for Salesforce DX

> **Not affiliated with Salesforce.** CairnCI is an independent,
> community-maintained open-source project. It is **not** affiliated with,
> endorsed by, sponsored by, or supported by Salesforce, Inc. "Salesforce",
> "Salesforce DX", and "SFDX" are trademarks of Salesforce, Inc., referenced here
> only nominatively to indicate the platform this tool works with. See
> [`NOTICE`](NOTICE).

Distributable GitHub Actions for Salesforce DX repos. Behavior is controlled
through inputs, secrets, and an optional in-repo config file. Two adoption paths
(see [docs/consumer-setup.md](docs/consumer-setup.md)):

- **Reference (recommended)** — slim caller workflows call a pinned version
  (`@v1`) of these reusable workflows; a local `.cairnci/config.json`
  controls which features run and how.
- **Vendor** — copy a pinned version of the workflows + actions into your own
  repo and call them locally (`./…`). For air-gapped / strict-security orgs that
  must keep all executed CI code in-repo, reviewed and pinned.

- **Validate on PR** — delta-only, check-only `sf project deploy validate` with `RunLocalTests`.
- **Deploy on merge** — branch→environment mapping; reuses the PR's validation for a
  **quick deploy**, with an automatic full-deploy fallback.
- **Built on the modern `sf` CLI + sfdx-git-delta**, with pinnable Node/CLI/plugin versions.
- **Runs on GitHub-hosted or self-hosted** runners.
- **Optional extensions** — opt-in add-ons (e.g. a field governance gate that blocks new
  fields lacking permission-set access or required governance metadata) live in
  [CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions).

**Start here:** [docs/consumer-setup.md](docs/consumer-setup.md) ·
example callers in [`examples/`](examples) ·
optional extensions in [CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions).

Workflows: [`sf-validate.yml`](.github/workflows/sf-validate.yml),
[`sf-deploy.yml`](.github/workflows/sf-deploy.yml).

## License

Licensed under the [Apache License 2.0](LICENSE) — permissive, with an explicit
patent grant. You may use it in commercial and internal/government DevOps
pipelines. See [`NOTICE`](NOTICE) for attribution.
