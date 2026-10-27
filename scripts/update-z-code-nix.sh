#!/usr/bin/env bash
set -Eeuo pipefail

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s [--dry-run] <upstream-version>\n' "$0" >&2
  exit 2
fi

version="${1#v}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  printf 'Invalid upstream version: %s\n' "$1" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

default_file="nix/default.nix"
if [[ ! -f "$default_file" ]]; then
  printf 'Missing %s; run this updater from the Z Code fork checkout.\n' "$default_file" >&2
  exit 1
fi

upstream_remote="${Z_CODE_UPSTREAM_REMOTE:-upstream}"
untracked_files="$(git ls-files --others --exclude-standard)"
if [[ -n "$untracked_files" ]]; then
  printf 'Cannot update pins while this Git-flake source has untracked files. Git flakes omit untracked files; add the intended source files to the index, then rerun.\n' >&2
  printf '%s\n' "$untracked_files" >&2
  exit 1
fi

remote_url="$(git remote get-url "$upstream_remote" 2>/dev/null || true)"
if [[ -z "$remote_url" ]]; then
  printf 'Cannot verify upstream tag v%s: Git remote %s is not configured. Add the pingdotgg/t3code upstream remote or set Z_CODE_UPSTREAM_REMOTE to its configured name.\n' \
    "$version" "$upstream_remote" >&2
  exit 1
fi

tag_ref="refs/tags/v${version}"
printf "Checking that upstream v%s is in this fork's history...\n" "$version"
tag_listing="$(git ls-remote --tags --exit-code "$remote_url" "$tag_ref" "${tag_ref}^{}" 2>&1)" || {
  printf 'Cannot read upstream tag v%s from remote %s. Check the remote and network, then retry.\n' \
    "$version" "$upstream_remote" >&2
  printf '%s\n' "$tag_listing" >&2
  exit 1
}
tag_commit="$(printf '%s\n' "$tag_listing" | awk -v tag="$tag_ref" '
  $2 == tag "^{}" { peeled = $1 }
  $2 == tag { direct = $1 }
  END {
    if (peeled != "") print peeled
    else if (direct != "") print direct
  }
')"
if [[ ! "$tag_commit" =~ ^[[:xdigit:]]{40,64}$ ]]; then
  printf 'Cannot identify the commit for upstream tag v%s from remote %s. Confirm the tag exists and retry.\n' \
    "$version" "$upstream_remote" >&2
  exit 1
fi

if ! git cat-file -e "${tag_commit}^{commit}" 2>/dev/null; then
  printf 'Cannot prove upstream v%s is an ancestor of this fork: tag commit %s is not present in the local Git history. Fetch/rebase the fork onto v%s, then rerun. This check does not fetch or change Git refs.\n' \
    "$version" "$tag_commit" "$version" >&2
  exit 1
fi

if git merge-base --is-ancestor "$tag_commit" HEAD; then
  head_commit="$(git rev-parse HEAD)"
  printf 'Upstream v%s ancestry check passed: %s is an ancestor of HEAD %s. No Git refs were changed.\n' \
    "$version" "$tag_commit" "$head_commit"
else
  status=$?
  if (( status == 1 )); then
    printf "Cannot update pins for upstream v%s: its tag commit %s is not an ancestor of this fork's HEAD. Rebase the fork onto that upstream release, preserving its changes, then rerun.\n" \
      "$version" "$tag_commit" >&2
  else
    printf "Could not compare upstream v%s with this fork's HEAD (git merge-base exited %s). Confirm this checkout has a valid HEAD, then retry.\n" \
      "$version" "$status" >&2
  fi
  exit 1
fi

app_image_url="https://github.com/pingdotgg/t3code/releases/download/v${version}/T3-Code-${version}-x86_64.AppImage"
upstream_source_url="https://github.com/pingdotgg/t3code/archive/refs/tags/v${version}.tar.gz"

