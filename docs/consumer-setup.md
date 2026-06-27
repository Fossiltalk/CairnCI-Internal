# Consumer setup

> **Not affiliated with Salesforce.** CairnCI is an independent,
> community-maintained project, not affiliated with or endorsed by Salesforce, Inc.
> "Salesforce" and "SFDX" are trademarks of Salesforce, Inc., referenced here
> nominatively only. See [`NOTICE`](../NOTICE).

CairnCI is a set of **reusable GitHub Actions workflows** plus an optional
governance action. There are two supported ways to adopt it — pick one:

| | **Path A — Reference (recommended)** | **Path B — Vendor (clone in)** |
|---|---|---|
| How | Slim caller workflows call a pinned version of CairnCI (`@v1`); a local config file controls features/behavior. | Copy a pinned version of CairnCI's workflows + actions into your own repo and call them locally. |
| You maintain | A few short caller files + `.cairnci/*.json`. | The caller files **and** the copied pipeline code. |
| Updates | Bump the `@vX` tag. | Re-copy a newer tagged version. |
| Best for | Most teams; least to maintain. | Air-gapped / strict-security orgs that must keep **all** executed CI code in-repo, reviewed and pinned (common for government). |
| External dependency on CairnCI at runtime | Yes (resolved from GitHub at run time). | No — everything runs from your repo. |

Sections 1–3 apply to **both** paths. Then do **either** §4A or §4B.

---

## 1. Prerequisites

- A Salesforce DX repo (your metadata under `force-app/`, an `sfdx-project.json`).
- One Salesforce org per deployable branch (e.g. a dev sandbox, UAT, production).
- Branching that maps each deployable branch to an org (e.g. `develop` → dev
  sandbox, `uat` → UAT, `main` → production).

## 2. Get an SFDX auth URL for each org

```bash
sf org login web --alias myorg          # one-time, interactive
sf org display --target-org myorg --verbose   # copy the "Sfdx Auth Url" (force://...)
```

## 3. Store the auth URL as a secret

Use **GitHub Environments** so each branch deploys to the right org and you get
deployment protection rules for free:

1. Repo **Settings → Environments → New environment**. Name it to match the
   branch (e.g. `develop`, `uat`, `main`).
2. In each environment add a secret named `SFDX_AUTH_URL` with that org's URL.
3. (Optional) Add required reviewers / wait timers on the `main` environment to
   gate production.

For validation only (PRs), a single repository-level `SFDX_AUTH_URL` secret
pointing at a sandbox is enough.

---

## 4A. Path A — Reference a pinned version (recommended)

You add small caller workflows; the heavy lifting stays in CairnCI at the
version you pin. **Which features run** is decided by which callers you add;
**how they behave** is controlled by inputs and/or a committed config file (§6).

1. Copy the example callers into your repo's `.github/workflows/`:
   - [`examples/caller-validate.yml`](../examples/caller-validate.yml) — validate on PR.
   - [`examples/caller-deploy.yml`](../examples/caller-deploy.yml) — deploy on merge.
   - For the optional governance gate and other add-ons, see
     [CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions).
2. **Pin the version.** Each caller references a released tag, e.g.
   `uses: Fossiltalk/CairnCI/.github/workflows/sf-validate.yml@v1`. Use a
   major tag (`@v1`) for automatic minor updates, or pin to an exact tag/commit
   SHA for maximum reproducibility (recommended for production/government).
3. (Optional) Add [`examples/config.json`](../examples/config.json) at
   `.cairnci/config.json` to control behavior in-repo (§6).

A minimal validate caller:

```yaml
name: Salesforce Validate
on:
  pull_request:
    paths: ["force-app/**"]
jobs:
  validate:
    uses: Fossiltalk/CairnCI/.github/workflows/sf-validate.yml@v1
    secrets: inherit
```

> **Use `secrets: inherit` in the caller.** Environment-scoped secrets only
> resolve inside the reusable workflow's environment-bound job — they can't be
> passed explicitly from the caller (the caller has no environment context). The
> examples already do this.

To **enable a feature**, add its caller; to **disable** one, remove that caller
file. To turn an optional job on/off without removing the file, gate it with an
`if:` or a repo variable.

---

## 4B. Path B — Vendor a pinned version into your repo

Use this when policy requires every line of executed CI to live in your own repo,
reviewed and pinned (no external action references at run time).

