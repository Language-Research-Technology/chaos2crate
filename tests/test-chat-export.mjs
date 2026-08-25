import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ROCrate } from "ro-crate";

import { createPlugin, addChatFilesToCrate } from "c2c-plugins/src/chat-export/index.js";
import { buildDeps } from "../src/plugins/deps.js";

const plugin = createPlugin(buildDeps());

const text = `Transcript: Demo
Recording date: 2025-01-01
Speakers:
A: Gareth Evans (Holt, ALP) #speaker01
B: Sam #speaker02
PRELIMINARIES
A: hello there
B: hi
MAIN
A: I am here
B: yes
POSTLIMINARIES
A: thanks`;

const result = plugin.generateChatText?.(text, { corpusId: "demo-corpus", languageIso: "eng" });
assert.ok(result.includes("@Participants: A Participant, B Participant"));
assert.ok(result.includes("@ID: eng|demo-corpus|A"));
assert.ok(result.includes("Holt, ALP"));
assert.ok(result.includes("Participant"));
assert.ok(result.includes("*A: hello there"));
assert.ok(result.includes("*B: hi"));

const realDocxUrl = new URL("../../c2c-data-prep-spec/input/AmAus02_transcript_plain.docx", import.meta.url);
const realDocxBytes = await fs.readFile(realDocxUrl);

const seen = [];
const chatCtx = {
  options: { generateChatFiles: true, languageIso: "eng", corpusId: "demo-corpus" },
  filesWithMeta: [{ fileName: "demo.docx", relativePath: "demo.docx", arrayBuffer: async () => realDocxBytes.buffer.slice(realDocxBytes.byteOffset, realDocxBytes.byteOffset + realDocxBytes.byteLength) }],
  dirHandle: { name: "demo-corpus" },
  log: (msg) => seen.push(msg),
};
await plugin.hooks["files:analyze"](chatCtx);
assert.ok(seen.some((msg) => /CHAT export: 1\/1 file\(s\)…/.test(msg)), "CHAT plugin should emit per-file progress logs");

/* ---------- addChatFilesToCrate: .cha files should join the RO-Crate ---------- */

{
  // Alongside a RepositoryObject ca-data-prep already built for the same
  // source document (same "./c2c-output/<baseName>" id) — the .cha should
  // join its hasPart, matching how ca-data-prep links its own CSV.
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset"];
  crate.addEntity({
    "@id": "./c2c-output/demo",
    "@type": "RepositoryObject",
    name: "demo",
    hasPart: [{ "@id": "demo.docx" }, { "@id": "./c2c-output/csv/demo.csv" }],
  });

  addChatFilesToCrate(crate, [{ baseName: "demo", chatDirName: "c2c-output/chat", chatName: "demo.cha" }]);

  const byId = Object.fromEntries(crate.toJSON()["@graph"].map((e) => [e["@id"], e]));
  const chatEntity = byId["./c2c-output/chat/demo.cha"];
  assert.ok(chatEntity, "the .cha should be added as a File entity");
  assert.equal(chatEntity["@type"], "File");
  assert.equal(chatEntity.encodingFormat, "text/plain");
  assert.equal(chatEntity.isPartOf["@id"], "./c2c-output/demo", "it should record which document it belongs to");

  const parts = byId["./c2c-output/demo"].hasPart.map((p) => p["@id"]);
  assert.deepEqual(parts, ["demo.docx", "./c2c-output/csv/demo.csv", "./c2c-output/chat/demo.cha"], "the .cha should join the object's existing hasPart, not replace it");
}

{
  // Without a matching RepositoryObject (chat-export used on its own, no
  // ca-data-prep this build) the File entity should still be added, just
  // without a container to link into.
  const crate = new ROCrate({ array: true, link: true });
  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset"];

  addChatFilesToCrate(crate, [{ baseName: "orphan", chatDirName: "c2c-output/chat", chatName: "orphan.cha" }]);

  const chatEntity = crate.getEntity("./c2c-output/chat/orphan.cha");
  assert.ok(chatEntity, "the .cha should still be added as a File entity with no RepositoryObject to join");
  assert.equal(chatEntity.isPartOf, undefined, "there's nothing to record isPartOf against");
}

console.log("test-chat-export: all tests passed");
