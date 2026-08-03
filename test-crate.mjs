// Node test of the isomorphic crate pipeline against the real ro-crate libraries.
import fs from "fs";
import { buildFileMetadata, buildCrate, crateToJsonString, crateToXlsxBytes, crateToPreviewHtml } from "./src/crate.js";
import { DEFAULT_CONFIG } from "./src/defaults.js";

// crate.js no longer falls back to a generic layout — pass an explicit one.
const TEST_LAYOUT = [{ name: "Test", inputs: [
  "http://schema.org/name", "http://schema.org/description",
  "http://schema.org/creator", "arcp://name,custom/terms#possibleDuplicate",
  "arcp://name,custom/terms#participant",
] }];

const files = [
  { fileName: "dyirbal-dictionary.pdf", relativePath: "Dyirbal/dyirbal-dictionary.pdf" },
  { fileName: "wordlist.csv", relativePath: "Dyirbal/lists/wordlist.csv" },
  { fileName: "field notes.txt", relativePath: "notes at root.txt" },
  { fileName: "dyirbal-dictionary copy.pdf", relativePath: "Girramay/dyirbal-dictionary copy.pdf" },
];

const meta = buildFileMetadata(files);
const crate = buildCrate(meta, DEFAULT_CONFIG, (m) => console.log("  [log]", m));

console.log("\n=== JSON ===");
const json = crateToJsonString(crate);
const obj = JSON.parse(json);
console.log("json bytes:", json.length, "| graph entities:", obj["@graph"].length);
console.log("types:", obj["@graph"].map((e) => (Array.isArray(e["@type"]) ? e["@type"].join("+") : e["@type"])).join(", "));
console.log("RepositoryObjects:", obj["@graph"].filter((e) => String(e["@type"]).includes("RepositoryObject")).map((e) => e["@id"]));
const f = obj["@graph"].find((e) => e["@id"] === "Dyirbal/dyirbal-dictionary.pdf");
console.log("dup detection on dyirbal-dictionary.pdf:", JSON.stringify(f?.["custom:possibleDuplicate"]));
fs.writeFileSync("/tmp/ro-crate-metadata.json", json);

console.log("\n=== XLSX ===");
try {
  const xlsx = await crateToXlsxBytes(crate);
  const len = xlsx.byteLength ?? xlsx.length;
  console.log("xlsx bytes:", len, "| starts with PK zip magic:", Buffer.from(xlsx).slice(0, 2).toString() === "PK");
  fs.writeFileSync("/tmp/ro-crate-metadata.xlsx", Buffer.from(xlsx));
} catch (e) {
  console.log("XLSX ERROR:", e.message);
}

console.log("\n=== HTML ===");
try {
  const html = await crateToPreviewHtml(crate, { layouts: { default: TEST_LAYOUT } });
  console.log("html bytes:", html.length, "| looks like html:", /<html|<!doctype/i.test(html));
  fs.writeFileSync("/tmp/ro-crate-preview.html", html);
} catch (e) {
  console.log("HTML ERROR:", e.message, "\n", e.stack?.split("\n").slice(0, 4).join("\n"));
}

console.log("\nDONE");
