// buildCrate()'s persist-and-reconcile path (SPEC.md §6.1a): when an
// existing crate is passed in via opts.existingJson, a build must not throw
// its entities away and start over — it should keep every entity the
// existing crate already describes untouched, add a File entity for a new
// physical file, and warn (never delete) about a File entity whose file no
// longer exists in the folder.
import assert from "node:assert/strict";

import { buildFileMetadata, buildCrate } from "../src/crate.js";

function typesOf(entity) {
  return [].concat(entity?.["@type"] ?? []);
}
function byId(graph, id) {
  return graph.find((e) => e["@id"] === id);
}

const CONFIG = { rootDataset: { "@id": "arcp://name,reconcile-test", "@type": "Dataset", name: "Reconcile Test" } };

// A hand-curated crate with structure a folder scan could never invent on
// its own: a RepositoryObject that doesn't share its @id with any folder
// name, a Person, and a File that (deliberately) has no matching file on
// disk in this test's `files` list below — standing in for "deleted since
// the crate was last built". The RepositoryObject's @id is already in
// absolute form (as a real external tool's output would be) rather than a
// bare "#hash" — buildCrate's rewriteHashIdsForExport step rewrites *any*
// "#hash" RepositoryObject/Collection id to arcp form on every build,
// reconcile or not (SPEC.md §6.1), so a bare "#interview-42" here would be
// testing that unrelated, pre-existing rewrite rather than reconciliation.
const INTERVIEW_ID = "arcp://name,reconcile-test/interview-42";
const EXISTING_JSON = {
  "@context": "https://w3id.org/ro/crate/1.1/context",
  "@graph": [
    { "@id": "ro-crate-metadata.json", "@type": "CreativeWork", conformsTo: { "@id": "https://w3id.org/ro/crate/1.1" }, about: { "@id": "arcp://name,reconcile-test" } },
    {
      "@id": "arcp://name,reconcile-test", "@type": "Dataset", name: "Reconcile Test",
      hasPart: [{ "@id": "interview-42.wav" }, { "@id": "gone.wav" }],
      "pcdm:hasMember": [{ "@id": INTERVIEW_ID }],
    },
    {
      "@id": INTERVIEW_ID, "@type": "RepositoryObject", name: "Interview with a real person, not a folder name",
      "pcdm:memberOf": { "@id": "arcp://name,reconcile-test" },
      author: { "@id": "#person-1" },
    },
    { "@id": "#person-1", "@type": "Person", name: "A Real Curator Typed This In By Hand" },
    { "@id": "interview-42.wav", "@type": "File", name: "interview-42.wav", "custom:transcribedBy": "someone, painstakingly" },
    { "@id": "gone.wav", "@type": "File", name: "gone.wav" },
  ],
};

// The folder as it actually is right now: interview-42.wav is still there,
// gone.wav has been deleted, and a brand new file has shown up that the
// existing crate has never heard of.
const files = [
  { fileName: "interview-42.wav", relativePath: "interview-42.wav" },
  { fileName: "new-recording.wav", relativePath: "new-recording.wav" },
];

const logged = [];
const log = (msg, level) => logged.push([msg, level]);
const meta = buildFileMetadata(files);
const crate = buildCrate(meta, CONFIG, log, { existingJson: EXISTING_JSON });
const graph = crate.getJson()["@graph"];

/* ---------- everything the existing crate already had survives untouched ---------- */

assert.ok(byId(graph, INTERVIEW_ID), "the curated RepositoryObject must survive a rebuild");
assert.ok(byId(graph, "#person-1"), "the Person must survive a rebuild");
const interviewName = byId(graph, INTERVIEW_ID).name;
assert.equal(
  Array.isArray(interviewName) ? interviewName[0] : interviewName,
  "Interview with a real person, not a folder name",
  "an existing entity's own properties must not be overwritten by anything folder-scan-derived"
);
assert.equal(
  byId(graph, "interview-42.wav")["custom:transcribedBy"],
  "someone, painstakingly",
  "an existing File entity's own custom properties must survive — reconciling must not replace it with a blank stub"
);
assert.equal(
  graph.filter((e) => typesOf(e).includes("RepositoryObject")).length, 1,
  "reconciling must not invent a second, folder-scan-derived RepositoryObject alongside the curated one"
);

/* ---------- a new physical file gets added, not ignored ---------- */

const newFile = byId(graph, "new-recording.wav");
assert.ok(newFile, "a file with no existing entity must get a new File entity added");
assert.ok(typesOf(newFile).includes("File"), "the new entity must be typed File");
assert.ok(
  (crate.rootDataset.hasPart || []).some((r) => r["@id"] === "new-recording.wav"),
  "a new file with no matching container in the existing graph must be linked from the root dataset, so it's not an orphan"
);
assert.ok(
  logged.some(([msg, level]) => level === "warn" && msg.includes("new-recording.wav") && msg.includes("New file added")),
  "adding a new file must be logged clearly, since it landed at the root rather than wherever a curator would actually want it"
);

/* ---------- a missing file's entity is kept, only warned about ---------- */

assert.ok(byId(graph, "gone.wav"), "a File entity whose file was deleted from the folder must NOT be removed from the graph");
assert.ok(
  logged.some(([msg, level]) => level === "warn" && msg.includes("gone.wav") && msg.includes("missing from the folder")),
  "a File entity with no matching file on disk must be warned about"
);

/* ---------- rebuilding again against its own output is a no-op ---------- */

const rebuilt = buildCrate(buildFileMetadata(files), CONFIG, () => {}, { existingJson: crate.getJson() });
assert.equal(rebuilt.getJson()["@graph"].length, graph.length, "reconciling a second time against the same folder must not add or lose anything");
assert.equal(
  crate.getJson()["@context"].length,
  rebuilt.getJson()["@context"].length,
  "reconciling repeatedly must not keep growing @context with duplicate entries for the same mapping"
);

/* ---------- a from-scratch build (no existing crate) is unaffected ---------- */

const fresh = buildCrate(meta, CONFIG, () => {}, {});
assert.ok(!byId(fresh.getJson()["@graph"], "#interview-42"), "with no existingJson, buildCrate must still build fresh — no accidental persistence");

console.log(`test-crate-reconcile: all tests passed (${graph.length} entities survived reconciliation, 1 new file added, 1 missing file kept+warned)`);
