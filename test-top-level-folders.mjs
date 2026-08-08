import assert from "node:assert/strict";

import { buildFileMetadata, buildCrate } from "./src/crate.js";

// main.js no longer supplies a built-in default config — rootDataset now
// comes entirely from the selected profile + Describe form. Stand in with a
// minimal config here since this test calls buildCrate() directly.
const TEST_CONFIG = {
  rootDataset: { "@id": "arcp://name,test-crate", "@type": ["Dataset", "RepositoryCollection"], name: "Test Crate" },
};

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
  const crate = buildCrate(meta, TEST_CONFIG, () => {}, {
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
  const crate = buildCrate(meta, TEST_CONFIG, () => {}, {
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

// When a spreadsheet already describes the entries and what each file belongs
// to, the folder scan must not invent a parallel structure: an object per
// top-level folder would show up in a preview alongside the real entries, and
// claiming every file via isPartOf would beat the described parent to it.
function testStructureFromMetadata() {
  const files = [
    { fileName: "a.pdf", relativePath: "Top/a.pdf" },
    { fileName: "b.pdf", relativePath: "Other/b.pdf" },
  ];
  const meta = buildFileMetadata(files);
  const crate = buildCrate(meta, TEST_CONFIG, () => {}, {
    topLevelFolderType: "object",
    structureFromMetadata: true,
  });
  const graph = crate.getJson()["@graph"];

  assert.equal(
    graph.filter((e) => hasType(e, "RepositoryObject")).length, 0,
    "no folder-derived objects should be invented when metadata describes the structure"
  );
  const root = graph.find((e) => hasType(e, "Dataset"));
  assert.ok(!root["pcdm:hasMember"], "membership should be left for the metadata to supply");

  const fileEntities = graph.filter((e) => hasType(e, "File"));
  assert.equal(fileEntities.length, 2, "the files themselves are still described — only the invented parents go");
  assert.ok(
    fileEntities.every((f) => !f.isPartOf),
    "files should be left unattached, so the spreadsheet's isPartOf lands cleanly"
  );
}

function run() {
  testObjectMode();
  testCollectionMode();
  testStructureFromMetadata();
  console.log("test-top-level-folders: all tests passed");
}

run();