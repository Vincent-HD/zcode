# zcode

`zcode` is a community-maintained fork of T3 Code. This section describes the features maintained
in this fork and how to install or update its Linux x86_64 and macOS arm64 Nix package. The Original T3 Code README
below retains the upstream CLI and desktop installation instructions; those commands install
upstream builds and do not include this fork's additions. Fork development rules and the list of
upstream entry points to re-check after a rebase are in [`ZCODE.md`](./ZCODE.md).

## Features in this community fork

- **Usage and context:** The composer can show provider-reported account quota windows and reset times,
  context used and capacity, completed main-agent totals for the active provider session, and the
  last response's usage. Per-turn details use the recorded provider and model; token counts and
  models.dev API-equivalent cost estimates are available when usage data and rates exist.
  Throughput is output divided by the full turn duration, including tools and waits, and appears
  only when token and timing data are complete; it is not model generation speed. Providers report
  different fields, and missing values stay unavailable. Cost estimates are separate from
  subscription charges. Time to first token and breakdowns of system prompt, tools, and messages
  are unavailable unless a provider supplies them.
- **Jujutsu panel:** Open the **Jujutsu** tab from the chat's right-panel menu. Like jj-view,
  its **Source control** section lists the files changed in the working copy and up to ten of its
  mutable ancestors (`@-1`, `@-2`…), with restore and squash-into-parent per file; below it,
  the **Log** section shows a revision graph of the workspace's `revsets.log` (or a revset typed in the panel, which completes jj functions, your `revset-aliases`, bookmarks and tags, and offers common presets), loaded 100 revisions
  at a time. Click a revision for its details and changed files, which open in T3 Code's diff
  panel; Ctrl/Cmd+click selects several, Escape clears. Right-click (or Shift+F10) for jj-view's
  actions: new child/before/after, edit, describe, duplicate, abandon, absorb, squash into parent
  or ancestor, rebase onto the selection, merge, bookmarks, push and PR/MR publication through
  the existing forge integrations. Drag a revision onto another to rebase its branch; hold R to
  rebase only the revision, S to squash into, Shift+S to squash onto, D to duplicate or M to
  merge. Drag a bookmark to move it. The header undoes and redoes the workspace's own jj operations; once files change after an
  operation, Undo refuses rather than discarding those edits. It requires
  `jj` in the thread's environment and an existing jj workspace; it never initializes a
  repository. Destructive actions ask first, available actions depend on environment
  capabilities and permissions, and Squash Onto requires jj's experimental `--onto` option.
  A workspace without Git beside it shows a **Colocate** button (`jj git colocation enable`).
- **Jujutsu worktrees:** In a colocated jj repository, T3 Code's worktrees are created as jj
  workspaces (`jj workspace add --colocate`, jj 0.46 or newer), so jj and the Jujutsu panel work
  in them. The thread's branch is still checked out for T3 Code's Git features, but it only
  follows commits made with Git; `jj commit` there detaches Git's HEAD as usual. Removing the
  worktree also forgets its jj workspace; if it had uncommitted edits, its working copy stays in
  the log until **Abandon orphaned revisions…** in the panel's menu clears such undescribed heads
  (the **Orphaned revisions** revset preset lists them first).

## Fork-specific CI

This fork runs its focused regression suite on every push and pull request through
[`zcode-custom-tests.yml`](./.github/workflows/zcode-custom-tests.yml), which runs
[`scripts/test-zcode-custom.sh`](./scripts/test-zcode-custom.sh). Upstream workflows stay
byte-identical and are disabled in the repository settings instead. Workflows added upstream arrive
enabled, so rerun [`scripts/zcode-disable-upstream-workflows.sh`](./scripts/zcode-disable-upstream-workflows.sh)
after every rebase push.

## Linux and macOS installation and updates (Nix flake)

The flake builds the renderer and server from this checkout, then repacks them into the matching
upstream x86_64 AppImage on Linux, or the arm64 zip on macOS, to retain its Electron runtime, native
modules, and desktop assets. Before
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

The package supports Linux x86_64 and macOS arm64. On macOS it ships `Applications/T3 Code (Nightly).app`.
Repacking `app.asar` invalidates the upstream Developer ID signature, so the build rewrites the
`ElectronAsarIntegrity` header hash in `Info.plist` and re-signs every Mach-O file ad hoc. macOS may ask
again for Keychain access the first time, because the app's signing identity changed. It provides the
`z-code`, `zcode`, and `t3code` commands and
flake package/app aliases. The app keeps its upstream T3 Code identity and uses the same
`~/.t3/userdata` state, so existing data is shared with the upstream desktop app. Back up that
state before switching versions; downgrading the binary does not reverse database migrations.

After rebasing this fork onto the upstream release you want to package, re-check the entry points
listed in [`ZCODE.md`](./ZCODE.md), push, and rerun
`scripts/zcode-disable-upstream-workflows.sh`. Then run the updater with that release version:

```bash
./scripts/update-z-code-nix.sh 0.1.9-nightly.20261110.4478
# Preview the candidate pins, then restore nix/default.nix:
./scripts/update-z-code-nix.sh --dry-run 0.1.9-nightly.20261110.4478
```

The updater proves that the selected upstream tag commit is an ancestor of the fork's current `HEAD`
without fetching or changing Git refs. It reads the `upstream` remote by default; set
`Z_CODE_UPSTREAM_REMOTE` if that remote has a different name. It then synchronizes the version,
AppImage hash, macOS zip hash, upstream source hash, and pnpm closure hash. It refreshes the fixed-output pnpm
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

---

# Original T3 Code README

<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)
