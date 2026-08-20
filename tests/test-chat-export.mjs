import assert from "node:assert/strict";

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

console.log("test-chat-export: all tests passed");
