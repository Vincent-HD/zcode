# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Linux (Nix flake, this fork)

The flake builds the renderer and server from this checkout, then repacks them into the matching
upstream x86_64 AppImage to retain its Electron runtime, native modules, and desktop assets. Before
fetching the pnpm closure, the build checks the lockfile, workspace configuration, and dependency
fields in every workspace manifest against the source tag for that AppImage version. It also compares
`apps/desktop`, `native`, `packages/shared`, `packages/ssh`, and `packages/tailscale` source trees
byte-for-byte with that tag. These are the source inputs for the desktop and native runtime retained
from the AppImage; the server and web sources are rebuilt from this checkout. Before fetching
dependencies, the check verifies that the SPDX version and revision in Nix match the license
generator. The build generates the open source notices from this fork's built web bundle and pinned
SPDX license data:

```bash
nix build .#z-code --no-link
nix run .#z-code
```

The package is Linux x86_64 only. It provides the `z-code`, `zcode`, and `t3code` commands and
flake package/app aliases. The app keeps its upstream T3 Code identity and uses the same
`~/.t3/userdata` state, so existing data is shared with the upstream desktop app. Back up that
state before switching versions; downgrading the binary does not reverse database migrations.

After rebasing this fork onto the upstream release you want to package, run the updater with that
release version:

```bash
./scripts/update-z-code-nix.sh 0.1.3-nightly.20261027.3754
# Preview the candidate pins, then restore nix/default.nix:
./scripts/update-z-code-nix.sh --dry-run 0.1.3-nightly.20261027.3754
```

The updater proves that the selected upstream tag commit is an ancestor of the fork's current `HEAD`
without fetching or changing Git refs. It reads the `upstream` remote by default; set
`Z_CODE_UPSTREAM_REMOTE` if that remote has a different name. It then synchronizes the version,
AppImage hash, upstream source hash, and pnpm closure hash. It refreshes the fixed-output pnpm
closure to derive its hash; it does not build the complete package. Tracked dirty changes are
included in the flake source and the preflight. Untracked files are refused because Git flakes omit
them. A mismatch in the lockfile, workspace configuration, license configuration, workspace package
identity/version/dependency declarations, retained desktop/native source trees, or SPDX generator
pins stops the update before pins change. Source changes used by the rebuilt server and web outputs,
including the current feature changes, remain allowed.

After updating pins, you can optionally build the complete package separately:

```bash
nix build .#z-code --no-link
```

This full build is not part of pin refresh and can require substantially more disk space.

The build regenerates license notices from the fork's web bundle, so added or removed bundled npm
imports receive notices from the fork's actual dependency tree. The upstream AppImage remains the
source of the Electron runtime and native modules. The source check compares only the listed desktop
and native trees, alongside the workspace dependency graph; source outside those areas is not
compared. It permits changes to server/web build inputs such as contracts and client-runtime because
they feed the replacement outputs. This is not a comprehensive ABI proof: it does not prove
compatibility between the rebuilt server/web protocol and the retained desktop binary, or verify
that a native module's ABI matches Electron. Review those boundaries before packaging. A dependency
graph change needs a matching upstream runtime or a separate runtime update, and the build fails until
the pinned source tag and fork manifests agree.

`flake.lock` pins the exact Nixpkgs revision used by the package. Refresh it from the
`nixos-unstable` ref declared in [`flake.nix`](./flake.nix) with `nix flake update nixpkgs`.
The local source is the flake's `self`, not a downloaded tarball or a Nix-applied feature patch set.
In a Git checkout, add new source files to the index before building because Git flakes omit
untracked files. Changes to the upstream AppImage layout, Electron ABI, or native dependency graph
need review before updating this packaging path.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
