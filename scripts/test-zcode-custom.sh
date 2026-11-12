#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

expected_jj_version="jj 0.46.0"
actual_jj_version="$(jj --version)"
if [[
  "$actual_jj_version" != "$expected_jj_version" &&
  "$actual_jj_version" != "$expected_jj_version"-*
]]; then
  printf 'Expected %s, found %s.\n' "$expected_jj_version" "$actual_jj_version" >&2
  exit 1
fi

added_tests=(
  apps/server/src/jj/JjForgeService.test.ts
  apps/server/src/jj/JjPanelService.test.ts
  apps/web/src/components/chat/composer-usage.logic.test.ts
  apps/web/src/components/chat/models-dev-pricing.test.ts
  apps/web/src/components/chat/temporaryConversationDestroy.test.ts
  apps/web/src/components/chat/turn-usage.logic.test.ts
  apps/web/src/components/chat/usage-popover.browser.test.tsx
  apps/web/src/components/chat/usage-pricing.test.ts
  apps/web/src/components/chat/useComposerSend.logic.test.ts
  apps/web/src/components/jj/JjPanel.permissions.browser.test.tsx
  apps/web/src/components/jj/jj-actions.test.ts
  apps/web/src/components/jj/jj-description-draft-store.test.ts
  apps/web/src/components/jj/jj-forge-state.test.ts
  apps/web/src/components/jj/jj-graph-layout.test.ts
  apps/web/src/components/jj/jj-log-state.test.ts
  apps/web/src/components/jj/jj-panel-state.test.ts
  apps/web/src/temporaryConversationNavigation.test.ts
  apps/web/src/zcode/jj-diff-selection.test.ts
  apps/web/src/zcode/right-panel.test.ts
  apps/web/src/zcode/temporary-conversation-send.test.ts
  apps/web/src/zcode/temporary-conversation-store.browser.test.ts
  apps/web/src/zcode/temporary-conversations.test.ts
  apps/web/src/zcode/temporary-header.browser.test.tsx
  apps/web/src/zcode/thread-deletion.test.ts
  packages/client-runtime/src/state/zcode-command-permissions.test.ts
  packages/contracts/src/jj-forge.test.ts
  packages/contracts/src/jj.test.ts
  packages/contracts/src/zcode-environment.test.ts
  packages/provider-cursor/src/server/adapter-turn-usage.test.ts
  packages/provider-cursor/src/server/turn-usage.test.ts
)

tmp_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
fixture_report="$(mktemp "${tmp_dir%/}/zcode-custom-test-fixture.XXXXXX")"
added_tests_report="$(mktemp "${tmp_dir%/}/zcode-custom-added-test-results.XXXXXX")"
trap 'rm -f "$fixture_report" "$added_tests_report"' EXIT

verify_added_tests_report() {
  local report_path="$1"
  shift

  node --input-type=module - "$report_path" "$repo_root" "$@" <<'NODE'
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const [reportPath, repoRoot, ...expectedFiles] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const filePath = (name) => (isAbsolute(name) ? resolve(name) : resolve(repoRoot, name));
const resultsByFile = new Map();
const failures = [];

for (const result of report.testResults ?? []) {
  const path = filePath(result.name);
  const results = resultsByFile.get(path) ?? [];
  results.push(result);
  resultsByFile.set(path, results);
}

for (const expectedFile of expectedFiles) {
  const path = resolve(repoRoot, expectedFile);
  if (!existsSync(path) || !statSync(path).isFile()) {
    failures.push(`${path}: expected added test file is missing`);
  }

  const fileResults = resultsByFile.get(path) ?? [];
  if (fileResults.length !== 1) {
    failures.push(`${path}: expected one Vitest result for this file, found ${fileResults.length}`);
    continue;
  }

  const [fileResult] = fileResults;
  if (fileResult.status !== "passed") {
    failures.push(`${path}: expected the file result to pass, status was ${fileResult.status}`);
  }

  const assertions = Array.isArray(fileResult.assertionResults) ? fileResult.assertionResults : [];
  if (assertions.length === 0) {
    failures.push(`${path}: expected at least one test result, found none`);
    continue;
  }

  for (const assertion of assertions) {
    if (assertion.status !== "passed") {
      failures.push(
        `${path}: expected test ${JSON.stringify(assertion.title)} to run and pass, status was ${assertion.status}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Added test file coverage did not match the Vitest report:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${expectedFiles.length} added test files each ran and passed.`);
}
NODE
}

# Prove a test file that disappears cannot be hidden by other passing added files.
node --input-type=module - "$fixture_report" "$repo_root" <<'NODE'
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [reportPath, repoRoot] = process.argv.slice(2);
writeFileSync(
  reportPath,
  JSON.stringify({
    testResults: [
      {
        name: resolve(repoRoot, "scripts/lib/cached-tests.test.ts"),
        status: "passed",
        assertionResults: [{ title: "surviving fixture case", status: "passed" }],
      },
      {
        name: resolve(repoRoot, "scripts/.test-zcode-custom-absent-fixture.test.ts"),
        status: "passed",
        assertionResults: [{ title: "absent fixture case", status: "passed" }],
      },
    ],
  }),
);
NODE

if fixture_output="$(verify_added_tests_report "$fixture_report" \
  scripts/lib/cached-tests.test.ts \
  scripts/.test-zcode-custom-absent-fixture.test.ts 2>&1)"; then
  printf 'Added test verifier fixture failed to reject an absent expected file.\n' >&2
  exit 1
fi
if [[ "$fixture_output" != *'scripts/.test-zcode-custom-absent-fixture.test.ts: expected added test file is missing'* ]]; then
  printf 'Added test verifier fixture failed for an unexpected reason:\n%s\n' "$fixture_output" >&2
  exit 1
fi
printf 'Added test verifier fixture passed: an absent expected file is rejected.\n'

printf 'Running all tests from %d fork-added Vitest files.\n' "${#added_tests[@]}"
for test_file in "${added_tests[@]}"; do
  if [[ ! -f "$test_file" ]]; then
    printf 'Expected fork-added test file is missing: %s\n' "$test_file" >&2
    exit 1
  fi
done
vp test run --reporter=json --outputFile="$added_tests_report" "${added_tests[@]}"
verify_added_tests_report "$added_tests_report" "${added_tests[@]}"

printf 'Running the fork packaging verifier tests.\n'
node --test nix/verify-upstream-dependencies.test.mjs
