function normalizeQueryPart(value) {
  return String(value || "").trim().toLowerCase();
}

function queryParamsFromSearch(search) {
  const text = String(search || "");
  return new URLSearchParams(text.startsWith("?") ? text.slice(1) : text);
}

export function readExplicitProfileIdFromQuery(search) {
  const params = queryParamsFromSearch(search);
  for (const [key, value] of params) {
    if (normalizeQueryPart(key) !== "profile") continue;
    const trimmed = String(value || "").trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function matchForcedProfileIdFromQuery(search, knownProfileIds = []) {
  const byNormalizedId = new Map(
    (knownProfileIds || []).map((profileId) => [normalizeQueryPart(profileId), profileId])
  );
  if (!byNormalizedId.size) return null;

  const explicit = readExplicitProfileIdFromQuery(search);
  if (explicit) {
    const matched = byNormalizedId.get(normalizeQueryPart(explicit));
    if (matched) return matched;
  }

  const params = queryParamsFromSearch(search);
  for (const [key, value] of params) {
    for (const part of [key, value]) {
      const matched = byNormalizedId.get(normalizeQueryPart(part));
      if (matched) return matched;
    }
  }

  return null;
}

function findTopLevelOption(schema, key) {
  return (schema || []).find((opt) => opt && opt.key === key) || null;
}

function collectOptionKeys(opt, out) {
  if (!opt || !opt.key || out.has(opt.key)) return;
  out.add(opt.key);
  for (const child of opt.children || []) collectOptionKeys(child, out);
}

export function collectOptionSubtreeKeys(schema, topLevelKeys = []) {
  const out = new Set();
  for (const key of topLevelKeys || []) collectOptionKeys(findTopLevelOption(schema, key), out);
  return out;
}