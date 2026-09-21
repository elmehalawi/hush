# Releasing Hush

## Quick Start

```bash
./release.sh <version> <build_number>
```

Example:

```bash
./release.sh 1.1.0 4
```

This single command does everything:

1. Sets the version in `Info.plist`
2. Builds the app in release mode (Rust + Swift + Xcode)
3. Creates a DMG with an Applications symlink
4. Signs the DMG with Sparkle's EdDSA key
5. Publishes a GitHub release with the DMG attached
6. Generates `appcast.xml` with the correct download URL
7. Commits and pushes `appcast.xml`

Users with Hush already installed will get the update automatically (checked daily) or via **Hush > Check for Updates...** in the menu bar.

## Prerequisites

- **Sparkle tools** in `sparkle-tools/` (download from [Sparkle releases](https://github.com/sparkle-project/Sparkle/releases), extract the tarball)
- **GitHub CLI** (`gh`) authenticated (`brew install gh && gh auth login`)
- **EdDSA signing key** in Keychain (generated once with `sparkle-tools/bin/generate_keys`)
- **Developer ID Application certificate** in the login keychain, plus notarization credentials. Copy `.signing.env.example` to `.signing.env` and fill it in; `.signing.env` is gitignored so nothing secret enters this public repo.

### One-time signing setup

1. In Xcode, **Settings > Accounts > Manage Certificates > + > Developer ID Application**, or download one from [the developer portal](https://developer.apple.com/account/resources/certificates/list). Confirm it landed:

   ```bash
   security find-identity -v -p codesigning
   ```

   Only the **Account Holder** can create this certificate type. The App Store Connect API rejects it with `403 FORBIDDEN_ERROR — This operation can only be performed by the Account Holder`, regardless of the key's role, so it cannot be scripted.

2. Notarization takes an App Store Connect API key directly, which needs no keychain write and so works in non-interactive shells. Point `NOTARY_KEY` at the `.p8` and set `NOTARY_KEY_ID` / `NOTARY_ISSUER`. A keychain profile via `notarytool store-credentials` also works if you prefer; set `NOTARY_PROFILE` instead.

3. `cp .signing.env.example .signing.env` and fill it in.

`release.sh` refuses to run if the identity or the notarization credentials are missing.

## Why Releases Must Be Signed

Sparkle will only install an update whose code signature matches the installed app's. An ad-hoc signature (`codesign --sign -`) carries no certificate, so the bundle's designated requirement is pinned to that exact binary's `cdhash`. Every new build has a different hash, so the check can never pass and the install fails with a generic "an error occurred while running the updater" after a successful download. A Developer ID certificate gives a stable team identity across builds, which is what makes the check pass.

Switching to a certificate does not rescue installs that are already ad-hoc signed: Sparkle compares against the copy on disk, which is still hash-pinned. Those machines need one manual DMG install of a signed build before auto-updates start working.

## Version Numbering

- `version` (`CFBundleShortVersionString`): user-facing version, e.g. `1.2.0`
- `build_number` (`CFBundleVersion`): monotonically increasing integer, e.g. `5`. Sparkle uses this to determine if an update is newer. Always increment this.

## How Auto-Update Works

- Sparkle 2 is embedded in the app via CocoaPods
- On launch, Sparkle checks `https://raw.githubusercontent.com/elmehalawi/hush/main/appcast.xml` daily
- `appcast.xml` lists available versions with download URLs pointing to GitHub release assets
- Updates are verified using EdDSA signatures (key stored in macOS Keychain) *and* a code signature match against the installed app
- Delta patches are uploaded as assets on the same release tag as the DMG, so `generate_appcast` is run with `--download-url-prefix` pointing at that tag. Rewriting only the DMG URL leaves every delta 404ing.

## Key Files

| File | Purpose |
|------|---------|
| `release.sh` | Release automation script |
| `build.sh` | Build script (called by release.sh) |
| `appcast.xml` | Sparkle update feed (auto-generated, committed to repo) |
| `sparkle-tools/` | Sparkle CLI tools (gitignored) |
| `releases/` | DMG output directory (gitignored) |
| `macos/signal-app-macOS/Info.plist` | Contains `SUFeedURL` and `SUPublicEDKey` |
| `.signing.env` | Signing identity and notary profile (gitignored) |
| `macos/signal-app-macOS/signal-app.entitlements` | Hardened runtime entitlements |
