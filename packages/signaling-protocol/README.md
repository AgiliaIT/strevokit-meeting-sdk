# `@strevokit/signaling-protocol`

The versioned realtime signaling contract used between Strevokit clients and the Strevokit realtime service. It defines
every message type, validates frames in both directions, and ships shared conformance samples so both sides are tested
against the same cases.

This package is **bundled into [`@strevokit/meeting-sdk`](../meeting-sdk/README.md)** and is not published to npm on
its own (`"private": true`). SDK users never import it directly.

- Runtime dependencies: none.
- Runs in browsers and Node.js (compiled against ES2022 only, with no DOM or Node APIs).
- Changes are listed in the [changelog](./CHANGELOG.md).

## Build and test

```bash
cd packages/signaling-protocol
npm ci
npm run build
npm test
```

The meeting SDK builds this package first (`npm run protocol:build` in `packages/meeting-sdk`) and bundles it, so the
published SDK has no dependency on it.
