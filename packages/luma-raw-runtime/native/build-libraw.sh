#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "${SCRIPT_DIR}/scripts/fetch-sources.mjs"
bash "${SCRIPT_DIR}/scripts/build-deps.sh"
bash "${SCRIPT_DIR}/scripts/build-wasm.sh"
