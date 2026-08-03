import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildFileMetadata, buildCrate, crateToJsonString } from "./src/crate.js";
import { mergeXlsxIntoCrate } from "./src/plugins/merge/xlsx.js";
import { DEFAULT_CONFIG } from "./src/defaults.js";

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Files");
sheet.addRow(["@id", ".location"]);
sheet.addRow(["Dyirbal/dyirbal-dictionary.pdf", "Brisbane"]);
const xlsxBytes = await workbook.xlsx.writeBuffer();

const files = [{ fileName: "dyirbal-dictionary.pdf", relativePath: "Dyirbal/dyirbal-dictionary.pdf" }];
const crate = buildCrate(buildFileMetadata(files), DEFAULT_CONFIG, () => {});

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
const fileEntity = graph.find((entity) => entity["@id"] === "Dyirbal/dyirbal-dictionary.pdf");
assert.equal(fileEntity.contentLocation["@id"], "#place-brisbane");

const placeEntity = graph.find((entity) => entity["@id"] === "#place-brisbane");
assert.equal(placeEntity["@type"], "Place");
assert.equal(placeEntity.name, "Brisbane");
assert.deepEqual(placeEntity.geo, { "@id": "#location-brisbane" });

const geometryEntity = graph.find((entity) => entity["@id"] === "#location-brisbane");
assert.equal(geometryEntity["@type"], "Geometry");
assert.equal(geometryEntity[".latitude"], -27.4698);
assert.equal(geometryEntity[".longitude"], 153.0251);
assert.equal(geometryEntity.asWKT, "POINT(153.0251 -27.4698)");

assert.equal(stats.enrichedPlaces, 1);

console.log("place merge lookup test passed");