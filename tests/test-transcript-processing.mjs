import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  normalizeText,
  mergeContinuationLines,
  parseSpeakerBlock,
  parseRows,
  processTranscriptText,
  extractDocumentText,
  toMammothInputOptions,
  toCsv,
  buildSpeakerPersonEntities,
} from "c2c-plugins/src/ca-data-prep/process.js";
import { createPlugin, readDocxFileBytesFromDirHandle } from "c2c-plugins/src/ca-data-prep/index.js";
import { buildDeps } from "../src/plugins/deps.js";

const plugin = createPlugin(buildDeps());

const text = `Transcript: ABC
Recording date: 2025-01-01
Speakers:
A: Paul #speaker01
B: Sam #speaker02
PRELIMINARIES
A: hello there
B: hi
this is a continuation line
MAIN
A: I am here
B: yes
POSTLIMINARIES
A: thanks
END OF TRANSCRIPT`;

const normalized = normalizeText(text);
assert.match(normalized, /A:\tPaul #speaker01/);
assert.doesNotMatch(normalized, /END OF TRANSCRIPT/);

const merged = mergeContinuationLines(normalized);
assert.ok(merged.includes("B:\thi this is a continuation line"));

const speakers = parseSpeakerBlock(merged.split("\n"), []);
assert.equal(speakers.get("A").resolvedSpeakerID, "#speaker01");
assert.equal(speakers.get("B").resolvedSpeakerID, "#speaker02");

const affilSpeakers = parseSpeakerBlock(["Speakers:", "A: Gareth Evans (Holt, ALP) #speaker01"], []);
assert.equal(affilSpeakers.get("A").label, "Gareth Evans");
assert.equal(affilSpeakers.get("A").affiliation, "(Holt, ALP)");
assert.deepEqual(buildSpeakerPersonEntities(affilSpeakers), [{
  "@id": "#speaker01",
  "@type": "Person",
  name: "Gareth Evans",
  affiliation: "(Holt, ALP)",
  identifier: "#speaker01",
}]);

const rows = parseRows(merged, []);
assert.ok(rows.some((row) => row.speakerID === "#speaker01" && row.section === "PRE"));
assert.ok(rows.some((row) => row.speakerID === "#speaker01" && row.section === "MAIN"));
assert.ok(rows.some((row) => row.speakerID === "#speaker01" && row.section === "POST"));

const processed = processTranscriptText(text, { headerRows: 0, footerRows: 0 });
assert.equal(processed.rows[0].speakerID, "#speaker01");
assert.equal(processed.rows[0].section, "PRE");
assert.ok(processed.log.includes("Character inventory"));
assert.ok(processed.log.includes("Unresolved speakerIDs: none"));

const exampleCsv = toCsv([{ speakerID: "#speaker01", text: "hello, world", section: "PRE" }]);
assert.match(exampleCsv, /#speaker01,"hello, world",PRE\n/);

const arrayBufferInput = new ArrayBuffer(8);
const viewInput = new Uint8Array(arrayBufferInput, 2, 4);
assert.ok(Object.hasOwn(toMammothInputOptions(arrayBufferInput), "arrayBuffer"));
assert.ok(Object.hasOwn(toMammothInputOptions(viewInput), "arrayBuffer"));
assert.ok(Object.hasOwn(toMammothInputOptions(Buffer.from([1, 2, 3])), "buffer"));

const realDocxUrl = new URL("../../c2c-data-prep-spec/input/AmAus02_transcript_plain.docx", import.meta.url);
const realDocxBytes = await fs.readFile(realDocxUrl);
const fileLike = {
  fileName: "demo.docx",
  relativePath: "demo.docx",
  arrayBuffer: async () => realDocxBytes.buffer.slice(realDocxBytes.byteOffset, realDocxBytes.byteOffset + realDocxBytes.byteLength),
};
const seen = [];
const ctx = { options: { processTranscriptDocuments: true }, filesWithMeta: [fileLike], log: (msg) => seen.push(msg) };
await plugin.hooks["files:analyze"](ctx);
assert.equal(ctx.caDataPrep.documentRecords[0].csvId, "./c2c-output/csv/demo.csv");
assert.equal(ctx.caDataPrep.documentRecords[0].objectId, "./c2c-output/demo");
assert.ok(ctx.caDataPrep.documentRecords[0].csvText.includes("#speaker01,"));
assert.ok(seen.some((msg) => /Processing transcript document: 1\/1 file\(s\)…/.test(msg)), "Transcript processor should emit per-file progress logs");

const fakeDir = {
  async getDirectoryHandle(name, { create = false } = {}) {
    if (name === "nested") {
      return {
        async getFileHandle(fileName, { create: _create = false } = {}) {
          assert.equal(fileName, "sample.docx");
          return {
            async getFile() {
              return { arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer };
            },
          };
        },
      };
    }
    throw new Error(`unexpected directory: ${name}`);
  },
};
const bytes = await readDocxFileBytesFromDirHandle(fakeDir, "nested/sample.docx");
assert.deepEqual(new Uint8Array(bytes), new Uint8Array([1, 2, 3, 4]));

assert.ok((await extractDocumentText(realDocxBytes)).length > 0, "Buffer input should parse via Mammoth");
assert.ok((await extractDocumentText(realDocxBytes.buffer.slice(realDocxBytes.byteOffset, realDocxBytes.byteOffset + realDocxBytes.byteLength))).length > 0, "ArrayBuffer input should parse via Mammoth");
assert.ok((await extractDocumentText(new File([realDocxBytes], "sample.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }))).length > 0, "File input should parse via Mammoth");

console.log("test-transcript-processing: all tests passed");
