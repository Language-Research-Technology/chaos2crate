// xlsx-crate-input: reading a crate out of a spreadsheet, choosing which of a
// folder's metadata files to prefill from, and folding one crate into another.
//
// The plugin's hook handlers aren't exercised here — they need a real
// FileSystemDirectoryHandle and the DOM. Everything they delegate to lives in
// xlsx_crate.js and is plain data-in/data-out, which is what this covers.
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROCrate } from "ro-crate";
import {
  PREFILL_SOURCES,
  pickNewestCrateSource,
  readCrateJsonFromSource,
  readCrateFromXlsxBytes,
  rootPropertiesFromCrate,
  seedRootDataset,
  mergeCrateEntities,
  applyCollectionMembership,
  collectWarnings,
} from "../src/plugins/xlsx-crate-input/xlsx_crate.js";

/* ---------- a fake directory handle over an in-memory file map ---------- */
// Stands in for the File System Access API: statFile() only needs
// getFileHandle().getFile(), and File is available in Node 20+.
function fakeDirHandle(files) {
  return {
    async getFileHandle(name) {
      if (!(name in files)) {
        const err = new Error(`${name} not found`);
        err.name = "NotFoundError";
        throw err;
      }
      const { bytes, lastModified } = files[name];
      return { async getFile() { return new File([bytes], name, { lastModified }); } };
    },
  };
}

const crateJsonBytes = (root) => Buffer.from(JSON.stringify({
  "@context": "https://w3id.org/ro/crate/1.2/context",
  "@graph": [
    { "@id": "ro-crate-metadata.json", "@type": "CreativeWork", about: { "@id": "./" } },
    { "@id": "./", "@type": "Dataset", ...root },
  ],
}));

/* ---------- newest source wins ---------- */

{
  const handle = fakeDirHandle({
    "additional-ro-crate-metadata.xlsx": { bytes: Buffer.from("x"), lastModified: 1000 },
    "ro-crate-metadata.json": { bytes: crateJsonBytes({ name: "J" }), lastModified: 2000 },
  });
  const picked = await pickNewestCrateSource(handle);
  assert.equal(picked.name, "ro-crate-metadata.json", "the newer JSON should win over an older spreadsheet");
  assert.equal(picked.kind, "json");
}

{
  const handle = fakeDirHandle({
    "additional-ro-crate-metadata.xlsx": { bytes: Buffer.from("x"), lastModified: 3000 },
    "ro-crate-metadata.json": { bytes: crateJsonBytes({ name: "J" }), lastModified: 2000 },
  });
  const picked = await pickNewestCrateSource(handle);
  assert.equal(picked.name, "additional-ro-crate-metadata.xlsx", "the newer spreadsheet should win over an older JSON");
}

{
  // Same timestamp: the hand-authored spreadsheet is listed first and wins,
  // so a build that writes everything at once doesn't flip the answer.
  const handle = fakeDirHandle({
    "additional-ro-crate-metadata.xlsx": { bytes: Buffer.from("x"), lastModified: 5000 },
    "ro-crate-metadata.xlsx": { bytes: Buffer.from("x"), lastModified: 5000 },
    "ro-crate-metadata.json": { bytes: crateJsonBytes({ name: "J" }), lastModified: 5000 },
  });
  assert.equal((await pickNewestCrateSource(handle)).name, PREFILL_SOURCES[0].name, "ties go to the first candidate listed");
}

assert.equal(await pickNewestCrateSource(fakeDirHandle({})), null, "a folder with none of the candidates yields null");
assert.equal(await pickNewestCrateSource(null), null, "no folder yields null, not a throw");

/* ---------- reading a JSON source ---------- */

{
  const handle = fakeDirHandle({
    "ro-crate-metadata.json": { bytes: crateJsonBytes({ name: "From JSON" }), lastModified: 1 },
  });
  const json = await readCrateJsonFromSource(await pickNewestCrateSource(handle));
  const root = json["@graph"].find((e) => e["@id"] === "./");
  assert.equal(root.name, "From JSON");
}

{
  const handle = fakeDirHandle({
    "ro-crate-metadata.json": { bytes: Buffer.from("{ not json"), lastModified: 1 },
  });
  const picked = await pickNewestCrateSource(handle);
  await assert.rejects(
    () => readCrateJsonFromSource(picked),
    /not valid JSON/,
    "a malformed metadata file should say so, not fail obscurely later"
  );
}

