// The AUSTLANG handoff: matches are made at files:analyze and applied at
// crate:built, two hook stages apart with every other tap's handler running in
// between. The result used to be an array parallel to filesWithMeta, consumed
// by index — so any tap that reordered, filtered or appended to that array
// would have attributed languages to the wrong files, silently. It's keyed by
// file id now, and this pins that down.
//
// Scope is the handoff, not the matching: identifyAllLanguages pulls in a
// ~730 kB data pack, and what broke here was never the matcher.
import assert from "node:assert/strict";
import { ROCrate } from "ro-crate";
import { addLanguageEntities } from "../src/crate.js";

const DYIRBAL = { "@id": "https://collection.aiatsis.gov.au/austlang/language/y123", "@type": "Language", name: "Dyirbal" };
const WARLPIRI = { "@id": "https://collection.aiatsis.gov.au/austlang/language/c15", "@type": "Language", name: "Warlpiri" };

function crateWithFiles(ids) {
  const crate = new ROCrate({ array: true, link: true });
  crate.addContext({ ldac: "https://w3id.org/ldac/terms#" });
  for (const id of ids) crate.addEntity({ "@id": id, "@type": "File", name: id });
  return crate;
}

const FILES = [
  { id: "audio/dyirbal-story.mp3", fileName: "dyirbal-story.mp3" },
  { id: "audio/untitled.mp3", fileName: "untitled.mp3" },
  { id: "audio/warlpiri-song.mp3", fileName: "warlpiri-song.mp3" },
];

// Only two of the three matched — the middle file is deliberately absent from
// the map, which is how "nothing matched" is represented.
const langById = new Map([
  ["audio/dyirbal-story.mp3", { matchedLanguages: [DYIRBAL] }],
  ["audio/warlpiri-song.mp3", { matchedLanguages: [WARLPIRI] }],
]);

const subjectLanguagesOf = (crate, id) =>
  (crate.getEntity(id)?.["ldac:subjectLanguage"] || []).map((l) => l["@id"]);

/* ---------- the languages land on the files that matched ---------- */

{
  const crate = crateWithFiles(FILES.map((f) => f.id));
  const count = addLanguageEntities(crate, FILES, langById);

  assert.equal(count, 2, "two distinct languages were identified");
  assert.deepEqual(subjectLanguagesOf(crate, "audio/dyirbal-story.mp3"), [DYIRBAL["@id"]]);
  assert.deepEqual(subjectLanguagesOf(crate, "audio/warlpiri-song.mp3"), [WARLPIRI["@id"]]);
  assert.deepEqual(subjectLanguagesOf(crate, "audio/untitled.mp3"), [], "a file nothing matched gets no language");
  assert.ok(crate.getEntity(DYIRBAL["@id"]), "each matched language becomes an entity in its own right");
  assert.ok(crate.getEntity(WARLPIRI["@id"]));
}

/* ---------- position in filesWithMeta is irrelevant ---------- */

{
  // The exact hazard: another files:analyze tap reorders the array before
  // crate:built runs. With positional keys this attributed Dyirbal to the
  // Warlpiri recording.
  const reordered = [...FILES].reverse();
  const crate = crateWithFiles(reordered.map((f) => f.id));
  addLanguageEntities(crate, reordered, langById);

  assert.deepEqual(subjectLanguagesOf(crate, "audio/dyirbal-story.mp3"), [DYIRBAL["@id"]],
    "reordering the file list must not move a language onto a different recording");
  assert.deepEqual(subjectLanguagesOf(crate, "audio/warlpiri-song.mp3"), [WARLPIRI["@id"]]);
}

{
  // A tap that filters the array, or one that appends a file the matcher never
  // saw: neither should throw or misattribute.
  const filtered = FILES.filter((f) => f.id !== "audio/dyirbal-story.mp3");
  const withExtra = [...filtered, { id: "audio/added-later.mp3", fileName: "added-later.mp3" }];
  const crate = crateWithFiles(withExtra.map((f) => f.id));
  addLanguageEntities(crate, withExtra, langById);

  assert.deepEqual(subjectLanguagesOf(crate, "audio/warlpiri-song.mp3"), [WARLPIRI["@id"]]);
  assert.deepEqual(subjectLanguagesOf(crate, "audio/added-later.mp3"), [],
    "a file the matcher never saw is simply left alone");
}

/* ---------- edge cases ---------- */

{
  const crate = crateWithFiles(FILES.map((f) => f.id));
  assert.equal(addLanguageEntities(crate, FILES, new Map()), 0, "no matches at all is not an error");
  assert.deepEqual(subjectLanguagesOf(crate, "audio/dyirbal-story.mp3"), []);
}

{
  // One file, two languages; and the same language on two files counts once.
  const crate = crateWithFiles(FILES.map((f) => f.id));
  const shared = new Map([
    ["audio/dyirbal-story.mp3", { matchedLanguages: [DYIRBAL, WARLPIRI] }],
    ["audio/warlpiri-song.mp3", { matchedLanguages: [WARLPIRI] }],
  ]);
  assert.equal(addLanguageEntities(crate, FILES, shared), 2, "the count is of distinct languages, not of links");
  assert.deepEqual(subjectLanguagesOf(crate, "audio/dyirbal-story.mp3"), [DYIRBAL["@id"], WARLPIRI["@id"]]);
}

{
  // A language carrying a Geometry brings it along.
  const withGeo = { ...DYIRBAL, geo: { "@id": "#geo-dyirbal", "@type": "Geometry", asWKT: "POINT (145.6 -17.6)" } };
  const crate = crateWithFiles(FILES.map((f) => f.id));
  addLanguageEntities(crate, FILES, new Map([["audio/dyirbal-story.mp3", { matchedLanguages: [withGeo] }]]));
  assert.ok(crate.getEntity("#geo-dyirbal"), "a language's geometry is added as its own entity");
}

console.log(`test-language-entities: all tests passed (id-keyed handoff survives reorder, filter and append)`);