printf 'Prefetching upstream v%s AppImage...\n' "$version"
app_image_json="$(nix store prefetch-file --json "$app_image_url")"
app_image_hash="$(printf '%s' "$app_image_json" | node --input-type=module -e '
  import fs from "node:fs";
  const result = JSON.parse(fs.readFileSync(0, "utf8"));
  if (typeof result.hash !== "string") throw new Error("Nix did not return an AppImage hash.");
  process.stdout.write(result.hash);
')"

printf 'Prefetching upstream v%s source tag...\n' "$version"
source_prefetch="$(nix-prefetch-url --unpack --type sha256 --print-path "$upstream_source_url")"
source_hash_nix32="$(printf '%s\n' "$source_prefetch" | sed -n '1p')"
upstream_source_path="$(printf '%s\n' "$source_prefetch" | sed -n '2p')"
if [[ -z "$source_hash_nix32" || -z "$upstream_source_path" ]]; then
  printf 'Could not read the upstream source hash and store path from nix-prefetch-url.\n' >&2
  exit 1
fi
upstream_source_hash="$(nix hash convert --hash-algo sha256 --from nix32 --to sri "$source_hash_nix32")"

printf 'Checking this fork against the selected upstream source before changing pins...\n'
node nix/verify-upstream-dependencies.mjs "$repo_root" "$upstream_source_path" "$version" working-checkout

backup_file="$(mktemp)"
build_log="$(mktemp)"
cp -p "$default_file" "$backup_file"
restore_file=1
cleanup() {
  local status=$?
  trap - EXIT
  if (( restore_file )); then
    cp -p "$backup_file" "$default_file"
  fi
  rm -f "$backup_file" "$build_log"
  exit "$status"
}
trap cleanup EXIT

set_pin() {
  local key="$1"
  local value="$2"
  Z_CODE_NIX_PIN_KEY="$key" Z_CODE_NIX_PIN_VALUE="$value" node --input-type=module -e '
    import fs from "node:fs";

    const file = "nix/default.nix";
    const source = fs.readFileSync(file, "utf8");
    const key = process.env.Z_CODE_NIX_PIN_KEY;
    const value = process.env.Z_CODE_NIX_PIN_VALUE;
    const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"]*";`, "gm");
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`Expected exactly one ${key} pin in ${file}, found ${matches.length}.`);
    const updated = source.replace(pattern, (_match, prefix) => `${prefix}"${value}";`);
    fs.writeFileSync(file, updated);
  '
}

set_pin version "$version"
set_pin appImageHash "$app_image_hash"
set_pin upstreamSourceHash "$upstream_source_hash"
set_pin pnpmDepsHash "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

printf 'Validating the selected release source and deriving its pnpm closure hash...\n'
nix build '.#z-code.passthru.rendererServer.upstreamCompatibilityCheck' --no-link

if NIX_COLOR=never nix build '.#z-code.passthru.rendererServer.pnpmDeps' --no-link >"$build_log" 2>&1; then
  printf 'The temporary pnpm hash unexpectedly matched; inspect the updater before applying pins.\n' >&2
  cat "$build_log" >&2
  exit 1
fi

pnpm_deps_hash="$(sed -nE 's/.*got:[[:space:]]*(sha256-[A-Za-z0-9+/=]+).*/\1/p' "$build_log" | tail -n 1)"
if [[ -z "$pnpm_deps_hash" ]]; then
  printf 'Could not derive pnpmDepsHash from the expected fixed-output hash mismatch. Build output:\n' >&2
  cat "$build_log" >&2
  exit 1
fi
set_pin pnpmDepsHash "$pnpm_deps_hash"

printf '\nPins for upstream v%s:\n' "$version"
printf '  appImageHash = "%s";\n' "$app_image_hash"
printf '  upstreamSourceHash = "%s";\n' "$upstream_source_hash"
printf '  pnpmDepsHash = "%s";\n' "$pnpm_deps_hash"
printf 'The fixed-output pnpm closure was refreshed. The complete package build is a separate optional user check documented in README.md.\n'

if (( dry_run )); then
  printf 'Dry run complete; %s has been restored.\n' "$default_file"
else
  restore_file=0
  printf 'Updated %s. Review the diff; no source rebase or Git commit was performed.\n' "$default_file"
fi
