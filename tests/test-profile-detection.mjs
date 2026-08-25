import assert from "node:assert/strict";
import {
  extractConformsToIds,
  buildConformsToProfileMap,
  matchProfileIdFromConformsTo,
  withPreferredIdsFirst,
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

/* ---------- withPreferredIdsFirst ---------- */

assert.deepEqual(
  withPreferredIdsFirst(["birds", "language-resources", "ldac", "structured-docs"], ["ldac"]),
  ["ldac", "birds", "language-resources", "structured-docs"],
  "the preferred id should move to the front, everything else keeping its relative order"
);
assert.deepEqual(
  withPreferredIdsFirst(["birds", "structured-docs"], ["ldac"]),
  ["birds", "structured-docs"],
  "a preferred id absent from the list should be a no-op, not throw or insert it"
);
assert.deepEqual(
  withPreferredIdsFirst(["a", "b", "c"], ["c", "a"]),
  ["c", "a", "b"],
  "multiple preferred ids should lead in the order `preferred` gives them"
);

/* ---------- the reported scenario: ldac should win over language-resources ---------- */
// Both declare the same LDAC Collection conformsTo — without the tie-break,
// buildConformsToProfileMap's first-registered-wins dedup resolves to
// whichever sorts first alphabetically (language-resources), which is what
// was actually observed and reported as surprising.

{
  const ids = ["birds", "language-resources", "ldac", "structured-docs"]; // loadAvailableProfileIds()'s alphabetical order
  const sharedConformsTo = "https://w3id.org/ldac/profile#Collection";
  const conformsToById = { "language-resources": sharedConformsTo, ldac: sharedConformsTo };

  const withoutTieBreak = buildConformsToProfileMap(ids.map((id) => ({ id, conformsTo: conformsToById[id] })));
  assert.equal(
    matchProfileIdFromConformsTo(sharedConformsTo, withoutTieBreak), "language-resources",
    "without a tie-break, alphabetical order resolves the shared conformsTo to language-resources"
  );

  const orderedIds = withPreferredIdsFirst(ids, ["ldac"]);
  const withTieBreak = buildConformsToProfileMap(orderedIds.map((id) => ({ id, conformsTo: conformsToById[id] })));
  assert.equal(
    matchProfileIdFromConformsTo(sharedConformsTo, withTieBreak), "ldac",
    "with the tie-break applied, the shared conformsTo should resolve to ldac instead"
  );
}

console.log("test-profile-detection: all tests passed");