/* ---------- root properties, seeding, merging ---------- */

// Build a real spreadsheet to read back, rather than checking in a fixture:
// this also proves the round trip through ro-crate-excel both ways.
const source = new ROCrate({ array: true, link: true });
source.addContext({ custom: "arcp://name,custom/terms#" });
Object.assign(source.rootDataset, {
  "@type": ["Dataset", "RepositoryCollection"],
  name: "Birds",
  description: "A collection",
  datePublished: "2026",
  author: { "@id": "#org" },
});
source.rootDataset["pcdm:hasMember"] = { "@id": "#magpie" };
source.addEntity({ "@id": "#magpie", "@type": "RepositoryObject", name: "magpie", "custom:translation": "Magpie", image: { "@id": "files/magpie.jpg" } });
source.addEntity({ "@id": "files/magpie.jpg", "@type": "File", isPartOf: { "@id": "#magpie" } });

const { Workbook } = await import("ro-crate-excel");
const wb = new Workbook({ crate: source });
await wb.crateToWorkbook();
const xlsxPath = path.join(mkdtempSync(path.join(tmpdir(), "r2c-")), "additional-ro-crate-metadata.xlsx");
writeFileSync(xlsxPath, await wb.workbook.xlsx.writeBuffer());

const readBack = await readCrateFromXlsxBytes(readFileSync(xlsxPath));
assert.equal(readBack.rootDataset.name?.[0] ?? readBack.rootDataset.name, "Birds", "the spreadsheet should read back as a crate");

{
  const props = rootPropertiesFromCrate(readBack);
  assert.equal(props.name, "Birds");
  assert.equal(props.datePublished, "2026");
  assert.ok(!("pcdm:hasMember" in props), "hasMember is the folder scan's to own, not the spreadsheet's");
  assert.ok(!("@type" in props), "@type comes from the profile");
  assert.ok(!("conformsTo" in props), "conformsTo comes from the profile");
}

{
  // Flattening matters when the reference resolves — ro-crate's link:true
  // hands back the whole linked entity, and copying that into the root would
  // nest a duplicate of it there. (A reference to an entity the crate does
  // NOT describe survives a spreadsheet round trip as a plain string, so this
  // is checked on a crate built directly, where the link is real.)
  const linked = new ROCrate({ array: true, link: true });
  linked.addEntity({ "@id": "#org", "@type": "Organization", name: "LDaCA" });
  linked.rootDataset.author = { "@id": "#org" };
  const props = rootPropertiesFromCrate(linked);
  assert.deepEqual(props.author, { "@id": "#org" }, "a resolved reference should flatten back to {@id}");
}

{
  const target = { name: "Typed by hand", "@type": ["Dataset"] };
  const taken = seedRootDataset(target, rootPropertiesFromCrate(readBack));
  assert.equal(target.name, "Typed by hand", "a value the user supplied must survive");
  assert.ok(taken.includes("description"), "gaps should be filled");
  assert.ok(!taken.includes("name"), "the report should not claim a field it left alone");
}

{
  const target = new ROCrate({ array: true, link: true });
  target.rootDataset.name = "target";
  target.addEntity({ "@id": "files/magpie.jpg", "@type": "File", encodingFormat: "image/jpeg" });

  const { added, enriched } = mergeCrateEntities(target, readBack);
  assert.ok(added >= 1, "entities the target lacks should be added");
  assert.equal(enriched, 1, "the file already present should be enriched, not duplicated");

  const file = target.getEntity("files/magpie.jpg");
  assert.equal(String(file.encodingFormat), "image/jpeg", "a property the spreadsheet says nothing about survives — the scan is the only source of media type");
  assert.equal(file.isPartOf?.[0]?.["@id"] ?? file.isPartOf?.["@id"], "#magpie", "the spreadsheet's link should be added");
  assert.equal(String(target.rootDataset.name), "target", "the source root must not overwrite the target root");
}

