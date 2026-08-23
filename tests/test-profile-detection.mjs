import assert from "node:assert/strict";
import {
  extractConformsToIds,
  buildConformsToProfileMap,
  matchProfileIdFromConformsTo,
} from "../src/profile_detection.js";

/* ---------- extractConformsToIds: normalizes every valid shape ---------- */

assert.deepEqual(extractConformsToIds(undefined), []);
assert.deepEqual(extractConformsToIds(null), []);
assert.deepEqual(extractConformsToIds("https://example.org/a"), ["https://example.org/a"]);
assert.deepEqual(extractConformsToIds({ "@id": "https://example.org/a" }), ["https://example.org/a"]);
assert.deepEqual(
  extractConformsToIds(["https://example.org/a", { "@id": "https://example.org/b" }]),
  ["https://example.org/a", "https://example.org/b"],
  "a mixed array of bare strings and {@id} refs should all normalize"
);
assert.deepEqual(
  extractConformsToIds([{ "@id": "https://example.org/a" }, {}, { name: "no @id here" }]),
  ["https://example.org/a"],
  "entries with no usable @id should be dropped, not throw"
);

/* ---------- buildConformsToProfileMap: dedup, first-registered wins ---------- */

{
  const map = buildConformsToProfileMap([
    { id: "profile-a", conformsTo: "https://example.org/a" },
    { id: "profile-b", conformsTo: "https://example.org/b" },
    { id: "profile-a-dup", conformsTo: "https://example.org/a" },
    { id: "profile-c", conformsTo: undefined },
    { id: "profile-d" },
  ]);
  assert.equal(map.get("https://example.org/a"), "profile-a", "the first entry for a conformsTo should win over a later duplicate");
  assert.equal(map.get("https://example.org/b"), "profile-b");
  assert.equal(map.size, 2, "entries with no usable conformsTo should not appear in the map at all");
}

/* ---------- matchProfileIdFromConformsTo ---------- */

{
  const map = buildConformsToProfileMap([{ id: "ldac", conformsTo: "https://w3id.org/ldac/profile" }]);
  assert.equal(matchProfileIdFromConformsTo("https://w3id.org/ldac/profile", map), "ldac", "a bare-string conformsTo should match");
  assert.equal(matchProfileIdFromConformsTo({ "@id": "https://w3id.org/ldac/profile" }, map), "ldac", "a {@id} ref should match");
  assert.equal(matchProfileIdFromConformsTo("https://example.org/unknown", map), null, "an unrecognized conformsTo should return null, not throw");
  assert.equal(matchProfileIdFromConformsTo(undefined, map), null);
  assert.equal(
    matchProfileIdFromConformsTo(["https://example.org/unknown", { "@id": "https://w3id.org/ldac/profile" }], map),
    "ldac",
    "with multiple conformsTo values, the first one that matches a known profile should win"
  );
}

console.log("test-profile-detection: all tests passed");
