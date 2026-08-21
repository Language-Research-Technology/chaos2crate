// removeEntryAtPath backs the "delete plugin output before rebuilding"
// setting (main.js's deletePluginOutputs) — it has to delete both a
// top-level file and a top-level (possibly non-empty) directory, tolerate
// the path already being gone, and never throw for anything else missing.
import assert from "node:assert/strict";
import { removeEntryAtPath } from "../src/fs_helpers.js";

/* ---------- a minimal in-memory stand-in for FileSystemDirectoryHandle ---------- */
// Only what removeEntryAtPath's traversal needs: getDirectoryHandle and
// removeEntry. Built from a plain nested object, same convention as
// tests/test-docx-source-documents.mjs's fuller fixture.
function notFoundError() {
  const e = new Error("not found");
  e.name = "NotFoundError";
  return e;
}

function wrapDir(children) {
  return {
    async getDirectoryHandle(name, { create = false } = {}) {
      const child = children[name];
      if (!child || typeof child !== "object") {
        if (!create) throw notFoundError();
        children[name] = {};
        return wrapDir(children[name]);
      }
      return wrapDir(child);
    },
    async removeEntry(name) {
      if (!(name in children)) throw notFoundError();
      delete children[name];
    },
    has(name) { return name in children; },
  };
}

{
  const tree = { "ro-crate-metadata.json": true, other: { keep: true } };
  const root = wrapDir(tree);
  const removed = await removeEntryAtPath(root, "ro-crate-metadata.json");
  assert.equal(removed, true, "removing an existing top-level file should report true");
  assert.ok(!("ro-crate-metadata.json" in tree), "the file should be gone from the tree");
  assert.ok("other" in tree, "an unrelated sibling should be untouched");
}

{
  const tree = { "c2c-output": { "a.csv": true, "b.cha": true } };
  const root = wrapDir(tree);
  const removed = await removeEntryAtPath(root, "c2c-output");
  assert.equal(removed, true, "removing a non-empty top-level directory should report true");
  assert.ok(!("c2c-output" in tree), "the whole directory should be gone, contents included");
}

{
  const tree = {};
  const root = wrapDir(tree);
  const removed = await removeEntryAtPath(root, "ro-crate-preview.html");
  assert.equal(removed, false, "deleting something that was never there should report false, not throw");
}

{
  const tree = { "ro-crate-metadata.json": true };
  const root = wrapDir(tree);
  const removed = await removeEntryAtPath(root, "no-such-dir/nested.txt");
  assert.equal(removed, false, "a missing intermediate directory should report false, not throw");
  assert.ok("ro-crate-metadata.json" in tree, "an unrelated entry should be untouched");
}

console.log("test-fs-helpers: all tests passed");
