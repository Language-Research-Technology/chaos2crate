// Crate assembly + output generation, ported from corpus-tools-dyirbal's
// index.js to use the ro-crate library directly (as the original does), plus
// xlsx (ro-crate-excel) and html (ro-crate-static-site) generation.
//
// This module is ISOMORPHIC: it imports only browser-safe entry points
// (ro-crate, ro-crate-static-site, and ro-crate-excel's lib/workbook.js — which
// avoids that package's Node-only shelljs/fs-extra modules), and returns bytes
// / strings rather than writing files. The caller (browser or Node) does I/O.

import { ROCrate } from "ro-crate";
import { renderSinglePage, renderTemplate, roCrateToJSON } from "ro-crate-static-site";
import Workbook from "ro-crate-excel/lib/workbook.js";
import ExcelJS from "exceljs";
import { CUSTOM_PROPERTIES } from "./defaults.js";
import { DEFAULT_LAYOUT } from "./default_layout.js";
import { createPlaceLookupService } from "./place_lookup.js";

/* Files that are generated output or local control files — never treated as
 * corpus data (mirrors GENERATED_FILENAMES in the original). */
export const GENERATED_FILENAMES = new Set([
  "ro-crate-metadata.json", "ro-crate-metadata.jsonld", "ro-crate-metadata.xlsx", "ro-crate-preview.html",
]);
export const CONTROL_FILENAMES = new Set(["config.json", "sample-data.json"]);

