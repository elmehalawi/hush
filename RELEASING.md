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

## Version Numbering

- `version` (`CFBundleShortVersionString`): user-facing version, e.g. `1.2.0`
- `build_number` (`CFBundleVersion`): monotonically increasing integer, e.g. `5`. Sparkle uses this to determine if an update is newer. Always increment this.

## How Auto-Update Works

- Sparkle 2 is embedded in the app via CocoaPods
- On launch, Sparkle checks `https://raw.githubusercontent.com/elmehalawi/hush/main/appcast.xml` daily
- `appcast.xml` lists available versions with download URLs pointing to GitHub release assets
- Updates are verified using EdDSA signatures (key stored in macOS Keychain)

## Key Files

| File | Purpose |
|------|---------|
| `release.sh` | Release automation script |
| `build.sh` | Build script (called by release.sh) |
| `appcast.xml` | Sparkle update feed (auto-generated, committed to repo) |
| `sparkle-tools/` | Sparkle CLI tools (gitignored) |
| `releases/` | DMG output directory (gitignored) |
| `macos/signal-app-macOS/Info.plist` | Contains `SUFeedURL` and `SUPublicEDKey` |
