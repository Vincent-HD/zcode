#!/usr/bin/env bash
# Writes the fork's translations (apps/web/src/zcode/translations.json) into the web catalogs.
# Run after `vp run i18n:generate` in apps/web, which adds fork keys with their English text.
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module - <<'JS'
import * as NodeFS from "node:fs";

const catalogs = "apps/web/src/i18n/translations";
const readJson = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const english = readJson(`${catalogs}/en.json`);
const forkTranslations = readJson("apps/web/src/zcode/translations.json");

let stale = 0;
for (const [locale, entries] of Object.entries(forkTranslations)) {
  const file = `${catalogs}/${locale}.json`;
  const catalog = readJson(file);
  for (const [key, value] of Object.entries(entries)) {
    if (Object.hasOwn(english, key)) catalog[key] = value;
    else stale += 1;
  }
  NodeFS.writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);
}
if (stale > 0) console.warn(`${stale} fork translations name keys no longer in en.json; remove them.`);
console.log(`Merged fork translations into ${Object.keys(forkTranslations).length} catalogs.`);
JS