/* ---------- path + name helpers (relative paths use "/" separators) ---------- */
function pBasename(p) { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }
function pStripExt(name) { const b = pBasename(name); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; }
function pDirname(p) { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(0, i) : ""; }
function sanitizeUrl(rel) { return rel.replace(/ /g, "_"); }
function sanitizePathSegment(rel) { return sanitizeUrl(rel).replace(/\//g, "_"); }
function normalizeName(fileName) {
  return pStripExt(fileName).toLowerCase()
    .replace(/\b(copy|duplicate)\b/g, "")
    .replace(/\(\d+\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ---------- per-file metadata (folder grouping + duplicate detection) ---------- */
export function buildFileMetadata(files) {
  const filesWithMeta = files.map((file) => {
    const folders = pDirname(file.relativePath).split("/").filter((p) => p !== "" && p !== ".");
    const topLevelName = folders.length > 0 ? folders[0] : pStripExt(file.fileName);
    return {
      ...file,
      id: file.relativePath,
      folders,
      topLevelName,
      isPartOfId: `#${sanitizeUrl(topLevelName)}`,
      isPartOfName: topLevelName,
    };
  });
  const groups = new Map();
  filesWithMeta.forEach((f) => {
    const key = normalizeName(f.fileName);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  });
  filesWithMeta.forEach((f) => {
    const group = groups.get(normalizeName(f.fileName));
    f.possibleDuplicates = group.filter((o) => o !== f).map((o) => o.id);
  });
  return filesWithMeta;
}

/* ---------- entity builders (using the ROCrate library) ---------- */
function addSampleData(crate, sampleData) {
  [...(sampleData.people || []), ...(sampleData.places || []), ...(sampleData.localities || [])]
    .forEach((entity) => crate.addEntity(entity));
}

function rootDatasetLicenseRefs(crate) {
  return crate.rootDataset.license?.length
    ? { license: crate.rootDataset.license.map((license) => ({ "@id": license["@id"] })) }
    : {};
}

function addFolderEntities(crate, filesWithMeta, opts = {}) {
  const topLevelFolderType = opts.topLevelFolderType === "collection" ? "collection" : "object";
  const folderGroups = new Map();
  filesWithMeta.forEach((file) => {
    if (!folderGroups.has(file.isPartOfId)) folderGroups.set(file.isPartOfId, { name: file.isPartOfName, fileIds: [] });
    folderGroups.get(file.isPartOfId).fileIds.push(file.id);
  });

  const memberIds = [];
  folderGroups.forEach((group, id) => {
    const groupFiles = filesWithMeta.filter((file) => file.isPartOfId === id);
    const hasTopLevelFolder = groupFiles.some((file) => file.folders.length > 0);

    if (topLevelFolderType === "collection" && hasTopLevelFolder) {
      const topLevelSegment = sanitizePathSegment(group.name);
      const nestedObjectIds = [];
      const nestedGroups = new Map();
      const directFileIds = [];

      groupFiles.forEach((file) => {
        if (file.folders.length <= 1) {
          directFileIds.push(file.id);
          return;
        }
        const childFolder = file.folders[1];
        if (!nestedGroups.has(childFolder)) nestedGroups.set(childFolder, []);
        nestedGroups.get(childFolder).push(file.id);
      });

      nestedGroups.forEach((fileIds, childFolder) => {
        const childId = `#${topLevelSegment}/${sanitizePathSegment(childFolder)}`;
        nestedObjectIds.push(childId);
        crate.addEntity({
          "@id": childId,
          "@type": "RepositoryObject",
          conformsTo: { "@id": "https://w3id.org/ldac/profile#Object" },
          name: childFolder,
          description: "",
          datePublished: "",
          "pcdm:memberOf": { "@id": id },
          ...rootDatasetLicenseRefs(crate),
          hasPart: fileIds.map((fileId) => ({ "@id": fileId })),
        });
        groupFiles
          .filter((file) => file.folders[1] === childFolder)
          .forEach((file) => { file.isPartOfId = childId; });
      });

      if (directFileIds.length) {
        const filesObjectName = `${group.name}_Files`;
        const filesObjectId = `#${topLevelSegment}/${sanitizePathSegment(filesObjectName)}`;
        nestedObjectIds.push(filesObjectId);
        crate.addEntity({
          "@id": filesObjectId,
          "@type": "RepositoryObject",
          conformsTo: { "@id": "https://w3id.org/ldac/profile#Object" },
          name: filesObjectName,
          description: "",
          datePublished: "",
          "pcdm:memberOf": { "@id": id },
          ...rootDatasetLicenseRefs(crate),
          hasPart: directFileIds.map((fileId) => ({ "@id": fileId })),
        });
        groupFiles
          .filter((file) => file.folders.length <= 1)
          .forEach((file) => { file.isPartOfId = filesObjectId; });
      }

      crate.addEntity({
        "@id": id,
        "@type": "RepositoryCollection",
        conformsTo: { "@id": "https://w3id.org/ldac/profile#Collection" },
        name: group.name,
        description: "",
        datePublished: "",
        ...rootDatasetLicenseRefs(crate),
        ...(nestedObjectIds.length ? { "pcdm:hasMember": nestedObjectIds.map((nestedId) => ({ "@id": nestedId })) } : {}),
      });
      memberIds.push(id);
      return;
    }

    crate.addEntity({
      "@id": id,
      "@type": "RepositoryObject",
      conformsTo: { "@id": "https://w3id.org/ldac/profile#Object" },
      name: group.name,
      description: "",
      datePublished: "",
      ...rootDatasetLicenseRefs(crate),
      hasPart: group.fileIds.map((fileId) => ({ "@id": fileId })),
    });
    memberIds.push(id);
  });
  crate.rootDataset["pcdm:hasMember"] = memberIds.map((memberId) => ({ "@id": memberId }));
}

function addFileEntities(crate, filesWithMeta, langByIndex) {
  filesWithMeta.forEach((file, index) => {
    const matched = langByIndex ? langByIndex[index].matchedLanguages : [];
    crate.addEntity({
      "@id": file.id,
      "@type": "File",
      name: file.fileName,
      description: "",
      datePublished: "",
      "custom:participant": "",
      "custom:compiler": "",
      contentLocation: "",
      isPartOf: { "@id": file.isPartOfId },
      ...(file.possibleDuplicates.length
        ? { "custom:possibleDuplicate": file.possibleDuplicates.map((id) => ({ "@id": id })) }
        : {}),
      ...(matched.length
        ? { "ldac:subjectLanguage": matched.map((l) => ({ "@id": l["@id"] })) }
        : {}),
    });
  });
}

function addLanguageEntities(crate, langByIndex) {
  const identified = new Map();
  langByIndex.forEach((r) => r.matchedLanguages.forEach((l) => identified.set(l["@id"], l)));
  identified.forEach((language) => {
    crate.addEntity(language);
    if (language.geo) crate.addEntity(language.geo);
  });
  return identified.size;
}

/* Rewrite hash @ids of RepositoryObject entities to arcp form, and every
 * reference to them across the graph (mirrors rewriteHashIdsForExport). */
function rewriteHashIdsForExport(crate) {
  const datasetId = String(crate.rootDataset["@id"] || "").trim();
  if (!datasetId) return;
  const arcpBase = `${datasetId}/`;
  const idMap = new Map();
  crate.graph.forEach((entity) => {
    const types = Array.isArray(entity?.["@type"]) ? entity["@type"] : [entity?.["@type"]];
    const oldId = entity?.["@id"];
    if ((types.includes("RepositoryObject") || types.includes("RepositoryCollection"))
      && typeof oldId === "string" && oldId.startsWith("#")) {
      idMap.set(oldId, `${arcpBase}${oldId.slice(1)}`);
    }
  });
  if (!idMap.size) return;
  const seen = new WeakSet();
  (function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value["@id"] === "string" && idMap.has(value["@id"])) value["@id"] = idMap.get(value["@id"]);
    Object.keys(value).forEach((k) => visit(value[k]));
  })(crate.graph);
}

// Load an existing ro-crate-metadata.json (plain object) into a live, mutable
// ROCrate instance — used by the Edit view to read/write entities directly
// (same config the rest of this module already relies on: array-valued
// properties, and reference objects resolved to their linked entity).
export function loadCrateFromJson(json) {
  return new ROCrate(json, { array: true, link: true });
}

/* ---------- top-level: build the ROCrate ---------- */
export function buildCrate(filesWithMeta, config, sampleData, langByIndex, log = () => {}, opts = {}) {
  const includeSampleData = opts.includeSampleData !== false;
  const crate = new ROCrate({ array: true, link: true });
  crate.addContext({ ldac: "https://w3id.org/ldac/terms#" });
  crate.addContext({ pcdm: "http://pcdm.org/models#" });
  crate.addContext({ custom: "arcp://name,custom/terms#" });
  crate.addContext({ AUSTLANG: "https://collection.aiatsis.gov.au/austlang/language/" });

  Object.assign(crate.rootDataset, config.rootDataset);
  if (typeof crate.rootDataset["@id"] === "string" && crate.rootDataset["@id"].trim()) {
    crate.descriptor.about = { "@id": crate.rootDataset["@id"] };
  }
  if (config.metadataLicence?.["@id"]) {
    crate.descriptor.license = { "@id": config.metadataLicence["@id"] };
    crate.addEntity(config.metadataLicence);
  }

  if (includeSampleData) {
    for (const p of CUSTOM_PROPERTIES) crate.addEntity(p);
    if (sampleData) {
      addSampleData(crate, sampleData);
    }
  }
  addFolderEntities(crate, filesWithMeta, opts);
  addFileEntities(crate, filesWithMeta, langByIndex);
  if (langByIndex) {
    const n = addLanguageEntities(crate, langByIndex);
    log(`Identified ${n} unique language(s).`, n ? "ok" : "muted");
  }
  rewriteHashIdsForExport(crate);
  return crate;
}

/* ---------- output generators ---------- */
export function crateToJsonString(crate) {
  return JSON.stringify(crate.getJson(), null, 2);
}

// Returns bytes for ro-crate-metadata.xlsx (Uint8Array in browser, Buffer in Node).
export async function crateToXlsxBytes(crate) {
  const workbook = new Workbook({ crate });
  await workbook.crateToWorkbook();
  return workbook.workbook.xlsx.writeBuffer();
}

// Returns the ro-crate-preview.html string.
//
// Two modes:
//  - Plain (default): the precompiled single-page template via renderSinglePage.
//    A bundled `layouts` object is passed so the library does NOT fetch its
//    default layout from GitHub at runtime (fragile + CORS-blocked in browser).
//  - Styled: pass opts.template (a template string, e.g. the tabular template),
//    opts.config (a preview config object: propertyGroups, settings,
//    navigationByType, termMapping, footer…), and opts.css (a stylesheet string).
//    Rendered via roCrateToJSON + renderTemplate, exactly as the CLI does.
export async function crateToPreviewHtml(crate, opts = {}) {
  const { layouts = { default: DEFAULT_LAYOUT }, template = null, config = null, css = "" } = opts;
  expandCompactPropertiesForRender(crate);
  let html;
  if (template) {
    const cfg = config || {};
    const layout = (Array.isArray(cfg.propertyGroups) && cfg.propertyGroups.length)
      ? cfg.propertyGroups : DEFAULT_LAYOUT;
    const data = await roCrateToJSON(crate, cfg, layout);
    data.cratePath = "";
    data.layout = layout;
    data.hasLayout = true;
    html = await renderTemplate({ data, template, config: { ...cfg, propertyGroups: layout }, css, layout });
  } else {
    html = await renderSinglePage({ crate, layouts });
  }
  // ro-crate-static-site urlencodes file links wholesale, turning "/" into "%2F"
  // and breaking relative navigation; only href values (not "#" anchors) are real links.
  html = html.replace(/href="([^"#][^"]*)"/g, (match, href) =>
    href.includes("%2F") ? `href="${href.replace(/%2F/g, "/")}"` : match
  );
  return html;
}

function contextPrefixMap(crate) {
  const out = new Map();
  const ctx = crate.getJson()["@context"];
  const collect = (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    Object.entries(entry).forEach(([k, v]) => {
      if (typeof v !== "string") return;
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(k)) return;
      if (!/^(https?:|urn:|arcp:)/i.test(v)) return;
      out.set(k, v);
    });
  };
  if (Array.isArray(ctx)) ctx.forEach(collect);
  else collect(ctx);
  return out;
}

// Some merges write compact predicates (e.g. "dc:format"); the tabular
// renderer often resolves by full URI. Mirror compact keys to full URI keys so
// rendering can find values regardless of key form.
function expandCompactPropertiesForRender(crate) {
  const prefixes = contextPrefixMap(crate);
  if (!prefixes.size) return;

  crate.graph.forEach((entity) => {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) return;
    Object.keys(entity).forEach((key) => {
      if (!key || key.startsWith("@") || key.includes("://")) return;
      const i = key.indexOf(":");
      if (i <= 0) return;
      const prefix = key.slice(0, i);
      const local = key.slice(i + 1);
      if (!local) return;
      const base = prefixes.get(prefix);
      if (!base) return;
      const full = `${base}${local}`;
      if (entity[full] === undefined) entity[full] = entity[key];
    });
  });
}

/* ---------- spreadsheet merge (ported from corpus-tools-dyirbal/merge.js) ---------- */

// ExcelJS cell values can be plain scalars or rich objects (formula results,
// rich text, hyperlinks); normalise to a plain string.
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (v.result !== undefined) return String(v.result);
    if (v.hyperlink && v.text) return String(v.text);
    return "";
  }
  return String(v);
}