{
  // The spreadsheet wins on properties it states, even when the folder scan
  // already set them. Gap-filling let the scan win by being written first,
  // which is how media files ended up belonging to a folder object rather than
  // to the entry the spreadsheet named.
  const target = new ROCrate({ array: true, link: true });
  target.rootDataset.name = "target";
  target.addEntity({
    "@id": "files/magpie.jpg",
    "@type": "File",
    encodingFormat: "image/jpeg",
    contentSize: "12345",
    isPartOf: { "@id": "#some-folder-object" },
  });

  mergeCrateEntities(target, readBack);
  const file = target.getEntity("files/magpie.jpg");

  assert.equal(
    file.isPartOf?.[0]?.["@id"] ?? file.isPartOf?.["@id"], "#magpie",
    "the spreadsheet's isPartOf must replace the scan's guess, not lose to it"
  );
  assert.equal(String(file.encodingFormat), "image/jpeg", "…while properties only the scan knows survive");
  assert.equal(String(file.contentSize), "12345", "…including the ones ro-crate's addEntity({replace:true}) would have dropped");
}

{
  // The workbook is authored as its own standalone crate, so per RO-Crate
  // convention its entities point at their root as "./" — but the target
  // crate's root can carry a different, persistent @id (set in the Describe
  // step). A "./" reference copied over verbatim would point at an entity
  // the target doesn't have.
  const target = new ROCrate({
    "@context": "https://w3id.org/ro/crate/1.2/context",
    "@graph": [
      { "@id": "ro-crate-metadata.json", "@type": "CreativeWork", about: { "@id": "arcp://name,birds/root" } },
      { "@id": "arcp://name,birds/root", "@type": "Dataset", name: "target" },
    ],
  }, { array: true, link: true });

  const source = new ROCrate({ array: true, link: true });
  source.addEntity({ "@id": "#magpie", "@type": "RepositoryObject", name: "magpie", memberOf: { "@id": "./" } });

  const { remapped } = mergeCrateEntities(target, source);
  assert.equal(remapped, 1, "a reference to the workbook's own root should be remapped");
  const magpie = target.getEntity("#magpie");
  assert.equal(
    magpie.memberOf?.[0]?.["@id"] ?? magpie.memberOf?.["@id"],
    "arcp://name,birds/root",
    "…to the target crate's actual root id, not left as the workbook's own \"./\""
  );
}

{
  // Scoped to memberOf specifically — a property that happens to also
  // reference the workbook's root, but doesn't mean "belongs to the root
  // collection", must be left exactly as the workbook stated it.
  const target = new ROCrate({
    "@context": "https://w3id.org/ro/crate/1.2/context",
    "@graph": [
      { "@id": "ro-crate-metadata.json", "@type": "CreativeWork", about: { "@id": "arcp://name,birds/root" } },
      { "@id": "arcp://name,birds/root", "@type": "Dataset", name: "target" },
    ],
  }, { array: true, link: true });

  const source = new ROCrate({ array: true, link: true });
  source.addEntity({ "@id": "#note", "@type": "CreativeWork", name: "note", about: { "@id": "./" } });

  const { remapped } = mergeCrateEntities(target, source);
  assert.equal(remapped, 0, "a non-memberOf reference to the workbook's root should not be touched");
  const note = target.getEntity("#note");
  assert.equal(note.about?.[0]?.["@id"] ?? note.about?.["@id"], "./", "…it survives exactly as the workbook wrote it");
}

{
  // When the target's root really is "./" (no custom id set), there's
  // nothing to remap — the reference already resolves correctly.
  const target = new ROCrate({ array: true, link: true });
  target.rootDataset.name = "target";
  const source = new ROCrate({ array: true, link: true });
  source.addEntity({ "@id": "#magpie", "@type": "RepositoryObject", name: "magpie", memberOf: { "@id": "./" } });

  const { remapped } = mergeCrateEntities(target, source);
  assert.equal(remapped, 0, "no remap needed when the target root is already \"./\"");
  const magpie = target.getEntity("#magpie");
  assert.equal(magpie.memberOf?.[0]?.["@id"] ?? magpie.memberOf?.["@id"], "./");
}

/* ---------- collection membership ---------- */

