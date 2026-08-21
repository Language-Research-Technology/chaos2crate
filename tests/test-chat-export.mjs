import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createPlugin } from "c2c-plugins/src/chat-export/index.js";
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

console.log("test-chat-export: all tests passed");