// Read workbook sheet names plus the header row from a selected sheet
// (defaulting to the first sheet). Used by the merge-mapping builder UI.
export async function readXlsxHeaders(xlsxData, preferredSheetName = "") {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxData);
  if (!wb.worksheets.length) throw new Error("The spreadsheet has no worksheets");
  const sheetNames = wb.worksheets.map((ws) => ws.name);
  const wanted = String(preferredSheetName || "").trim();
  const sheet = wanted ? wb.getWorksheet(wanted) : wb.worksheets[0];
  if (!sheet) throw new Error(`Sheet "${wanted}" not found in the workbook`);
  let headers = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) headers = row.values.slice(1).map(cellText);
  });
  return { sheetName: sheet.name, sheetNames, headers };
}

// Read prefix->URI context definitions found anywhere in a workbook.
// Used by the mapping UI to warn about unresolved prefixed targets.
export async function readXlsxContextPrefixes(xlsxData) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxData);
  if (!wb.worksheets.length) throw new Error("The spreadsheet has no worksheets");
  return scanWorkbookContexts(wb);
}

// "custom:" is this app's own made-up namespace (arcp://name,custom/terms#) —
// unlike "ldac:", which is a real published vocabulary, nothing external
// defines what a custom: property means. Turns "dateCaptured" into
// "Date Captured" for a generated rdf:Property's name.
const CUSTOM_PROPERTY_PREFIX = "custom:";
const CUSTOM_PROPERTY_BASE = "arcp://name,custom/terms#";
function prettifyPropertyLocalName(localName) {
  return localName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function getTargetPrefix(term) {
  const t = String(term || "").trim();
  if (!t || t.includes("://")) return "";
  const i = t.indexOf(":");
  if (i <= 0) return "";
  const prefix = t.slice(0, i);
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(prefix) ? prefix : "";
}

function normalizePrefixKey(raw) {
  const key = String(raw || "").trim().replace(/:$/, "");
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(key) ? key : "";
}

function isLikelyContextUri(value) {
  return /^(https?:|urn:|arcp:)/i.test(String(value || "").trim());
}

function addParsedContextEntries(raw, outMap) {
  if (!raw) return;
  if (Array.isArray(raw)) {
    raw.forEach((entry) => addParsedContextEntries(entry, outMap));
    return;
  }
  if (typeof raw !== "object") return;
  Object.entries(raw).forEach(([k, v]) => {
    const prefix = normalizePrefixKey(k);
    if (!prefix || typeof v !== "string") return;
    const uri = v.trim();
    if (!isLikelyContextUri(uri)) return;
    if (!outMap.has(prefix)) outMap.set(prefix, uri);
  });
}

function parseContextCellValue(value, outMap) {
  const text = cellText(value).trim();
  if (!text) return;
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      addParsedContextEntries(JSON.parse(text), outMap);
      return;
    } catch {
      return;
    }
  }
}

