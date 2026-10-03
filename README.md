# Strevokit Meeting SDK

Source for [`@strevokit/meeting-sdk`](https://www.npmjs.com/package/@strevokit/meeting-sdk), the headless browser SDK
for joining Strevokit meetings from your own web product.

## Install

```bash
npm install @strevokit/meeting-sdk
```

The quick start, security notes, and browser support are in the
[package README](./packages/meeting-sdk/README.md). The full API is described in the
[API reference](./packages/meeting-sdk/docs/api-reference.md), with
[plain HTML and React examples](./packages/meeting-sdk/docs/examples/).

## Repository status

This repository is a **read-only mirror** of the SDK source. Changes are made upstream and synced here as single
commits; each commit message names the upstream commit it came from. Pull requests are not accepted.

## Issues

Report problems through [GitHub Issues](https://github.com/AgiliaIT/strevokit-meeting-sdk/issues). See
[CONTRIBUTING.md](./CONTRIBUTING.md) for what to include.

## Building from source

Requires Node.js 22.12 or later.

```bash
cd packages/meeting-sdk
npm run protocol:build   # builds the bundled signaling protocol package
npm ci
npm run build
npm test
```

| Path | Contents |
|---|---|
| `packages/meeting-sdk/` | The published SDK package |
| `packages/signaling-protocol/` | The realtime signaling contract, bundled into the SDK (not published on its own) |
| `scripts/ci/sdk.sh` | The CI stages run by this repository's workflows |

## Releases and provenance

Versions are published to npm from this repository's `release` workflow with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements), so each published version links back to the
commit it was built from. Release tags are named `meeting-sdk-v<version>`. Changes are listed in the
[changelog](./packages/meeting-sdk/CHANGELOG.md).

## License

No license has been chosen yet; all rights reserved.