1. **Copy a specific tagged version** of CairnCI's pipeline into your repo,
   preserving paths:
   - `.github/workflows/sf-validate.yml`
   - `.github/workflows/sf-deploy.yml`

   For example, from a checkout of `CairnCI` at tag `v1.2.0`:

   ```bash
   # run from the root of YOUR repo; SRC points at a CairnCI checkout @ the tag
   SRC=/path/to/CairnCI
   mkdir -p .github/workflows
   cp "$SRC/.github/workflows/sf-validate.yml" .github/workflows/
   cp "$SRC/.github/workflows/sf-deploy.yml"   .github/workflows/
   echo "vendored from Fossiltalk/CairnCI@v1.2.0" > .github/CAIRNCI_VERSION
   ```

   Record the version you copied (the `CAIRNCI_VERSION` marker above) so
   audits and future updates know exactly what's running. Optional extensions
   (e.g. the field gate) can be vendored the same way from
   [CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions).

2. **Add caller workflows that reference the copies locally** (note `./` instead
   of `Fossiltalk/CairnCI/...@v1`). The repo's own dogfood callers are ready
   templates — copy them:
   - [`.github/workflows/ci-validate.yml`](../.github/workflows/ci-validate.yml)
   - [`.github/workflows/ci-deploy.yml`](../.github/workflows/ci-deploy.yml)

   ```yaml
   # .github/workflows/sf-validate.yml (your caller)
   name: Salesforce Validate
   on:
     pull_request:
       paths: ["force-app/**"]
   jobs:
     validate:
       uses: ./.github/workflows/sf-validate.yml   # local copy, pinned by what you vendored
       secrets: inherit
   ```

3. (Optional) Add `.cairnci/config.json` exactly as in Path A (§6) — the
   resolution logic is identical.

4. **Updating:** re-copy the workflows/actions from a newer CairnCI tag and
   review the diff in a PR. Because there are no external `@vX` references, your
   pinned version is simply "whatever you last copied."

> Local `./` references resolve against **your** repo's checkout, which is why
> vendoring works without any cross-repo plumbing. (This is also why the
> reusable workflows are self-contained rather than split into separately
> referenced actions.)

---

## 5. How it behaves (both paths)

- **On every PR**: generates a delta of only the changed metadata, runs a
  **check-only** `sf project deploy validate` with `RunLocalTests`, and publishes
  the validation job-id as an artifact.
- **On merge to a deployable branch**: finds the validation produced for the
  merged PR and runs a **quick deploy** (no re-running tests). If no matching
  validation is available (e.g. you squash-merge, or it expired after ~10 days),
  it automatically falls back to a full deploy.

### 5a. Roll back the merge if a deploy fails (optional)

Validation can pass yet the real deploy still fail (timeouts, org-state drift,
row-lock errors, etc.). Salesforce auto-rolls-back the **org** on a failed
deploy, but your **git branch** still contains the merged change that never
landed. Set `rollback-strategy` (input or config) to re-align git with the org:

