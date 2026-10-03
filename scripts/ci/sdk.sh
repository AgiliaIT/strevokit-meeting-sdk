#!/usr/bin/env bash
# CI stage entrypoints for the SDK package family.
# Real stages: packages/signaling-protocol and packages/meeting-sdk (the SDK bundles the protocol, so the
# protocol is built before the SDK's dependencies are installed). No container stage.
set -euo pipefail

STAGE="${1:?usage: $0 <lint|static-analysis|unit|integration|build|security>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PLACEHOLDER="$ROOT/scripts/ci/placeholder-ok.sh"
PROTOCOL="$ROOT/packages/signaling-protocol"
SDK="$ROOT/packages/meeting-sdk"

# Builds the protocol, installs the SDK, then runs each named SDK npm script in order.
sdk() {
  (
    cd "$SDK"
    npm run protocol:build
    npm ci
    for script in "$@"; do
      npm run "$script"
    done
  )
}

case "$STAGE" in
  lint)
    bash "$PLACEHOLDER" "sdk/lint (signaling-protocol)"
    sdk lint
    ;;
  static-analysis)
    (cd "$PROTOCOL" && npm ci && npx tsc -p tsconfig.json --noEmit)
    sdk typecheck
    ;;
  unit)
    (cd "$PROTOCOL" && npm ci && npm test)
    sdk test
    ;;
  integration)
    bash "$PLACEHOLDER" "sdk/integration (signaling-protocol)"
    sdk build api:check check:surface check:docs pack:smoke check:publish-hygiene
    ;;
  build)
    (cd "$PROTOCOL" && npm ci && npm run build)
    sdk build check:size check:release
    ;;
  security)
    (cd "$PROTOCOL" && npm ci && npm audit --omit=dev)
    (cd "$SDK" && npm ci && npm audit --omit=dev)
    ;;
  *)
    echo "unknown stage: $STAGE" >&2
    exit 1
    ;;
esac
