#!/usr/bin/env bash
# Honest no-op for CI stages whose real toolchain is not wired yet.
# Always exits 0. Replace callers with real lint/test/audit commands when ready.
set -euo pipefail

STAGE="${1:-unspecified}"
echo "ci-placeholder: stage '${STAGE}' — toolchain pending; exiting 0"
exit 0
