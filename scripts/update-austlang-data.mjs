// Regenerate c2c-plugins' src/austlang/austlang-data.json from the
// @describo/data-packs package.
//
// The app does AUSTLANG language identification entirely offline by scanning a
// bundled copy of the Austlang data pack (no network, no CORS, no API key).
// This script refreshes that bundled copy from the installed package.
//
//   npm install            # ensure @describo/data-packs (devDependency) is present
//   npm run update:austlang
//
// Commit the resulting austlang-data.json in the c2c-plugins repo (a sibling
// checkout — see chaos2crate's package.json "c2c-plugins" dependency).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SRC = join(
  root,
  "node_modules/@describo/data-packs/data-packs/languages/austlang-language-data-pack.json"
);
const OUT = join(root, "../c2c-plugins/src/austlang/austlang-data.json");

const raw = JSON.parse(await readFile(SRC, "utf8"));
if (!Array.isArray(raw)) throw new Error("Expected the data pack to be a JSON array");

// Keep only Austlang entries (the pack is Austlang-only, but be defensive) and
// sort by languageCode for stable diffs.
const records = raw
  .filter((r) => r && r.source === "Austlang")
  .sort((a, b) => String(a.languageCode).localeCompare(String(b.languageCode)));

if (!records.length) throw new Error("No Austlang records found — aborting");

await writeFile(OUT, JSON.stringify(records));
console.log(`Wrote ${records.length} Austlang records to ../c2c-plugins/src/austlang/austlang-data.json`);
