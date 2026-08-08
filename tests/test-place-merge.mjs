import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildFileMetadata, buildCrate, crateToJsonString } from "../src/crate.js";
import { mergeXlsxIntoCrate } from "../src/plugins/merge/xlsx.js";

// main.js no longer supplies a built-in default config — rootDataset now
// comes entirely from the selected profile + Describe form. Stand in with a
// minimal config here since this test calls buildCrate() directly.
const TEST_CONFIG = {
  rootDataset: { "@id": "arcp://name,test-crate", "@type": ["Dataset", "RepositoryCollection"], name: "Test Crate" },
};

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Files");
sheet.addRow(["@id", ".location"]);
sheet.addRow(["Dyirbal/dyirbal-dictionary.pdf", "Brisbane"]);
const xlsxBytes = await workbook.xlsx.writeBuffer();

const files = [{ fileName: "dyirbal-dictionary.pdf", relativePath: "Dyirbal/dyirbal-dictionary.pdf" }];
const crate = buildCrate(buildFileMetadata(files), TEST_CONFIG, () => {});

const stats = await mergeXlsxIntoCrate(crate, xlsxBytes, {
  sheet: "Files",
  mapping: [{ source: ".location", target: "contentLocation", type: "Place" }],
  placeLookup: {
    providers: ["cache"],
    records: {
      Brisbane: { latitude: -27.4698, longitude: 153.0251 },
    },
  },
});

const graph = JSON.parse(crateToJsonString(crate))["@graph"];

/* ---------- a typed mapping turns a cell into a linked entity ---------- */

const fileEntity = graph.find((entity) => entity["@id"] === "Dyirbal/dyirbal-dictionary.pdf");
assert.equal(
  fileEntity.contentLocation["@id"],
  "#place-brisbane",
  "a typed Place mapping should link the file to a generated Place entity, not write the raw cell text"
);

const placeEntity = graph.find((entity) => entity["@id"] === "#place-brisbane");
assert.equal(
  placeEntity["@type"],
  "Place",
  "the generated entity should carry the type the mapping declared"
);
assert.equal(
  placeEntity.name,
  "Brisbane",
  "the generated Place should keep the spreadsheet's cell text as its name"
);

/* ---------- place lookup attaches coordinates via a linked Geometry ---------- */

assert.deepEqual(
  placeEntity.geo,
  { "@id": "#location-brisbane" },
  "a Place resolved by lookup should point at its own Geometry entity via geo"
);

const geometryEntity = graph.find((entity) => entity["@id"] === "#location-brisbane");
assert.equal(
  geometryEntity["@type"],
  "Geometry",
  "the coordinates should live on a typed Geometry entity, not inline on the Place"
);
assert.equal(
  geometryEntity[".latitude"],
  -27.4698,
  "the Geometry should carry the latitude from the matched lookup record"
);
assert.equal(
  geometryEntity[".longitude"],
  153.0251,
  "the Geometry should carry the longitude from the matched lookup record"
);
assert.equal(
  geometryEntity.asWKT,
  "POINT(153.0251 -27.4698)",
  "asWKT should be derived as POINT(longitude latitude) — in that order, which is the easy one to get backwards"
);

assert.equal(
  stats.enrichedPlaces,
  1,
  "the merge should report each place it enriched with coordinates"
);

console.log(`test-place-merge: all tests passed (${stats.merged} value(s) merged, ${stats.generated} entity/ies generated, ${stats.enrichedPlaces} place enriched)`);