// What the folder scan leaves behind: a member per top-level folder, and no
// idea that #magpie is what the collection actually contains.
function scannedCrate() {
  const target = new ROCrate({ array: true, link: true });
  target.rootDataset.name = "Birds";
  target.addEntity({ "@id": "#about", "@type": "RepositoryObject", name: "about" });
  target.addEntity({ "@id": "#files", "@type": "RepositoryObject", name: "files" });
  target.rootDataset["pcdm:hasMember"] = [{ "@id": "#about" }, { "@id": "#files" }];
  return target;
}

{
  const target = scannedCrate();
  mergeCrateEntities(target, readBack);
  const result = applyCollectionMembership(target, readBack);

  const members = (target.rootDataset["pcdm:hasMember"] || []).map((m) => m["@id"]);
  assert.deepEqual(members, ["#magpie"], "the workbook's members replace the folder scan's, rather than joining them");
  assert.deepEqual(result.kept, ["#magpie"]);
  assert.equal(result.replaced, 2, "the report should say how many scanned members were dropped");
  assert.ok(target.getEntity("#about"), "the folder objects stay in the graph — only membership changes");
}

{
  // A workbook naming a member it never described mustn't produce a card
  // pointing at nothing.
  const target = scannedCrate();
  const source = new ROCrate({ array: true, link: true });
  source.addEntity({ "@id": "#real", "@type": "RepositoryObject", name: "real" });
  source.rootDataset["pcdm:hasMember"] = [{ "@id": "#real" }, { "@id": "#ghost" }];
  mergeCrateEntities(target, source);
  const result = applyCollectionMembership(target, source);

  assert.deepEqual((target.rootDataset["pcdm:hasMember"] || []).map((m) => m["@id"]), ["#real"]);
  assert.deepEqual(result.missing, ["#ghost"], "an undescribed member should be reported, not silently dropped");
}

{
  // Nothing usable in the workbook: keep what the scan worked out.
  const target = scannedCrate();
  const empty = new ROCrate({ array: true, link: true });
  assert.equal(applyCollectionMembership(target, empty), null, "a workbook with no membership leaves the scan's alone");
  assert.deepEqual(
    (target.rootDataset["pcdm:hasMember"] || []).map((m) => m["@id"]),
    ["#about", "#files"],
    "…and the scanned members survive untouched"
  );
}

{
  const target = scannedCrate();
  const source = new ROCrate({ array: true, link: true });
  source.rootDataset["pcdm:hasMember"] = [{ "@id": "#nothing-here" }];
  assert.equal(applyCollectionMembership(target, source, () => {}), null, "membership naming only absent entities is refused");
  assert.equal((target.rootDataset["pcdm:hasMember"] || []).length, 2, "…leaving the folder structure rather than an empty collection");
}

/* ---------- warnings ---------- */

{
  // No validator: only the dangling-reference check runs.
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset.author = { "@id": "#nobody" };
  crate.rootDataset.license = { "@id": "https://creativecommons.org/licenses/by/4.0/" };
  crate.rootDataset.conformsTo = { "@id": "https://w3id.org/ro/crate/1.2" };

  const messages = collectWarnings(crate).map((w) => w.message).join("\n");
  assert.match(messages, /#nobody/, "an author pointing at an entity nobody described is worth a warning");
  assert.ok(!/creativecommons|w3id/.test(messages), "licence and profile URIs are external identifiers nobody describes — warning about them is noise");
}

{
  // A vocabulary-defining entity is scaffolding, not data the profile grades,
  // so its rdfs:* properties mustn't be reported as unknown. Faked here with a
  // validator stub, since the real one needs a profile crate.
  const crate = new ROCrate({ array: true, link: true });
  crate.addEntity({ "@id": "arcp://name,custom/terms#translation", "@type": "rdf:Property", name: "translation", "rdfs:label": "translation" });
  crate.addEntity({ "@id": "#magpie", "@type": "RepositoryObject", name: "magpie", "custom:sentance": "typo" });

  const stubValidator = { ensureParsed() {}, rules: { properties: { a: { propertyName: "name" } } } };
  const messages = collectWarnings(crate, stubValidator).map((w) => w.message).join("\n");
  assert.match(messages, /custom:sentance/, "a misspelled property on real data should be caught");
  assert.ok(!/rdfs:label/.test(messages), "a crate's own vocabulary definitions are not graded against the profile");
}

console.log(`test-xlsx-crate: all tests passed (${PREFILL_SOURCES.length} prefill sources, spreadsheet round trip verified)`);
