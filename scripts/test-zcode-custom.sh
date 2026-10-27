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
  apps/web/src/components/chat/chatViewSend.temporary.test.ts
  apps/web/src/components/chat/composer-usage.logic.test.ts
  apps/web/src/components/chat/models-dev-pricing.test.ts
  apps/web/src/components/chat/turn-usage.logic.test.ts
  apps/web/src/components/chat/usage-popover.test.tsx
  apps/web/src/components/chat/usage-pricing.test.ts
  apps/web/src/components/jj/jj-description-draft-store.test.ts
  apps/web/src/components/jj/jj-forge-state.test.ts
  apps/web/src/components/jj/jj-panel-state.test.ts
  apps/web/src/temporaryConversationNavigation.test.ts
  packages/contracts/src/jj-forge.test.ts
  packages/contracts/src/jj.test.ts
  packages/provider-cursor/src/server/turn-usage.test.ts
)

modified_tests=(
  apps/web/src/components/RightPanelTabs.test.tsx
  apps/web/src/components/threadActionMenu.logic.test.ts
  apps/web/src/confirmDialog.test.ts
  apps/web/src/diffPanelStore.test.ts
  apps/web/src/hooks/useThreadActions.permissions.test.ts
  apps/web/src/reopenClosedView.test.ts
  apps/web/src/rightPanelStore.test.ts
  apps/web/src/uiStateStore.test.ts
  packages/client-runtime/src/state/commandPermissions.test.ts
  packages/contracts/src/environment.test.ts
  packages/provider-cursor/src/server/adapter.test.ts
)

additional_custom_tests=(
  apps/web/src/composer-logic.test.ts
  apps/web/src/threadRoutes.test.ts
  apps/web/src/components/TemporaryConversationCoordinator.browser.test.tsx
  apps/web/src/components/chat/useComposerSend.logic.test.ts
)

expected_test_cases=(
  'apps/web/src/components/RightPanelTabs.test.tsx|opens an available Jujutsu launcher from J'
  'apps/web/src/components/threadActionMenu.logic.test.ts|shows the reversible temporary conversation action without server permission'
  'apps/web/src/confirmDialog.test.ts|serializes concurrent confirmations'
  'apps/web/src/confirmDialog.test.ts|uses action-specific button labels when requested'
  'apps/web/src/diffPanelStore.test.ts|selects a JJ file with the displayed workspace and operation'
  'apps/web/src/diffPanelStore.test.ts|restores the branch base and clears JJ identity when switching to Git'
  "apps/web/src/diffPanelStore.test.ts|requests a new reveal for repeated JJ clicks and another revision's file"
  'apps/web/src/diffPanelStore.test.ts|keeps JJ operations and reveals isolated across environments and threads'
  'apps/web/src/diffPanelStore.test.ts|does not replace a JJ selection when checkpoint turns are reconciled'
  'apps/web/src/diffPanelStore.test.ts|never carries a previous JJ operation into a new unpinned selection'
  'apps/web/src/diffPanelStore.test.ts|rehydrates the JJ revision, file, operation, and saved branch base'
  "apps/web/src/hooks/useThreadActions.permissions.test.ts|deletes an archived thread only with its own environment's grant"
  'apps/web/src/hooks/useThreadActions.permissions.test.ts|deletes a worktree thread and keeps its worktree without source-control permission'
  'apps/web/src/hooks/useThreadActions.permissions.test.ts|deletes a worktree thread and keeps its worktree when the permission lookup fails'
  'apps/web/src/hooks/useThreadActions.permissions.test.ts|deletes a temporary thread without navigating to a fallback or removing its worktree'
  'apps/web/src/reopenClosedView.test.ts|does not reopen workspace tabs without an available project'
  'apps/web/src/rightPanelStore.test.ts|keeps Jujutsu singleton, restores it, and scopes it to its thread'
  'apps/web/src/uiStateStore.test.ts|keeps the temporary marker on the scoped thread key across promotion routes'
  'apps/web/src/uiStateStore.test.ts|moves a temporary marker when promotion changes its scoped thread ref'
  'apps/web/src/uiStateStore.test.ts|moves temporary markers from bootstrap aliases through repeated retry ids'
  'apps/web/src/uiStateStore.test.ts|hydrates raw UI-owned state without server entities'
  'apps/web/src/uiStateStore.test.ts|ignores changed-file expansion version undefined'
  'apps/web/src/uiStateStore.test.ts|ignores changed-file expansion version 1'
  'apps/web/src/uiStateStore.test.ts|persists raw UI preferences including thread visit markers'
  'packages/client-runtime/src/state/commandPermissions.test.ts|requires the destination source-control grant for every Jujutsu rewrite'
  'packages/client-runtime/src/state/commandPermissions.test.ts|requires the destination filesystem grant for Jujutsu diff reads'
  'packages/contracts/src/environment.test.ts|requires an advertised Jujutsu panel capability under version skew'
  'packages/contracts/src/environment.test.ts|advertises expanded Jujutsu actions, diff and publication independently from panel reads'
  'packages/provider-cursor/src/server/adapter.test.ts|projects Cursor tasks: finished, late model undefined, missing usage false'
  'packages/provider-cursor/src/server/adapter.test.ts|projects Cursor tasks: cancelled, late model undefined, missing usage false'
  'packages/provider-cursor/src/server/adapter.test.ts|projects Cursor tasks: error, late model undefined, missing usage false'
  'packages/provider-cursor/src/server/adapter.test.ts|projects Cursor tasks: finished, late model gpt-6-sol, missing usage false'
  'packages/provider-cursor/src/server/adapter.test.ts|projects Cursor tasks: finished, late model null, missing usage false'
  'packages/provider-cursor/src/server/adapter.test.ts|projects Cursor tasks: finished, late model undefined, missing usage true'
  'apps/web/src/composer-logic.test.ts|disables background send shortcuts for temporary drafts and threads'
  'apps/web/src/threadRoutes.test.ts|confirms a background draft only after its returned draft route is active'
  'apps/web/src/components/TemporaryConversationCoordinator.browser.test.tsx|mounts the navigation guard for hosted-static routes'
  'apps/web/src/components/TemporaryConversationCoordinator.browser.test.tsx|does not mount the guard on guest routes'
  'apps/web/src/components/chat/useComposerSend.logic.test.ts|keeps the marker on successive bootstrap retries and blocks background dispatch'
)

