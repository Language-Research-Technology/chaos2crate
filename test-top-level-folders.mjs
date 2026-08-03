import assert from "node:assert/strict";

import { buildFileMetadata, buildCrate } from "./src/crate.js";
import { DEFAULT_CONFIG } from "./src/defaults.js";

function asTypes(entity) {
  if (!entity) return [];
  return Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]];
}

function hasType(entity, type) {
  return asTypes(entity).includes(type);
}

function getById(graph, id) {
  return graph.find((e) => e["@id"] === id);
}

function getByNameAndType(graph, name, type) {
  return graph.find((e) => e.name === name && hasType(e, type));
}

function testObjectMode() {
  const files = [
    { fileName: "a.pdf", relativePath: "Top/a.pdf" },
    { fileName: "b.pdf", relativePath: "Top/sub/b.pdf" },
  ];
  const meta = buildFileMetadata(files);
  const crate = buildCrate(meta, DEFAULT_CONFIG, null, () => {}, {
    topLevelFolderType: "object",
  });
  const graph = crate.getJson()["@graph"];

  const top = getByNameAndType(graph, "Top", "RepositoryObject");
  assert.ok(top, "Top-level folder should be a RepositoryObject in object mode");
  assert.ok(
    Array.isArray(top.hasPart) && top.hasPart.some((r) => r["@id"] === "Top/a.pdf") && top.hasPart.some((r) => r["@id"] === "Top/sub/b.pdf"),
    "Top-level object should include all files in hasPart"
  );

  const fileA = getById(graph, "Top/a.pdf");
  const fileB = getById(graph, "Top/sub/b.pdf");
  assert.deepEqual(fileA.isPartOf, { "@id": top["@id"] }, "Top/a.pdf should be part of top-level object in object mode");
  assert.deepEqual(fileB.isPartOf, { "@id": top["@id"] }, "Top/sub/b.pdf should be part of top-level object in object mode");
}

function testCollectionMode() {
  const files = [
    { fileName: "a.pdf", relativePath: "Top/a.pdf" },
    { fileName: "b.pdf", relativePath: "Top/sub/b.pdf" },
    { fileName: "c.pdf", relativePath: "Top/sub/c.pdf" },
  ];
  const meta = buildFileMetadata(files);
  const crate = buildCrate(meta, DEFAULT_CONFIG, null, () => {}, {
    topLevelFolderType: "collection",
  });
  const graph = crate.getJson()["@graph"];

  const top = getByNameAndType(graph, "Top", "RepositoryCollection");
  assert.ok(top, "Top-level folder should be a RepositoryCollection in collection mode");

  const filesObj = getByNameAndType(graph, "Top_Files", "RepositoryObject");
  const subObj = getByNameAndType(graph, "sub", "RepositoryObject");
  assert.ok(filesObj, "Collection mode should create a named direct-files RepositoryObject for top-level files");
  assert.ok(subObj, "Collection mode should create a RepositoryObject for nested folder");

  assert.ok(
    Array.isArray(top["pcdm:hasMember"])
      && top["pcdm:hasMember"].some((r) => r["@id"] === filesObj["@id"])
      && top["pcdm:hasMember"].some((r) => r["@id"] === subObj["@id"]),
    "Top-level collection should use pcdm:hasMember for child objects"
  );
  assert.deepEqual(
    subObj["pcdm:memberOf"],
    { "@id": top["@id"] },
    "Nested folder object should be linked back to top-level collection via pcdm:memberOf"
  );
  assert.deepEqual(
    filesObj["pcdm:memberOf"],
    { "@id": top["@id"] },
    "Files object should be linked back to top-level collection via pcdm:memberOf"
  );

  assert.deepEqual(
    filesObj.hasPart,
    [{ "@id": "Top/a.pdf" }],
    "Files object should contain direct files from the top-level folder"
  );
  assert.deepEqual(
    subObj.hasPart,
    [{ "@id": "Top/sub/b.pdf" }, { "@id": "Top/sub/c.pdf" }],
    "Nested folder object should contain its files"
  );

  const fileA = getById(graph, "Top/a.pdf");
  const fileB = getById(graph, "Top/sub/b.pdf");
  assert.deepEqual(fileA.isPartOf, { "@id": filesObj["@id"] }, "Top/a.pdf should point to Files object in collection mode");
  assert.deepEqual(fileB.isPartOf, { "@id": subObj["@id"] }, "Top/sub/b.pdf should point to nested folder object in collection mode");
}

function run() {
  testObjectMode();
  testCollectionMode();
  console.log("test-top-level-folders: all tests passed");
}

run();