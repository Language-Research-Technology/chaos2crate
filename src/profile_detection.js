// Pure helpers for identifying which profile built an existing RO-Crate, by
// matching its root dataset's conformsTo against every known profile's own
// declared conformsTo (see main.js's processFolder, which copies a profile's
// rootDataset.conformsTo onto every crate it builds). Kept separate from
// main.js — which owns the actual GitHub fetching and dirHandle plumbing —
// so the matching itself can be unit tested without mocking network calls.

// A root dataset's conformsTo may be a bare string, a single {"@id":...}
// reference, or (uncommon but valid RO-Crate/JSON-LD) an array of either —
// normalizes all three shapes to a flat list of URI strings.
export function extractConformsToIds(value) {
  const arr = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return arr
    .map((v) => (typeof v === "string" ? v : (v && typeof v["@id"] === "string" ? v["@id"] : null)))
    .filter(Boolean);
}

// Builds a conformsTo -> profileId lookup from { id, conformsTo } entries —
// one per known profile, each carrying whatever its own mode file declared
// under rootDataset.conformsTo (or undefined/non-string if it declared
// none, or the fetch for it failed). First entry for a given conformsTo
// wins, matching composeOutputPaths()'s dedup-by-first-registered
// convention in src/plugins/index.js.
export function buildConformsToProfileMap(entries) {
  const map = new Map();
  for (const { id, conformsTo } of entries) {
    if (typeof conformsTo === "string" && conformsTo && !map.has(conformsTo)) map.set(conformsTo, id);
  }
  return map;
}

// Matches a root dataset's conformsTo value against the map. A root can
// (rarely) declare more than one conformsTo, so the first one that matches
// a known profile wins; returns null if none do.
export function matchProfileIdFromConformsTo(conformsToValue, conformsToProfileIdMap) {
  for (const id of extractConformsToIds(conformsToValue)) {
    const profileId = conformsToProfileIdMap.get(id);
    if (profileId) return profileId;
  }
  return null;
}
