#!/usr/bin/env bash
# Extension-caller entry point. The caller sets CAIRNCI_WORKSPACE and the other
# CAIRNCI_* env vars; gate.mjs reads them and runs against the consumer repo.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/gate.mjs"
