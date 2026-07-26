function normalizePlaceName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleCaseWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeCommonPlaceTypos(value) {
  return String(value || "")
    .replace(/\blsland\b/gi, "Island")
    .replace(/\blslands\b/gi, "Islands");
}

function placeNameVariants(placeName) {
  const start = titleCaseWords(normalizeCommonPlaceTypos(placeName));
  if (!start) return [];

  const seen = new Set();
  const queue = [start];
  const out = [];
  while (queue.length) {
    const current = queue.shift();
    const key = normalizePlaceName(current);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(current);

    const nextValues = [
      current.replace(/\bMt\.?\b/gi, "Mount"),
      current.replace(/\bMount\b/gi, "Mt"),
    ];

    const mountMatch = current.match(/^Mount\s+(.+)$/i);
    if (mountMatch?.[1]) nextValues.push(`${mountMatch[1]} Mountain`);

    const mountainMatch = current.match(/^(.+)\s+Mountain$/i);
    if (mountainMatch?.[1]) nextValues.push(`Mount ${mountainMatch[1]}`);

    nextValues
      .map(titleCaseWords)
      .filter(Boolean)
      .forEach((nextValue) => {
        if (!seen.has(normalizePlaceName(nextValue))) queue.push(nextValue);
      });
  }
  return out;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toWkt(longitude, latitude) {
  return `POINT(${longitude} ${latitude})`;
}

function coordinateRecord(value, provider, matchedName = "") {
  if (!value || typeof value !== "object") return null;
  const latitude = asNumber(value.latitude ?? value.lat ?? value.y ?? value[".latitude"]);
  const longitude = asNumber(value.longitude ?? value.lon ?? value.lng ?? value.long ?? value.x ?? value[".longitude"]);
  if (latitude === null || longitude === null) return null;
  return {
    matchedName: String(matchedName || value.name || value.placename || value.title || "").trim(),
    latitude,
    longitude,
    asWKT: typeof value.asWKT === "string" && value.asWKT.trim()
      ? value.asWKT.trim()
      : toWkt(longitude, latitude),
    provider,
  };
}

function flattenCandidates(payload, out = []) {
  if (!payload) return out;
  if (Array.isArray(payload)) {
    payload.forEach((item) => flattenCandidates(item, out));
    return out;
  }
  if (typeof payload !== "object") return out;

  if (payload.type === "Feature" && payload.geometry?.coordinates) {
    const [longitude, latitude] = payload.geometry.coordinates;
    out.push({
      ...payload.properties,
      longitude,
      latitude,
    });
    return out;
  }

  if (payload.attributes && typeof payload.attributes === "object") {
    const geometry = Array.isArray(payload.geometry?.coordinates)
      ? { longitude: payload.geometry.coordinates[0], latitude: payload.geometry.coordinates[1] }
      : {};
    out.push({
      ...payload.attributes,
      ...geometry,
    });
    return out;
  }

  if (Array.isArray(payload.features)) {
    payload.features.forEach((item) => flattenCandidates(item, out));
    return out;
  }

  if (Array.isArray(payload.results)) {
    payload.results.forEach((item) => flattenCandidates(item, out));
    return out;
  }

  if (Array.isArray(payload.items)) {
    payload.items.forEach((item) => flattenCandidates(item, out));
    return out;
  }

  out.push(payload);
  return out;
}

function rankCandidate(candidate, targetName) {
  const candidateName = normalizePlaceName(
    candidate.name ?? candidate.placename ?? candidate.place_name ?? candidate.title ?? candidate.preferredName ?? ""
  );
  if (!candidateName) return 0;
  if (candidateName === targetName) return 4;
  if (candidateName.startsWith(targetName) || targetName.startsWith(candidateName)) return 3;
  if (candidateName.includes(targetName) || targetName.includes(candidateName)) return 2;
  return 1;
}

function pickBestRecord(payload, provider, placeName) {
  const targetName = normalizePlaceName(placeName);
  const matches = flattenCandidates(payload)
    .map((candidate) => ({
      rank: rankCandidate(candidate, targetName),
      rec: coordinateRecord(candidate, provider, candidate.name ?? candidate.placename ?? candidate.title ?? ""),
    }))
    .filter((entry) => entry.rec);
  if (!matches.length) return null;
  matches.sort((a, b) => b.rank - a.rank);
  return matches[0].rec;
}

function createTimeoutSignal(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === "undefined") return { signal: undefined, cancel: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function manualLookup(records, placeName) {
  const key = normalizePlaceName(placeName);
  if (!key) return null;
  if (records instanceof Map) return records.get(key) || null;
  return null;
}

function buildManualRecords(rawRecords) {
  const out = new Map();
  if (!rawRecords) return out;

  const add = (name, value) => {
    const key = normalizePlaceName(name);
    const rec = coordinateRecord(value, "manual", name);
    if (key && rec) out.set(key, rec);
  };

  if (Array.isArray(rawRecords)) {
    rawRecords.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      add(entry.name, entry);
    });
    return out;
  }

  if (typeof rawRecords === "object") {
    Object.entries(rawRecords).forEach(([name, value]) => add(name, value));
  }
  return out;
}

