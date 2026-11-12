#!/usr/bin/env bash
# Upstream workflows stay byte-identical in the fork; they are disabled in the GitHub repository
# instead. Rerun after every rebase: workflows added upstream arrive enabled.
set -euo pipefail

repo="${Z_CODE_REPO:-Vincent-HD/zcode}"
keep="zcode-custom-tests.yml"

gh api --paginate "repos/$repo/actions/workflows" --jq '.workflows[] | [.id, .path, .state] | @tsv' |
  while IFS=$'\t' read -r id path state; do
    [[ "$(basename "$path")" == "$keep" ]] && continue
    [[ "$state" == "active" ]] || continue
    gh workflow disable "$id" -R "$repo"
    echo "disabled $path"
  done