- `none` (default) — do nothing.
- `revert-pr` — open a PR that reverts the merged change(s). **Recommended for
  protected branches** (where Actions can't push directly).
- `revert-push` — push the revert straight to the branch. Requires the branch to
  allow pushes from `GITHUB_TOKEN`.

The revert handles all merge strategies (merge commit, squash, rebase). The
deploy job still reports failure so the problem stays visible.

**Permissions:** rollback needs the workflow token to have `contents: write`
(and `pull-requests: write` for `revert-pr`). Ensure your repo's
**Settings → Actions → General → Workflow permissions** is set to *Read and
write*, or grant it in your caller workflow — the reusable workflow can't exceed
what your repo allows.

### 5b. Matching and duplicate rule deployments (optional)

Salesforce enforces two hard limits on active duplicate management rules:

- **Max 5 active matching rules per object**
- **Max 5 active duplicate rules per object**

More importantly, **you cannot update a matching or duplicate rule while it is active** — Salesforce rejects the deploy outright. The required sequence is: deactivate → update → reactivate. Without this, any delta deploy that touches `MatchingRule` or `DuplicateRule` metadata will fail if those rules are currently active in the target org.

Set `ruleDeploy: true` (in config or via the `rule-deploy` input) to enable a 3-step deployment path for these types:

1. **Deactivate** — the changed rules are deployed with their status forced to `Inactive`. Other metadata is untouched at this point.
2. **Deploy main** — all other changed metadata deploys normally. The rules are safely inactive in the org.
3. **Activate** — the rules are deployed again with their actual intended changes and final status from source.

The feature also queries the org's Tooling API before deploying and raises a **warning** when any affected object is approaching the 5-rule limit and an **error** when it is already at the limit, blocking the deploy before anything is changed in the org.

**Constraints:** `ruleDeploy` only applies in delta mode (`delta: true`). In full-branch mode the rules deploy as part of the normal single-step deploy. Quick deploy (reusing the PR validation job-id) is also bypassed for runs that include rule changes, since the 3-step deploy path differs in scope from what was validated — the workflow falls back to a full deploy automatically.

```json
{ "ruleDeploy": true }
```

### 5c. Validate against a fresh scratch org (optional)

By default validation runs against the org from the `SFDX_AUTH_URL` secret. Set
`org-mode: scratch` on the **validate** caller to instead spin up an **ephemeral
scratch org**, validate against it, and delete it afterward. This needs a
`DEVHUB_SFDX_AUTH_URL` secret (a Dev Hub auth URL) and a scratch definition file
(`scratch-def-file`, default `config/project-scratch-def.json`). Handy for
validating against a clean org or for integration-testing the pipeline itself.
A fresh scratch org is empty, so pair it with `delta: false`.

### 5d. Delta vs. full-branch deploys (optional)

By default (`delta: true`) only the metadata that changed is validated/deployed,
using [sfdx-git-delta](https://github.com/scolladon/sfdx-git-delta) — fast, and
the common case. Set `delta: false` (input or config) to validate/deploy the
**entire `source-dir`** instead. In full-branch mode the sfdx-git-delta plugin is
not installed or used at all.

See the `rule-deploy` section (§5b) for a related constraint; that feature also requires delta mode.

> sfdx-git-delta is an unsigned Salesforce CLI plugin. Rather than auto-answering
> the install prompt, the pipeline adds it to the CLI's
> `unsignedPluginAllowList.json` so it installs without prompting. (See the
> [Salesforce allowlist docs](https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_allowlist.htm).)

---

## 6. Configuration: inputs and/or a config file

You can configure behavior two ways, and **mix them freely** (works the same in
both adoption paths):

- **Workflow inputs** — the `with:` block in your caller workflow. Best for a
  setting that differs per caller or that you want visible right next to the
  trigger.
- **A committed config file** — `.cairnci/config.json` in your repo. Best
  for project-wide settings you want version-controlled and reviewed in PRs
  (ideal for audit/change-control). See [`examples/config.json`](../examples/config.json).

**Precedence: explicit input → config file → built-in default.** An input only
"wins" when you actually set it (the overridable inputs default to empty = unset),
so leaving an input out lets the config file supply it. With neither, the
built-in default applies.

Structural settings — `runs-on`, `environment`, and the `on:` triggers — are
evaluated before any step runs, so they **must** stay in the caller workflow
(they can't come from the file). The config file covers behavioral settings:
`sourceDir`, `testLevel`, `tests`, `wait`, `rollbackStrategy`.

Optional extensions follow the same precedence with their own config files —
e.g. the field gate's `.cairnci/field-policy.json` (see
[CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions)).

## 7. Inputs (all optional)

| Input            | Default          | Notes |
|------------------|------------------|-------|
| `source-dir`     | `force-app`      | Your SFDX source directory. |
| `delta`          | `true`           | `true` = only changed metadata (sfdx-git-delta); `false` = whole `source-dir`. See §5d. |
| `test-level`     | `RunLocalTests`  | `NoTestRun` / `RunSpecifiedTests` / `RunLocalTests` / `RunAllTestsInOrg`. |
| `tests`          | `""`             | Space/comma separated classes when `RunSpecifiedTests`. |
| `node-version`   | `lts/*`          | Latest Node LTS. sfdx-git-delta requires >= 20. |
| `sf-cli-version` | `latest`         | npm dist-tag or exact version. |
| `sgd-version`    | `stable`         | sfdx-git-delta dist-tag or exact version. |
| `runs-on`        | `["ubuntu-latest"]` | JSON array string. Self-hosted: `'["self-hosted","linux"]'`. |
| `wait`           | `60`             | Minutes to wait for the org job. |
| `environment`    | `""` (deploy only) | GitHub Environment to deploy to. |
| `rollback-strategy` | `none` (deploy only) | `none` / `revert-pr` / `revert-push`. See §5a. |
| `org-mode`       | `auth-url` (validate only) | `auth-url` or `scratch` (create/delete an ephemeral scratch org from a Dev Hub). See §5c. |
| `scratch-def-file` | `config/project-scratch-def.json` (validate only) | Scratch definition file used when `org-mode: scratch`. |
| `min-coverage`   | `75` (validate only) | Minimum org-wide Apex coverage % required to pass. |
| `rule-deploy`    | `false`          | `true` = 3-step path for MatchingRule/DuplicateRule (deactivate → update → activate). Delta mode only. See §5b. |
| `config-file`    | `.cairnci/config.json` | Path to the optional JSON config file. |

## 8. Runners

Works on GitHub-hosted and self-hosted Linux runners. On self-hosted runners the
toolchain install detects an existing `sf`/`sfdx-git-delta` at the requested
version and skips reinstalling. Self-hosted runners that are not GitHub-hosted
should have `git`, `node`, `npm`, `unzip`, and (for quick-deploy reuse) the `gh`
CLI available; if `gh` is missing the deploy job simply runs a full deploy.

## 9. Optional extensions

Opt-in add-ons such as the field permission-set governance gate live in
[CairnCI-Extensions](https://github.com/Fossiltalk/CairnCI-Extensions).