async function fetchJson(url, timeoutMs) {
  if (typeof fetch !== "function") return null;
  const { signal, cancel } = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json, application/geo+json" },
      cache: "no-store",
      signal,
    });
    if (!res.ok) return null;
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("json")) return await res.json();
    const text = await res.text();
    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    cancel();
  }
}

function escapeWhereLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

async function lookupViaGhap(placeName, options) {
  const baseUrl = String(options?.url || "https://placenames.ghaap.org/api/placename/").trim();
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  url.searchParams.set(String(options?.queryParam || "search"), placeName);
  const payload = await fetchJson(url, options?.timeoutMs || 2500);
  return pickBestRecord(payload, "ghap", placeName);
}

async function lookupViaGeoscienceAustralia(placeName, options) {
  const baseUrl = String(
    options?.url || "https://services.ga.gov.au/gis/rest/services/Composite_Gazetteer_of_Australia/MapServer/0/query"
  ).trim();
  if (!baseUrl) return null;
  const exactUrl = new URL(baseUrl);
  exactUrl.searchParams.set("where", `upper(name) = upper('${escapeWhereLiteral(placeName)}')`);
  exactUrl.searchParams.set("outFields", String(options?.outFields || "id,name,feature,category,theme,latitude,longitude,authority"));
  exactUrl.searchParams.set("returnGeometry", String(options?.returnGeometry || "false"));
  exactUrl.searchParams.set("f", String(options?.format || "pjson"));
  const exactPayload = await fetchJson(exactUrl, options?.timeoutMs || 2500);
  let match = pickBestRecord(exactPayload, "geoscience-australia", placeName);
  if (match || options?.exactOnly) return match;

  const fuzzyUrl = new URL(baseUrl);
  fuzzyUrl.searchParams.set("where", `upper(name) like upper('${escapeWhereLiteral(placeName)}%')`);
  fuzzyUrl.searchParams.set("outFields", String(options?.outFields || "id,name,feature,category,theme,latitude,longitude,authority"));
  fuzzyUrl.searchParams.set("returnGeometry", String(options?.returnGeometry || "false"));
  fuzzyUrl.searchParams.set("f", String(options?.format || "pjson"));
  const payload = await fetchJson(fuzzyUrl, options?.timeoutMs || 2500);
  return pickBestRecord(payload, "geoscience-australia", placeName);
}

export function createPlaceLookupService(options = {}, log = () => {}) {
  const settings = options && typeof options === "object" ? options : {};
  const enabled = settings.enabled !== false;
  const providers = Array.isArray(settings.providers) && settings.providers.length
    ? settings.providers
    : ["geoscience-australia", "ghap"];
  const manualRecords = buildManualRecords(settings.records || settings.cache);
  const resultCache = new Map();

  return {
    async lookup(placeName) {
      const key = normalizePlaceName(placeName);
      if (!key || !enabled) return null;
      if (resultCache.has(key)) return resultCache.get(key);

      const variants = placeNameVariants(placeName);

      for (const variant of variants) {
        const manual = manualLookup(manualRecords, variant);
        if (manual) {
          resultCache.set(key, manual);
          return manual;
        }
      }

      let match = null;
      for (const variant of variants) {
        for (const provider of providers) {
          if (provider === "ghap") match = await lookupViaGhap(variant, settings.ghap);
          else if (provider === "geoscience-australia") match = await lookupViaGeoscienceAustralia(variant, settings.geoscienceAustralia);
          if (match) break;
        }
        if (match) break;
      }

      if (!match && providers.length) log(`Place lookup: no coordinates found for "${placeName}".`, "muted");
      resultCache.set(key, match);
      return match;
    },
  };
}