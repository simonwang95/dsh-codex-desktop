# DSH Codex Desktop

Cross-platform Electron desktop shell for the official DeepSeek Harness (DSH) web runtime.

[简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

## Current distribution boundary

The default build is **core-only**: it contains the official `@deepseek-ai/dsh` runtime and the Node/pnpm toolchain required to launch it. It does not download or seed a third-party plugin catalog. Existing third-party packages in a user's DSH profile are preserved and remain user-managed.

Desktop updates are disabled unless an independent generic feed is explicitly configured. There is no default GitHub owner or release URL. Optional configuration:

```text
DSH_DESKTOP_UPDATE_URL=https://updates.example.test/desktop/
DSH_DESKTOP_RELEASE_NOTES_URL=https://example.test/changes
DSH_DESKTOP_FEEDBACK_URL=https://example.test/feedback
```

Only HTTPS is accepted, except loopback HTTP for local testing. The app never checks for desktop updates on startup.

## Runtime upgrades

The DSH, Node, and pnpm versions are declared in `package.json#config.runtimeManifest`. The official DSH dependency graph is frozen in `runtime-lock/package-lock.json` and assembled with `npm ci`.

Runtime candidates are installed under a versioned directory, checked for package identity, entry point, aligned `@deepseek-ai/dsh*` versions, archive integrity, and loopback HTTP health using an isolated profile. A small atomic state file selects `current` and records `last-known-good`. A failed candidate never replaces current; a failed first real launch rolls back automatically. A newer runtime bundled with a desktop installer is not activated over an existing runtime without user confirmation.

User sessions, credentials, and plugins remain under `~/.dsh`; runtime switching does not delete that profile.

## Build and verification

Required toolchain:

- Node `24.19.0`
- pnpm `11.22.0`

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run check:independence
pnpm test
pnpm run prepare-runtime
pnpm run pack
```

Create unsigned platform packages with `pnpm run dist -- --mac --arm64` on Apple Silicon macOS or `pnpm run dist -- --win --x64` on native Windows x64. The repository workflow is manual-only and uploads temporary Windows artifacts; it does not create tags or GitHub Releases.

## Personal unsigned packages

Local, non-release deliverables are kept in ignored `release/personal/`. Unsigned macOS packages may be blocked by Gatekeeper: in Finder, Control-click this app and choose **Open**, then confirm only this app. Unsigned Windows packages may show SmartScreen: inspect the publisher/file details, choose **More info**, then **Run anyway** only for the verified local file. Do not disable either operating system protection globally.

## Security baseline

- DSH binds explicitly to `127.0.0.1` on a random port and is loaded only after HTTP health succeeds.
- Electron keeps `nodeIntegration: false`, `contextIsolation: true`, sandboxed renderers, restricted navigation, and narrow IPC.
- Shutdown only targets the process tree created by this app.
- Upgrade logs contain only stage/version/path categories and sanitized errors, never credentials or conversation content.

Licensed under Apache-2.0. Historical attribution remains in `LICENSE` and changelogs.