tmp_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
selection_report="$(mktemp "${tmp_dir%/}/zcode-custom-test-results.XXXXXX")"
fixture_report="$(mktemp "${tmp_dir%/}/zcode-custom-test-fixture.XXXXXX")"
added_tests_report="$(mktemp "${tmp_dir%/}/zcode-custom-added-test-results.XXXXXX")"
trap 'rm -f "$selection_report" "$fixture_report" "$added_tests_report"' EXIT

test_name_pattern="$(node - "${expected_test_cases[@]}" <<'NODE'
const titles = process.argv.slice(2).map((testCase) => {
  const delimiter = testCase.indexOf("|");
  return testCase.slice(delimiter + 1);
});
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
process.stdout.write(titles.map((title) => `(?:^|\\s)${escapeRegExp(title)}$`).join("|"));
NODE
)"

verify_selection_report() {
  local report_path="$1"
  shift

  node --input-type=module - "$report_path" "$repo_root" "$@" <<'NODE'
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const [reportPath, repoRoot, ...testCases] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const filePath = (name) => (isAbsolute(name) ? resolve(name) : resolve(repoRoot, name));
const resultsByFile = new Map();
const expectedByFile = new Map();
const failures = [];

for (const result of report.testResults ?? []) {
  const path = filePath(result.name);
  const results = resultsByFile.get(path) ?? [];
  results.push(result);
  resultsByFile.set(path, results);
}

for (const testCase of testCases) {
  const delimiter = testCase.indexOf("|");
  if (delimiter < 1) {
    failures.push(`Invalid expected test case entry: ${testCase}`);
    continue;
  }
  const path = resolve(repoRoot, testCase.slice(0, delimiter));
  const title = testCase.slice(delimiter + 1);
  const titles = expectedByFile.get(path) ?? [];
  titles.push(title);
  expectedByFile.set(path, titles);
}

for (const [path, expectedTitles] of expectedByFile) {
  const fileResults = resultsByFile.get(path) ?? [];
  if (fileResults.length !== 1) {
    failures.push(
      `${path}: expected one Vitest result for this file, found ${fileResults.length}`,
    );
    continue;
  }

  const assertions = fileResults[0].assertionResults ?? [];
  const expectedTitleCounts = new Map();

  for (const title of expectedTitles) {
    expectedTitleCounts.set(title, (expectedTitleCounts.get(title) ?? 0) + 1);
    const matching = assertions.filter((assertion) => assertion.title === title);
    if (matching.length !== 1) {
      failures.push(
        `${path}: expected case ${JSON.stringify(title)} exactly once, found ${matching.length}`,
      );
      continue;
    }
    if (matching[0].status !== "passed") {
      failures.push(
        `${path}: expected case ${JSON.stringify(title)} to run and pass, status was ${matching[0].status}`,
      );
    }
  }

  const unexpected = assertions.filter(
    (assertion) =>
      assertion.status !== "skipped" && !expectedTitleCounts.has(assertion.title),
  );
  for (const assertion of unexpected) {
    failures.push(
      `${path}: unexpected selected case ${JSON.stringify(assertion.title)} (${assertion.status})`,
    );
  }

  const selectedCount = assertions.filter((assertion) => assertion.status !== "skipped").length;
  if (selectedCount !== expectedTitles.length) {
    failures.push(
      `${path}: expected ${expectedTitles.length} selected cases, found ${selectedCount}`,
    );
  }
}

if (failures.length > 0) {
  console.error("Focused test selection did not match the expected per-file cases:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${testCases.length} selected cases across ${expectedByFile.size} files.`,
  );
}
NODE
}

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