function scanWorkbookContexts(workbook) {
  const contexts = new Map();
  workbook.worksheets.forEach((ws) => {
    let headers = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        headers = row.values.slice(1).map((v) => String(cellText(v)).trim());
        return;
      }

      // Generic key/value rows (prefix in col A, URI in col B), with or without headers.
      const a = cellText(row.getCell(1).value).trim();
      const b = cellText(row.getCell(2).value).trim();
      const prefA = normalizePrefixKey(a);
      if (prefA && isLikelyContextUri(b) && !contexts.has(prefA)) contexts.set(prefA, b);

      // A row like @context | { ...json... }.
      if (a === "@context") parseContextCellValue(row.getCell(2).value, contexts);

      if (!headers.length) return;

      // Column named @context containing JSON object/array values.
      const contextCol = headers.indexOf("@context");
      if (contextCol !== -1) parseContextCellValue(row.getCell(contextCol + 1).value, contexts);

      // Prefix table columns such as prefix + uri/namespace/context/@id.
      const prefixCol = headers.findIndex((h) => /^(prefix|term)$/i.test(h));
      const uriCol = headers.findIndex((h) => /^(uri|namespace|context|@id|iri)$/i.test(h));
      if (prefixCol !== -1 && uriCol !== -1) {
        const pref = normalizePrefixKey(cellText(row.getCell(prefixCol + 1).value));
        const uri = cellText(row.getCell(uriCol + 1).value).trim();
        if (pref && isLikelyContextUri(uri) && !contexts.has(pref)) contexts.set(pref, uri);
      }
    });
  });
  return contexts;
}

