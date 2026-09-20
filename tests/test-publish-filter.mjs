// "Publish subset only" (ro-crate-html-output's publishOnly option) removes
// every collection/object/file under the root that doesn't resolve to
// published, before the crate is handed to crateToPreviewHtml/
// crateToMultiPageHtml. custom:publish:true cascades down from a
// RepositoryCollection to its RepositoryObjects/Files, but an entity's own
// custom:publish:true/false always overrides whatever it inherited —
// including reviving an object or file nested inside an otherwise-
// unpublished collection. Namespaced like every other non-standard term
// this codebase adds (custom:participant, custom:compiler, ...) — a
// ro-crate-excel spreadsheet (see xlsx-crate-input) carries this as a
// custom:publish column, typically on the @type=File sheet rather than
// RepositoryObject/Collection.
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import { filterCrateToPublished } from "c2c-plugins/src/ro-crate-html-output/index.js";

function buildTestCrate() {
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset"];
  crate.addValues(crate.rootDataset, "hasPart", [{ "@id": "#collectionA" }, { "@id": "#collectionB" }, { "@id": "#collectionC" }]);

  crate.addEntity({
    "@id": "#collectionA", "@type": "RepositoryCollection", name: "Collection A", "custom:publish": true,
    hasPart: [{ "@id": "#objectA1" }, { "@id": "#objectA2" }],
  });
  crate.addEntity({ "@id": "#objectA1", "@type": "RepositoryObject", name: "Object A1", hasPart: [{ "@id": "fileA1.txt" }] });
  crate.addEntity({ "@id": "fileA1.txt", "@type": "File", name: "fileA1.txt" });
  // custom:publish:false on an object overrides its collection's inherited custom:publish:true.
  crate.addEntity({ "@id": "#objectA2", "@type": "RepositoryObject", name: "Object A2", "custom:publish": false, hasPart: [{ "@id": "fileA2.txt" }] });
  crate.addEntity({ "@id": "fileA2.txt", "@type": "File", name: "fileA2.txt" });

  crate.addEntity({
    "@id": "#collectionB", "@type": "RepositoryCollection", name: "Collection B",
    hasPart: [{ "@id": "#objectB1" }, { "@id": "#objectB2" }],
  });
  // custom:publish:true on an object overrides its (unpublished) collection.
  crate.addEntity({ "@id": "#objectB1", "@type": "RepositoryObject", name: "Object B1", "custom:publish": true, hasPart: [{ "@id": "fileB1.txt" }] });
  crate.addEntity({ "@id": "fileB1.txt", "@type": "File", name: "fileB1.txt" });
  crate.addEntity({ "@id": "#objectB2", "@type": "RepositoryObject", name: "Object B2", hasPart: [{ "@id": "fileB2.txt" }] });
  crate.addEntity({ "@id": "fileB2.txt", "@type": "File", name: "fileB2.txt" });

  // The real-world grain: an ro-crate-excel spreadsheet's custom:publish
  // column lives on the @type=File sheet, not RepositoryObject/Collection —
  // so an unpublished object/collection can still have one published file.
  crate.addEntity({
    "@id": "#collectionC", "@type": "RepositoryCollection", name: "Collection C",
    hasPart: [{ "@id": "#objectC1" }],
  });
  crate.addEntity({ "@id": "#objectC1", "@type": "RepositoryObject", name: "Object C1", hasPart: [{ "@id": "fileC1.txt" }, { "@id": "fileC2.txt" }] });
  crate.addEntity({ "@id": "fileC1.txt", "@type": "File", name: "fileC1.txt", "custom:publish": true });
  crate.addEntity({ "@id": "fileC2.txt", "@type": "File", name: "fileC2.txt" });

  return crate;
}

function idsOf(crate) {
  return new Set(crate.toJSON()["@graph"].map((e) => e["@id"]));
}

{
  const crate = buildTestCrate();
  const seen = [];
  filterCrateToPublished(crate, (msg, level) => seen.push([level, msg]));
  const ids = idsOf(crate);

  assert.ok(ids.has("./"), "root dataset is never removed");
  assert.ok(ids.has("#collectionA") && ids.has("#objectA1") && ids.has("fileA1.txt"), "collection A's plain object cascades from the collection's custom:publish:true");
  assert.ok(!ids.has("#objectA2") && !ids.has("fileA2.txt"), "an object's own custom:publish:false overrides an inherited custom:publish:true");

  assert.ok(ids.has("#collectionB"), "collection B survives as a structural shell because it has a published descendant");
  assert.ok(ids.has("#objectB1") && ids.has("fileB1.txt"), "an object's own custom:publish:true overrides its unpublished collection");
  assert.ok(!ids.has("#objectB2") && !ids.has("fileB2.txt"), "an object with no flag, under an unpublished collection, is excluded");

  assert.ok(ids.has("#collectionC") && ids.has("#objectC1"), "collection C and its object survive as shells for a single published file");
  assert.ok(ids.has("fileC1.txt"), "a File's own custom:publish:true is honoured directly, the real-world grain");
  assert.ok(!ids.has("fileC2.txt"), "its unflagged sibling file, under the same unpublished object, is excluded");

  const collectionA = crate.getEntity("#collectionA");
  assert.deepEqual(collectionA.hasPart.map((p) => p["@id"]), ["#objectA1"], "the removed sibling's hasPart ref is cleaned up, not left dangling");
  const collectionB = crate.getEntity("#collectionB");
  assert.deepEqual(collectionB.hasPart.map((p) => p["@id"]), ["#objectB1"], "same cleanup on the shell collection's hasPart");
  const objectC1 = crate.getEntity("#objectC1");
  assert.deepEqual(objectC1.hasPart.map((p) => p["@id"]), ["fileC1.txt"], "same cleanup at file level under the shell object");

  assert.ok(!seen.some(([level]) => level === "warn"), "no warning is logged when some entities do carry a custom:publish flag");
}

{
  // No entity anywhere sets custom:publish — filtering would silently
  // produce an empty preview, so this must be surfaced rather than passing
  // quietly.
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset"];
  crate.addValues(crate.rootDataset, "hasPart", [{ "@id": "#collectionA" }]);
  crate.addEntity({ "@id": "#collectionA", "@type": "RepositoryCollection", name: "Collection A", hasPart: [{ "@id": "fileA1.txt" }] });
  crate.addEntity({ "@id": "fileA1.txt", "@type": "File", name: "fileA1.txt" });

  const seen = [];
  filterCrateToPublished(crate, (msg, level) => seen.push([level, msg]));
  const ids = idsOf(crate);

  assert.ok(!ids.has("#collectionA") && !ids.has("fileA1.txt"), "nothing is published, so no content entity remains");
  assert.ok(seen.some(([level, msg]) => level === "warn" && /no collection\/object\/file/.test(msg)), "warns that nothing was marked custom:publish:true");
}

console.log("test-publish-filter: all tests passed (cascade, individual override, shell survival at object and file grain, dangling-ref cleanup, empty-subset warning)");