# Prove a surviving case cannot hide an expected title that was removed or renamed.
node --input-type=module - "$fixture_report" "$repo_root" <<'NODE'
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [reportPath, repoRoot] = process.argv.slice(2);
const fixtureFile = "scripts/.test-zcode-custom-selection-fixture.test.ts";
writeFileSync(
  reportPath,
  JSON.stringify({
    testResults: [
      {
        name: resolve(repoRoot, fixtureFile),
        assertionResults: [
          { title: "case that remains", status: "passed" },
          { title: "expected case after rename", status: "passed" },
          { title: "parameterized row: one", status: "passed" },
          { title: "parameterized row: two renamed", status: "passed" },
        ],
      },
    ],
  }),
);
NODE

if fixture_output="$(verify_selection_report "$fixture_report" \
  'scripts/.test-zcode-custom-selection-fixture.test.ts|case that remains' \
  'scripts/.test-zcode-custom-selection-fixture.test.ts|expected case before rename' \
  'scripts/.test-zcode-custom-selection-fixture.test.ts|parameterized row: one' \
  'scripts/.test-zcode-custom-selection-fixture.test.ts|parameterized row: two' 2>&1)"; then
  printf 'Selection verifier fixture failed to reject a missing or renamed expected case.\n' >&2
  exit 1
fi
if [[
  "$fixture_output" != *'expected case before rename'* ||
  "$fixture_output" != *'parameterized row: two'*
]]; then
  printf 'Selection verifier fixture failed for an unexpected reason:\n%s\n' "$fixture_output" >&2
  exit 1
fi
printf 'Selection verifier fixture passed: missing and renamed cases are rejected.\n'

printf 'Running all tests from %d fork-added Vitest files.\n' "${#added_tests[@]}"
for test_file in "${added_tests[@]}"; do
  if [[ ! -f "$test_file" ]]; then
    printf 'Expected fork-added test file is missing: %s\n' "$test_file" >&2
    exit 1
  fi
done
vp test run --reporter=json --outputFile="$added_tests_report" "${added_tests[@]}"
verify_added_tests_report "$added_tests_report" "${added_tests[@]}"

# Exact title selection includes each expected parameterized row individually.
printf 'Running %d selected cases from %d inventory files and %d current custom files.\n' \
  "${#expected_test_cases[@]}" \
  "${#modified_tests[@]}" "${#additional_custom_tests[@]}"
vp test run --testNamePattern "$test_name_pattern" \
  --reporter=json --outputFile="$selection_report" \
  "${modified_tests[@]}" "${additional_custom_tests[@]}"
verify_selection_report "$selection_report" "${expected_test_cases[@]}"

printf 'Running the fork packaging verifier tests.\n'
node --test nix/verify-upstream-dependencies.test.mjs