function getExistingContextPrefixes(crate) {
  const prefixes = new Set();
  const ctx = crate.getJson()["@context"];
  const collect = (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    Object.keys(entry).forEach((k) => {
      const p = normalizePrefixKey(k);
      if (p) prefixes.add(p);
    });
  };
  if (Array.isArray(ctx)) ctx.forEach(collect);
  else collect(ctx);
  return prefixes;
}

function slugifyEntityValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generatedEntityId(type, value) {
  const slug = slugifyEntityValue(value).replace(/-/g, "_") || "entity";
  if (type === "Place") return `#place-${slugifyEntityValue(value) || "place"}`;
  return `#${slug}`;
}

function generatedGeometryId(placeEntity, placeName) {
  const explicit = String(placeEntity?.geo?.["@id"] || "").trim();
  if (explicit) return explicit;
  const placeId = String(placeEntity?.["@id"] || "").trim();
  if (placeId.startsWith("#place-")) return `#location-${placeId.slice("#place-".length)}`;
  const slug = slugifyEntityValue(placeName || placeId.replace(/^#/, "")) || "place";
  return `#location-${slug}`;
}

function graphEntityById(crate, id) {
  return crate.graph.find((entity) => entity && entity["@id"] === id) || null;
}

// Merge a spreadsheet's rows into matching crate entities (by an "@id" column),
// applying the config's column→property mappings. Typed mappings split on comma
// or slash and generate linked entities. Any "custom:" target property that's
// actually used but has no rdf:Property entity yet (the hand-written ones in
// defaults.js, or a prior merge) gets a minimal one generated so it's not left
// undocumented in the graph. Mutates `crate` in place; returns stats.
export async function mergeXlsxIntoCrate(crate, xlsxData, mergeConfig, log = () => {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxData);

  let sheet;
  if (wb.worksheets.length > 1) {
    sheet = mergeConfig.sheet ? wb.getWorksheet(mergeConfig.sheet) : wb.worksheets[0];
    if (!sheet) throw new Error(`Sheet "${mergeConfig.sheet}" not found in the workbook`);
  } else {
    sheet = wb.worksheets[0];
  }
  if (!sheet) throw new Error("The spreadsheet has no worksheets");

  const headers = [];
  const dataRows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) headers.push(...row.values.slice(1).map(cellText));
    else if (row.values.length > 1) dataRows.push(row.values.slice(1));
  });

  const idCol = headers.indexOf("@id");
  if (idCol === -1) throw new Error('The spreadsheet needs an "@id" column');

  const entityById = new Map();
  crate.graph.forEach((e) => { if (e["@id"]) entityById.set(e["@id"], e); });

  const mappings = Array.isArray(mergeConfig.mapping) ? mergeConfig.mapping : [];
  const requiredPrefixes = new Set(
    mappings.map((m) => getTargetPrefix(m && m.target)).filter(Boolean)
  );
  const workbookContexts = scanWorkbookContexts(wb);
  const existingPrefixes = getExistingContextPrefixes(crate);
  const addedContexts = [];
  const placeLookupConfig = {
    ...(mergeConfig && typeof mergeConfig.placeLookup === "object" ? mergeConfig.placeLookup : {}),
  };
  if (mergeConfig && typeof mergeConfig.placeMatchRegion === "string" && mergeConfig.placeMatchRegion.trim()) {
    placeLookupConfig.placeMatchRegion = placeLookupConfig.placeMatchRegion || mergeConfig.placeMatchRegion.trim();
  }
  const placeLookup = createPlaceLookupService(placeLookupConfig, log);
  requiredPrefixes.forEach((prefix) => {
    if (existingPrefixes.has(prefix)) return;
    const uri = workbookContexts.get(prefix);
    if (!uri) return;
    crate.addContext({ [prefix]: uri });
    existingPrefixes.add(prefix);
    addedContexts.push(`${prefix}: ${uri}`);
  });

  let merged = 0, generated = 0, enrichedPlaces = 0;
  const missingCols = new Set();
  const matchedIds = new Set();   // entity @ids that a spreadsheet row matched
  const unmatchedRowIds = [];     // spreadsheet @ids with no matching entity
  const usedCustomProps = new Set(); // "custom:" target properties actually written

  for (const row of dataRows) {
    const entityId = cellText(row[idCol]).trim();
    if (!entityId) continue;
    const entity = entityById.get(entityId);
    if (!entity) { unmatchedRowIds.push(entityId); continue; }
    matchedIds.add(entityId);

    for (const mapping of mappings) {
      const col = headers.indexOf(mapping.source);
      if (col === -1) { missingCols.add(mapping.source); continue; }
      const value = cellText(row[col]).trim();
      if (!value) continue;

      if (mapping.type) {
        const values = value
          .split(/\s*[,/]\s*/).map((v) => v.trim()).filter(Boolean)
          .map((v) => v.replace(/[\[\]?()']/g, "").trim()).filter(Boolean);
        if (!values.length) continue;
        const refs = [];
        for (const val of values) {
          const id = generatedEntityId(mapping.type, val);
          if (!entityById.get(id)) {
            const ge = { "@id": id, "@type": mapping.type, name: val };
            crate.addEntity(ge);
            entityById.set(id, graphEntityById(crate, id) || ge);
            generated++;
          }
          if (mapping.type === "Place") {
            const placeNode = graphEntityById(crate, id) || entityById.get(id);
            const lookup = await placeLookup.lookup(val || placeNode?.name || "");
            if (lookup) {
              const geometryId = generatedGeometryId(placeNode || { "@id": id }, val);
              let geometryNode = graphEntityById(crate, geometryId) || entityById.get(geometryId);
              const hadGeo = !!placeNode?.geo?.["@id"];
              if (!geometryNode) {
                const geometryRecord = {
                  "@id": geometryId,
                  "@type": "Geometry",
                  ".latitude": lookup.latitude,
                  ".longitude": lookup.longitude,
                  asWKT: lookup.asWKT,
                };
                crate.addEntity(geometryRecord);
                geometryNode = graphEntityById(crate, geometryId) || geometryRecord;
                entityById.set(geometryId, geometryNode);
                generated++;
              } else {
                geometryNode["@type"] = geometryNode["@type"] || "Geometry";
                geometryNode[".latitude"] = lookup.latitude;
                geometryNode[".longitude"] = lookup.longitude;
                geometryNode.asWKT = lookup.asWKT;
              }
              if (placeNode) {
                placeNode.geo = { "@id": geometryId };
                if (!hadGeo) enrichedPlaces++;
              }
            }
          }
          refs.push({ "@id": id });
        }
        entity[mapping.target] = refs.length === 1 ? refs[0] : refs;
        merged++;
      } else {
        entity[mapping.target] = value;
        merged++;
      }
      if (mapping.target.startsWith(CUSTOM_PROPERTY_PREFIX)) usedCustomProps.add(mapping.target);
    }
  }

  const generatedProps = [];
  usedCustomProps.forEach((target) => {
    const id = CUSTOM_PROPERTY_BASE + target.slice(CUSTOM_PROPERTY_PREFIX.length);
    if (crate.hasEntity(id)) return;
    crate.addEntity({ "@id": id, "@type": "rdf:Property", name: prettifyPropertyLocalName(target.slice(CUSTOM_PROPERTY_PREFIX.length)), description: "" });
    generatedProps.push(target);
  });

  // File entities in the crate that no spreadsheet row matched (by exact @id) —
  // these get no merged metadata (e.g. no encodingFormat). Usually a path/name
  // mismatch between the folder and the spreadsheet's @id column.
  const isFile = (e) => { const t = e["@type"]; return Array.isArray(t) ? t.includes("File") : t === "File"; };
  const unmatchedFiles = crate.graph.filter((e) => isFile(e) && e["@id"] && !matchedIds.has(e["@id"])).map((e) => e["@id"]);

  const sample = (arr, n = 12) => arr.slice(0, n).map((s) => `\n    • ${s}`).join("") + (arr.length > n ? `\n    …and ${arr.length - n} more` : "");

  if (missingCols.size) log(`Merge: columns not in spreadsheet, skipped: ${[...missingCols].join(", ")}.`, "warn");
  if (unmatchedFiles.length)
    log(`Merge: ${unmatchedFiles.length} file(s) had NO matching spreadsheet row — no metadata merged (check the @id path):${sample(unmatchedFiles)}`, "warn");
  if (unmatchedRowIds.length)
    log(`Merge: ${unmatchedRowIds.length} spreadsheet row(s) matched no entity in the crate:${sample(unmatchedRowIds)}`, "warn");
  if (addedContexts.length)
    log(`Merge: added ${addedContexts.length} missing context prefix(es) from workbook: ${addedContexts.join(", ")}.`, "ok");
  const unresolvedPrefixes = [...requiredPrefixes].filter((p) => !existingPrefixes.has(p));
  if (unresolvedPrefixes.length)
    log(`Merge: no matching context found in workbook for prefix(es): ${unresolvedPrefixes.join(", ")}.`, "warn");
  if (generatedProps.length)
    log(`Merge: generated rdf:Property definitions for ${generatedProps.length} custom propert${generatedProps.length === 1 ? "y" : "ies"} not yet described in the crate: ${generatedProps.sort().join(", ")}.`, "ok");
  if (enrichedPlaces)
    log(`Merge: added Geometry coordinates for ${enrichedPlaces} place reference${enrichedPlaces === 1 ? "" : "s"}.`, "ok");
  log(`Merged ${merged} value(s) from "${sheet.name}" into ${matchedIds.size} entity/ies; generated ${generated} new entity/ies.`, "ok");
  return {
    merged,
    generated,
    enrichedPlaces,
    generatedProperties: generatedProps.length,
    addedContexts: addedContexts.length,
    skipped: unmatchedRowIds.length,
    unmatchedFiles: unmatchedFiles.length,
    sheet: sheet.name,
  };
}
