// buildCrateFromDocxFolder used to discard each original .docx after parsing
// it — only the derived Chapter/DocumentPart structure survived. Now the
// original file is copied into ro-crate-preview_files/ verbatim and the
// crate's root gets two members instead of one-per-topic-folder:
// #derivedContent (the same RepositoryCollection-per-topic structure as
// before, just nested one level deeper) and #sourceDocuments (one
// SourceDocumentGroup per topic, holding that topic's original .docx files
// as File entities).
//
// Chapter/DocumentPart parsing itself is untouched by this change, so these
// fixtures use garbage bytes for the ".docx" files rather than a real OOXML
// document — mammoth fails to parse them, which buildCrateFromDocxFolder
// already treats as a non-fatal per-document warning (see its try/catch
// around parseStructuredChapters), and the rest of the pipeline — including
// the new copy-and-wrap logic under test here — runs identically either way,
// since copying a file's bytes into ro-crate-preview_files/ never depends on
// what they are.
import assert from "node:assert/strict";
import { buildCrateFromDocxFolder } from "../src/plugins/docx-input/docx_crate.js";

/* ---------- an in-memory stand-in for FileSystemDirectoryHandle ---------- */
// Built from a plain nested object: a Uint8Array value is a file, anything
// else is a subdirectory. Covers exactly what docx_crate.js calls: values()
// for directory listing, getDirectoryHandle/getFileHandle with {create}, and
// a writable file handle whose bytes land back in the tree so the written
// ro-crate-preview_files/ output can be inspected after the build.
//
// The fixture is converted once into a tree of persistent nodes ({kind:
// "dir", children: Map} or {kind: "file", bytes}) up front, and every handle
// wraps a node by reference rather than a fresh copy of it — a
// getDirectoryHandle({create:true}) call has to hand back a live view whose
// later writes are visible through the *original* handle too, exactly like
// the real File System Access API and unlike a snapshot taken at wrap time.
function notFoundError() {
  const e = new Error("not found");
  e.name = "NotFoundError";
  return e;
}

function toNode(value) {
  if (value instanceof Uint8Array) return { kind: "file", bytes: value };
  const children = new Map();
  for (const [childName, childValue] of Object.entries(value)) children.set(childName, toNode(childValue));
  return { kind: "dir", children };
}

function wrapDirNode(name, node) {
  return {
    kind: "directory",
    name,
    async *values() {
      for (const [childName, child] of node.children) {
        yield child.kind === "file" ? wrapFileNode(childName, child) : wrapDirNode(childName, child);
      }
    },
    async getDirectoryHandle(childName, { create = false } = {}) {
      let child = node.children.get(childName);
      if (!child) {
        if (!create) throw notFoundError();
        child = { kind: "dir", children: new Map() };
        node.children.set(childName, child);
      }
      if (child.kind !== "dir") throw new Error(`${childName} is a file, not a directory`);
      return wrapDirNode(childName, child);
    },
    async getFileHandle(childName, { create = false } = {}) {
      let child = node.children.get(childName);
      if (!child) {
        if (!create) throw notFoundError();
        child = { kind: "file", bytes: new Uint8Array() };
        node.children.set(childName, child);
      }
      if (child.kind !== "file") throw new Error(`${childName} is a directory, not a file`);
      return wrapFileNode(childName, child);
    },
    async removeEntry(childName) {
      node.children.delete(childName);
    },
    // Test-only: read back the bytes at a "/"-joined file path under this
    // dir, or undefined if no file sits there.
    readFile(relativePath) {
      let current = node;
      const parts = relativePath.split("/").filter(Boolean);
      for (const part of parts.slice(0, -1)) {
        if (!current || current.kind !== "dir") return undefined;
        current = current.children.get(part);
      }
      if (!current || current.kind !== "dir") return undefined;
      const leaf = current.children.get(parts[parts.length - 1]);
      return leaf && leaf.kind === "file" ? leaf.bytes : undefined;
    },
  };
}

function wrapFileNode(name, node) {
  return {
    kind: "file",
    name,
    async getFile() {
      return new File([node.bytes], name);
    },
    async createWritable() {
      return {
        async write(contents) {
          node.bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
        },
        async close() {},
      };
    },
  };
}

function memoryDirHandle(name, tree) {
  return wrapDirNode(name, toNode(tree));
}

/* ---------- fixture: two topics, one .docx each, garbage bytes ---------- */

const docBytes = (label) => new TextEncoder().encode(`not a real docx: ${label}`);

const root = memoryDirHandle("root", {
  AnmWeb1_HOME: { "Home.docx": docBytes("home") },
  AnmWeb2_Recollections: { "Recollections.docx": docBytes("recollections") },
});

