// The Edit view's data path: load an existing ro-crate-metadata.json into a
// live ROCrate and mutate it exactly as the browser UI does — setProperty,
// deleteProperty, addEntity, updateEntityId, deleteEntity — then confirm the
// edited crate still regenerates all three outputs against the real libraries.
import assert from "node:assert/strict";

import {
  buildFileMetadata, buildCrate, crateToJsonString, crateToXlsxBytes, crateToPreviewHtml, loadCrateFromJson,
} from "../src/crate.js";

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
};

// crate.js no longer falls back to a generic layout — pass an explicit one.
const TEST_LAYOUT = [{ name: "Test", inputs: [
  "http://schema.org/name", "http://schema.org/description",
  "http://schema.org/creator", "arcp://name,custom/terms#possibleDuplicate",
  "arcp://name,custom/terms#participant",
] }];

const files = [
  { fileName: "dyirbal-dictionary.pdf", relativePath: "Dyirbal/dyirbal-dictionary.pdf" },
  { fileName: "wordlist.csv", relativePath: "Dyirbal/lists/wordlist.csv" },
];
const built = buildCrate(buildFileMetadata(files), TEST_CONFIG, () => {});
const originalJson = JSON.parse(crateToJsonString(built));

/* ---------- an existing crate loads into a live, mutable graph ---------- */

const crate = loadCrateFromJson(originalJson);
const fileId = "Dyirbal/dyirbal-dictionary.pdf";

assert.equal(
  crate.rootId,
  TEST_CONFIG.rootDataset["@id"],
  "the loaded crate's root should be the root dataset the JSON declares, not a fresh one"
);
assert.ok(
  crate.hasEntity(fileId),
  "entities from the loaded JSON should be addressable by their @id"
);

/* ---------- editing an existing entity's properties ---------- */

crate.setProperty(fileId, "description", "A dictionary of Dyirbal.");
crate.setProperty(fileId, "custom:participant", ["Jane Smith", "John Doe"]);
const fileEntity = crate.getEntity(fileId);

assert.deepEqual(
  fileEntity.description,
  ["A dictionary of Dyirbal."],
  "setProperty should replace a scalar property's value"
);
assert.deepEqual(
  fileEntity["custom:participant"],
  ["Jane Smith", "John Doe"],
  "setProperty should accept multiple values for one property"
);

/* ---------- adding an entity and referencing it ---------- */

const personId = "#person-jane-smith";
crate.addEntity({ "@id": personId, "@type": "Person", name: "Jane Smith" });
crate.setProperty(fileId, "creator", { "@id": personId });

assert.equal(
  crate.getEntity(fileId).creator[0].name[0],
  "Jane Smith",
  "a reference should resolve to the linked entity, not stay an opaque @id"
);

/* ---------- renaming an id carries its references along ---------- */

assert.ok(
  crate.updateEntityId(personId, "#person-jane-s"),
  "renaming a non-structural entity's @id should succeed"
);
assert.equal(
  crate.getEntity(fileId).creator[0]["@id"],
  "#person-jane-s",
  "every reference to a renamed entity should follow the rename"
);
assert.ok(
  !crate.hasEntity(personId),
  "the old @id should no longer resolve after a rename"
);

/* ---------- deleting a property, then the entity it referenced ---------- */

crate.deleteProperty(fileId, "custom:participant");
assert.equal(
  fileEntity["custom:participant"],
  undefined,
  "deleteProperty should remove the property outright, not blank it"
);

crate.deleteEntity("#person-jane-s", { references: true });
assert.equal(
  crate.getEntity(fileId).creator,
  undefined,
  "deleting an entity with references:true should drop the referring property entirely, leaving no dangling @id"
);
assert.ok(
  !crate.hasEntity("#person-jane-s"),
  "the deleted entity should be gone from the graph"
);

/* ---------- the edited crate still regenerates all three outputs ---------- */

const json = crateToJsonString(crate);
assert.doesNotThrow(() => JSON.parse(json), "the edited crate should still serialise to parseable JSON-LD");

const editedFile = JSON.parse(json)["@graph"].find((e) => e["@id"] === fileId);
// The live graph is array-valued (ROCrate is constructed with array:true), but
// getJson() collapses single-valued properties back to scalars on the way out.
assert.equal(
  editedFile.description,
  "A dictionary of Dyirbal.",
  "edits should survive serialisation, collapsed to a scalar rather than a one-element array"
);

const xlsx = Buffer.from(await crateToXlsxBytes(crate));
assert.ok(xlsx.length > 0, "the edited crate should regenerate a non-empty xlsx");
assert.equal(
  xlsx.subarray(0, 2).toString(),
  "PK",
  "the regenerated xlsx should begin with the PK zip magic"
);

const html = await crateToPreviewHtml(crate, { layouts: { default: TEST_LAYOUT } });
assert.match(html, /<html|<!doctype/i, "the edited crate should regenerate an HTML document");
assert.ok(
  html.includes("A dictionary of Dyirbal."),
  "the edited description should appear in the regenerated preview — this is what Edit-then-save has to produce"
);

console.log(`test-edit-crate: all tests passed (${JSON.parse(json)["@graph"].length} entities after edits, ${xlsx.length} xlsx bytes, ${html.length} html bytes)`);
