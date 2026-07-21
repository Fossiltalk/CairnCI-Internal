#!/usr/bin/env bash
# Extension-caller entry point. The caller sets CAIRNCI_WORKSPACE and the other
# CAIRNCI_* env vars; the CLI reads them and runs against the consumer repo.
# Exit code feeds the caller's contract (0 ok, 10 warn — never blocks, 2 error).
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/dist/index.mjs"