const { crate } = await buildCrateFromDocxFolder(root, { name: "Test Site", description: "d", datePublished: "2024-01-01" });
const byId = Object.fromEntries(crate.toJSON()["@graph"].map((e) => [e["@id"], e]));

/* ---------- root has exactly derivedContent + sourceDocuments ---------- */

const rootHasPart = [].concat(byId["./"].hasPart).map((r) => r["@id"]).sort();
assert.deepEqual(
  rootHasPart,
  ["#derivedContent", "#sourceDocuments"],
  "the root dataset's only members are the two wrapper collections, not one per topic folder"
);

/* ---------- derivedContent holds exactly the topics, RepositoryCollection-typed ---------- */

assert.equal(byId["#derivedContent"]["@type"], "custom:DerivedContentCollection");
const derivedTopics = [].concat(byId["#derivedContent"].hasPart).map((r) => r["@id"]).sort();
assert.deepEqual(
  derivedTopics,
  ["#AnmWeb1_HOME", "#AnmWeb2_Recollections"],
  "derivedContent's members are exactly the per-topic ids the old flat root.hasPart used to carry"
);
for (const topicId of derivedTopics) {
  assert.equal(byId[topicId]["@type"], "RepositoryCollection", `${topicId} keeps its pre-refactor type`);
}

/* ---------- sourceDocuments mirrors the same topic grouping ---------- */

assert.equal(byId["#sourceDocuments"]["@type"], "custom:SourceDocumentsCollection");
const sourceGroups = [].concat(byId["#sourceDocuments"].hasPart).map((r) => r["@id"]).sort();
assert.deepEqual(
  sourceGroups,
  ["#sourceDocuments-AnmWeb1_HOME", "#sourceDocuments-AnmWeb2_Recollections"],
  "one SourceDocumentGroup per topic, mirroring derivedContent's grouping"
);

const homeGroup = byId["#sourceDocuments-AnmWeb1_HOME"];
assert.equal(homeGroup["@type"], "custom:SourceDocumentGroup");
assert.equal(homeGroup.name, "AnmWeb1_HOME", "an unlabelled topic falls back to its folder name, same as derivedContent's collection label");

const homeFileRefs = [].concat(homeGroup.hasPart).map((r) => r["@id"]);
assert.equal(homeFileRefs.length, 1, "one File per original .docx in that topic");
const homeFileId = homeFileRefs[0];
assert.equal(homeFileId, "ro-crate-preview_files/AnmWeb1_HOME/Home.docx", "the File's @id is its own copied path under ro-crate-preview_files/, same convention media entities use");

const homeFileEntity = byId[homeFileId];
assert.equal(homeFileEntity["@type"], "File");
assert.equal(homeFileEntity.name, "Home.docx");
assert.equal(
  homeFileEntity.encodingFormat,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "docx now has its own encodingFormat rather than falling back to application/octet-stream"
);

/* ---------- the original bytes were actually copied into ro-crate-preview_files/, verbatim ---------- */

const writtenBytes = root.readFile("ro-crate-preview_files/AnmWeb1_HOME/Home.docx");
assert.ok(writtenBytes instanceof Uint8Array, "ro-crate-preview_files/AnmWeb1_HOME/Home.docx should exist in the output tree");
assert.deepEqual(
  [...writtenBytes],
  [...docBytes("home")],
  "the copied .docx is byte-for-byte the original — buildCrateFromDocxFolder never re-encodes it"
);

/* ---------- a topic where every .docx is filtered out mints no source group ---------- */

const rootWithNotesOnly = memoryDirHandle("root", {
  AnmWeb1_HOME: { "Home.docx": docBytes("home") },
  AnmWeb3_NotesOnly: { "notes.docx": docBytes("notes") },
});
const { crate: crateNotesOnly } = await buildCrateFromDocxFolder(rootWithNotesOnly, { name: "t", description: "d", datePublished: "2024-01-01" });
const byIdNotesOnly = Object.fromEntries(crateNotesOnly.toJSON()["@graph"].map((e) => [e["@id"], e]));
const sourceGroupsNotesOnly = [].concat(byIdNotesOnly["#sourceDocuments"].hasPart).map((r) => r["@id"]);
assert.deepEqual(
  sourceGroupsNotesOnly,
  ["#sourceDocuments-AnmWeb1_HOME"],
  "a topic whose only .docx is a private notes file (isNotesDocx) contributes no source group, matching derivedContent's own empty-collection handling for the same file"
);

console.log("test-docx-source-documents: all tests passed (root wrapper shape, derivedContent/sourceDocuments mirroring, verbatim file copy, docx encodingFormat, notes-only topic)");
