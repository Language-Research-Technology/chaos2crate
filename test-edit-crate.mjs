// Node test of the Edit view's data path: load an existing crate JSON into a
// live ROCrate instance, mutate it the same way the browser UI does
// (setProperty / deleteProperty / addEntity / deleteEntity / updateEntityId),
// then confirm JSON/xlsx/html regeneration still works against the real libs.
import fs from "fs";
import {
  buildFileMetadata, buildCrate, crateToJsonString, crateToXlsxBytes, crateToPreviewHtml, loadCrateFromJson,
} from "./src/crate.js";
import { DEFAULT_CONFIG, DEFAULT_SAMPLE_DATA } from "./src/defaults.js";

const files = [
  { fileName: "dyirbal-dictionary.pdf", relativePath: "Dyirbal/dyirbal-dictionary.pdf" },
  { fileName: "wordlist.csv", relativePath: "Dyirbal/lists/wordlist.csv" },
];
const meta = buildFileMetadata(files);
const built = buildCrate(meta, DEFAULT_CONFIG, DEFAULT_SAMPLE_DATA, null, () => {});
const originalJson = JSON.parse(crateToJsonString(built));

console.log("=== load existing crate JSON for editing ===");
const crate = loadCrateFromJson(originalJson);
console.log("rootId:", crate.rootId, "| graph entities:", crate.graph.length);

console.log("\n=== edit an existing File entity ===");
const fileId = "Dyirbal/dyirbal-dictionary.pdf";
if (!crate.hasEntity(fileId)) throw new Error("expected file entity missing");
crate.setProperty(fileId, "description", "A dictionary of Dyirbal.");
crate.setProperty(fileId, "custom:participant", ["Jane Smith", "John Doe"]);
const fileEntity = crate.getEntity(fileId);
console.log("description:", fileEntity.description, "| participant:", JSON.stringify(fileEntity["custom:participant"]));

console.log("\n=== add a new Person entity and reference it ===");
const personId = "#person-jane-smith";
crate.addEntity({ "@id": personId, "@type": "Person", name: "Jane Smith" });
crate.setProperty(fileId, "creator", { "@id": personId });
console.log("creator resolves to:", crate.getEntity(fileId).creator[0].name);

console.log("\n=== rename a non-structural entity id ===");
const renamed = crate.updateEntityId(personId, "#person-jane-s");
console.log("rename ok:", renamed, "| creator ref follows rename:", crate.getEntity(fileId).creator[0]["@id"]);

console.log("\n=== delete a property, then delete the entity (with reference cleanup) ===");
crate.deleteProperty(fileId, "custom:participant");
console.log("participant now:", fileEntity["custom:participant"]);
crate.deleteEntity("#person-jane-s", { references: true });
console.log("creator ref after entity delete:", JSON.stringify(crate.getEntity(fileId).creator));

console.log("\n=== regenerate outputs from the edited crate ===");
const json = crateToJsonString(crate);
const obj = JSON.parse(json);
console.log("json bytes:", json.length, "| graph entities:", obj["@graph"].length);
fs.writeFileSync("/tmp/ro-crate-metadata.edited.json", json);

try {
  const xlsx = await crateToXlsxBytes(crate);
  console.log("xlsx bytes:", xlsx.byteLength ?? xlsx.length, "| starts with PK zip magic:", Buffer.from(xlsx).slice(0, 2).toString() === "PK");
} catch (e) {
  console.log("XLSX ERROR:", e.message);
}

try {
  const html = await crateToPreviewHtml(crate);
  console.log("html bytes:", html.length, "| looks like html:", /<html|<!doctype/i.test(html));
  console.log("edited description present in html:", html.includes("A dictionary of Dyirbal."));
} catch (e) {
  console.log("HTML ERROR:", e.message, "\n", e.stack?.split("\n").slice(0, 4).join("\n"));
}

console.log("\nDONE");
