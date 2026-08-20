// The core build path, against the real ro-crate libraries: a synthetic file
// list becomes a graph, and that graph serialises to all three outputs.
// Nothing is mocked — a pass here means the libraries actually accept what
// buildCrate() produces.
import assert from "node:assert/strict";

import { buildFileMetadata, buildCrate, crateToJsonString, crateToXlsxBytes, crateToPreviewHtml } from "../src/crate.js";

function typesOf(entity) {
  return [].concat(entity?.["@type"] ?? []);
}
function byId(graph, id) {
  return graph.find((e) => e["@id"] === id);
}

// main.js no longer supplies a built-in default config — rootDataset now
// comes entirely from the selected profile + Describe form. Stand in with a
// minimal config here since this test calls buildCrate() directly.
const TEST_CONFIG = {
  rootDataset: {
    "@id": "arcp://name,test-crate",
    "@type": ["Dataset", "RepositoryCollection"],
    name: "Test Crate",
    description: "A test crate for the chaos2crate test suite.",
    datePublished: "2026-01-01",
  },
  metadataLicence: {
    "@id": "https://creativecommons.org/licenses/by/4.0/",
    "@type": "ldac:DataReuseLicense",
    name: "Attribution 4.0 International (CC BY 4.0)",
  },
  // fileProperties no longer come from a shared defaults.js — the selected
  // profile declares them (see masp-profiles' language-resources tool-config.json).
  fileProperties: [
    { key: "custom:participant", definition: { "@id": "arcp://name,custom/terms#participant", "@type": "rdf:Property", name: "Participant", description: "A participant associated with the file." } },
    { key: "custom:possibleDuplicate", definition: { "@id": "arcp://name,custom/terms#possibleDuplicate", "@type": "rdf:Property", name: "Possible Duplicate", description: "Filename of a possible duplicate." } },
  ],
};

// crate.js no longer falls back to a generic layout — pass an explicit one.
const TEST_LAYOUT = [{ name: "Test", inputs: [
  "http://schema.org/name", "http://schema.org/description",
  "http://schema.org/creator", "arcp://name,custom/terms#possibleDuplicate",
  "arcp://name,custom/terms#participant",
] }];

// Two files here are near-duplicates by name ("dyirbal-dictionary.pdf" and
// "dyirbal-dictionary copy.pdf") in different folders, and one file sits at
// the top level with no folder of its own.
const files = [
  { fileName: "dyirbal-dictionary.pdf", relativePath: "Dyirbal/dyirbal-dictionary.pdf" },
  { fileName: "wordlist.csv", relativePath: "Dyirbal/lists/wordlist.csv" },
  { fileName: "field notes.txt", relativePath: "notes at root.txt" },
  { fileName: "dyirbal-dictionary copy.pdf", relativePath: "Girramay/dyirbal-dictionary copy.pdf" },
];

const meta = buildFileMetadata(files);
const crate = buildCrate(meta, TEST_CONFIG, () => {});
const graph = JSON.parse(crateToJsonString(crate))["@graph"];

/* ---------- every scanned file becomes a File entity keyed by its path ---------- */

const fileEntities = graph.filter((e) => typesOf(e).includes("File"));
assert.equal(fileEntities.length, files.length, "every scanned file should become exactly one File entity");

for (const file of files) {
  assert.ok(
    byId(graph, file.relativePath),
    `File entity for "${file.relativePath}" should be keyed by its relative path`
  );
}

/* ---------- top-level folders become RepositoryObjects, with arcp ids ---------- */

const objectIds = graph.filter((e) => typesOf(e).includes("RepositoryObject")).map((e) => e["@id"]);

assert.deepEqual(
  [...objectIds].sort(),
  [
    "arcp://name,test-crate/Dyirbal",
    "arcp://name,test-crate/Girramay",
    "arcp://name,test-crate/field_notes",
  ],
  "each top-level folder — plus a synthetic object for the file with no folder — should become a RepositoryObject"
);

assert.ok(
  objectIds.every((id) => !id.startsWith("#")),
  "structural hash ids should be rewritten to arcp form on export, leaving no '#' ids behind"
);

const dyirbal = byId(graph, "arcp://name,test-crate/Dyirbal");
assert.deepEqual(
  dyirbal.hasPart.map((r) => r["@id"]).sort(),
  ["Dyirbal/dyirbal-dictionary.pdf", "Dyirbal/lists/wordlist.csv"],
  "a top-level object should list every file beneath it, including files in nested folders"
);

assert.deepEqual(
  byId(graph, "Dyirbal/lists/wordlist.csv").isPartOf,
  { "@id": "arcp://name,test-crate/Dyirbal" },
  "a file in a nested folder should belong to its top-level object in object mode"
);

/* ---------- near-duplicate filenames are cross-linked ---------- */

const original = byId(graph, "Dyirbal/dyirbal-dictionary.pdf");
const copy = byId(graph, "Girramay/dyirbal-dictionary copy.pdf");

assert.deepEqual(
  original["custom:possibleDuplicate"],
  [{ "@id": "Girramay/dyirbal-dictionary copy.pdf" }],
  '"dyirbal-dictionary.pdf" should be flagged as a possible duplicate of the "copy" in another folder'
);
assert.deepEqual(
  copy["custom:possibleDuplicate"],
  [{ "@id": "Dyirbal/dyirbal-dictionary.pdf" }],
  "duplicate detection should be mutual — the copy should point back at the original"
);
assert.equal(
  byId(graph, "Dyirbal/lists/wordlist.csv")["custom:possibleDuplicate"],
  undefined,
  "a file with no name-alike should carry no possibleDuplicate property at all"
);

/* ---------- the profile's declared file properties are applied ---------- */

for (const file of fileEntities) {
  assert.equal(
    file["custom:participant"],
    "",
    `profile-declared "custom:participant" should be blank-initialised on File "${file["@id"]}"`
  );
}

for (const { key, definition } of TEST_CONFIG.fileProperties) {
  assert.ok(
    byId(graph, definition["@id"]),
    `the rdf:Property defining "${key}" should be added to the graph alongside its use`
  );
}

/* ---------- the graph serialises to all three outputs ---------- */

const json = crateToJsonString(crate);
assert.doesNotThrow(() => JSON.parse(json), "the JSON output should be parseable JSON-LD");
assert.ok(
  JSON.parse(json)["@context"],
  "the JSON output should carry an @context, without which no term resolves"
);

const xlsx = await crateToXlsxBytes(crate);
const xlsxBytes = Buffer.from(xlsx);
assert.ok(xlsxBytes.length > 0, "the xlsx output should not be empty");
assert.equal(
  xlsxBytes.subarray(0, 2).toString(),
  "PK",
  "the xlsx output should begin with the PK zip magic — an .xlsx is a zip archive"
);

const html = await crateToPreviewHtml(crate, { layouts: { default: TEST_LAYOUT } });
assert.match(html, /<html|<!doctype/i, "the preview should be an HTML document");
assert.ok(
  html.includes("Test Crate"),
  "the preview should show the crate's name from the root dataset"
);

await assert.rejects(
  () => crateToPreviewHtml(crate, { layouts: { default: [] } }),
  /selected profile.*propertyGroups|opts\.layouts\.default.*required/i,
  "empty layouts.default should report the active profile/layout cause clearly"
);

console.log(`test-crate: all tests passed (${fileEntities.length} files, ${objectIds.length} objects, ${graph.length} entities, ${xlsxBytes.length} xlsx bytes, ${html.length} html bytes)`);
