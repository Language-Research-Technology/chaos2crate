// "Publish subset only" (ro-crate-html-output's publishOnly option) removes
// every collection/object/file under the root that doesn't resolve to
// published, before the crate is handed to crateToPreviewHtml/
// crateToMultiPageHtml. publish:true cascades down from a RepositoryCollection
// to its RepositoryObjects/Files, but an entity's own publish:true/false
// always overrides whatever it inherited — including reviving an object
// nested inside an otherwise-unpublished collection.
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import { filterCrateToPublished } from "c2c-plugins/src/ro-crate-html-output/index.js";

function buildTestCrate() {
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset"];
  crate.addValues(crate.rootDataset, "hasPart", [{ "@id": "#collectionA" }, { "@id": "#collectionB" }]);

  crate.addEntity({
    "@id": "#collectionA", "@type": "RepositoryCollection", name: "Collection A", publish: true,
    hasPart: [{ "@id": "#objectA1" }, { "@id": "#objectA2" }],
  });
  crate.addEntity({ "@id": "#objectA1", "@type": "RepositoryObject", name: "Object A1", hasPart: [{ "@id": "fileA1.txt" }] });
  crate.addEntity({ "@id": "fileA1.txt", "@type": "File", name: "fileA1.txt" });
  // publish:false on an object overrides its collection's inherited publish:true.
  crate.addEntity({ "@id": "#objectA2", "@type": "RepositoryObject", name: "Object A2", publish: false, hasPart: [{ "@id": "fileA2.txt" }] });
  crate.addEntity({ "@id": "fileA2.txt", "@type": "File", name: "fileA2.txt" });

  crate.addEntity({
    "@id": "#collectionB", "@type": "RepositoryCollection", name: "Collection B",
    hasPart: [{ "@id": "#objectB1" }, { "@id": "#objectB2" }],
  });
  // publish:true on an object overrides its (unpublished) collection.
  crate.addEntity({ "@id": "#objectB1", "@type": "RepositoryObject", name: "Object B1", publish: true, hasPart: [{ "@id": "fileB1.txt" }] });
  crate.addEntity({ "@id": "fileB1.txt", "@type": "File", name: "fileB1.txt" });
  crate.addEntity({ "@id": "#objectB2", "@type": "RepositoryObject", name: "Object B2", hasPart: [{ "@id": "fileB2.txt" }] });
  crate.addEntity({ "@id": "fileB2.txt", "@type": "File", name: "fileB2.txt" });

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
  assert.ok(ids.has("#collectionA") && ids.has("#objectA1") && ids.has("fileA1.txt"), "collection A's plain object cascades from the collection's publish:true");
  assert.ok(!ids.has("#objectA2") && !ids.has("fileA2.txt"), "an object's own publish:false overrides an inherited publish:true");

  assert.ok(ids.has("#collectionB"), "collection B survives as a structural shell because it has a published descendant");
  assert.ok(ids.has("#objectB1") && ids.has("fileB1.txt"), "an object's own publish:true overrides its unpublished collection");
  assert.ok(!ids.has("#objectB2") && !ids.has("fileB2.txt"), "an object with no flag, under an unpublished collection, is excluded");

  const collectionA = crate.getEntity("#collectionA");
  assert.deepEqual(collectionA.hasPart.map((p) => p["@id"]), ["#objectA1"], "the removed sibling's hasPart ref is cleaned up, not left dangling");
  const collectionB = crate.getEntity("#collectionB");
  assert.deepEqual(collectionB.hasPart.map((p) => p["@id"]), ["#objectB1"], "same cleanup on the shell collection's hasPart");

  assert.ok(!seen.some(([level]) => level === "warn"), "no warning is logged when some entities do carry a publish flag");
}

{
  // No entity anywhere sets publish — filtering would silently produce an
  // empty preview, so this must be surfaced rather than passing quietly.
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
  assert.ok(seen.some(([level, msg]) => level === "warn" && /no collection or object/.test(msg)), "warns that nothing was marked publish:true");
}

console.log("test-publish-filter: all tests passed (cascade, individual override, shell survival, dangling-ref cleanup, empty-subset warning)");
