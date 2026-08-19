// Crate assembly + output generation, ported from corpus-tools-dyirbal's
// index.js to use the ro-crate library directly (as the original does), plus
// xlsx (ro-crate-excel) and html (ro-crate-static-site) generation.
//
// This module is ISOMORPHIC: it imports only browser-safe entry points
// (ro-crate, ro-crate-static-site, and ro-crate-excel's lib/workbook.js — which
// avoids that package's Node-only shelljs/fs-extra modules), and returns bytes
// / strings rather than writing files. The caller (browser or Node) does I/O.

import { ROCrate } from "ro-crate";
import { renderSinglePage, renderTemplate, renderMultiPage, roCrateToJSON } from "ro-crate-static-site";
import Workbook from "ro-crate-excel/lib/workbook.js";

/* Files that are generated output or local control files — never treated as
 * corpus data (mirrors GENERATED_FILENAMES in the original). */
export const GENERATED_FILENAMES = new Set([
  "ro-crate-metadata.json", "ro-crate-metadata.jsonld", "ro-crate-metadata.xlsx", "ro-crate-preview.html",
  // A multipage build's own output directory. walkDirectory() tests this set
  // against directory entries too, so naming it here skips the whole tree —
  // without which every rebuild folds the previous build's preview pages into
  // the crate as if they were collection content.
  "ro-crate-preview_html",
  // Not generated, but metadata about the crate rather than content: the
  // spreadsheet xlsx-crate-input reads. Listed here so it doesn't become a
  // File entity of the collection it describes.
  "additional-ro-crate-metadata.xlsx",
]);
export const CONTROL_FILENAMES = new Set(["config.json"]);

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
function rootDatasetLicenseRefs(crate) {
  return crate.rootDataset.license?.length
    ? { license: crate.rootDataset.license.map((license) => ({ "@id": license["@id"] })) }
    : {};
}

function addFolderEntities(crate, filesWithMeta, opts = {}) {
  // When the crate's structure is described elsewhere — a spreadsheet naming
  // the entries and what each file belongs to — the folder scan has nothing to
  // add and plenty to get wrong. Grouping by top-level folder would invent an
  // object per folder ("about", "files"), which a preview template drawing a
  // card per RepositoryObject then shows instead of the real entries, and
  // would claim every file for those objects via isPartOf before the described
  // parent could be applied. Leave both to the metadata.
  if (opts.structureFromMetadata) return;

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

// fileProperties: the selected profile's declared per-file custom fields
// (config.fileProperties, from crate-o-mode.json — see buildCrate) — each
// { key, definition } pairs the compact property key written onto every
// File entity with the rdf:Property entity documenting it. Blank-initialized
// for every file, except "custom:possibleDuplicate" which is only written
// (and only if the profile actually wants it) when duplicates were found.
function addFileEntities(crate, filesWithMeta, fileProperties = [], opts = {}) {
  const blankKeys = fileProperties.map((fp) => fp.key).filter((k) => k !== "custom:possibleDuplicate");
  const wantsPossibleDuplicate = fileProperties.some((fp) => fp.key === "custom:possibleDuplicate");
  filesWithMeta.forEach((file) => {
    const stubs = {};
    for (const key of blankKeys) stubs[key] = "";
    crate.addEntity({
      "@id": file.id,
      "@type": "File",
      name: file.fileName,
      description: "",
      datePublished: "",
      ...stubs,
      contentLocation: "",
      // Without folder objects to belong to (see addFolderEntities), this
      // would point at an entity that was never created. The metadata
      // describing the structure supplies the real parent.
      ...(opts.structureFromMetadata ? {} : { isPartOf: { "@id": file.isPartOfId } }),
      ...(wantsPossibleDuplicate && file.possibleDuplicates.length
        ? { "custom:possibleDuplicate": file.possibleDuplicates.map((id) => ({ "@id": id })) }
        : {}),
    });
  });
}

// Exported for both addLanguageEntities (below) and the merge plugin's
// mergeXlsxIntoCrate (src/plugins/merge/xlsx.js), which uses the same
// entity-lookup + direct-assignment idiom to mutate already-created entities.
export function graphEntityById(crate, id) {
  return crate.graph.find((entity) => entity && entity["@id"] === id) || null;
}

// Adds every matched Language (+ its Geometry, if any) as its own entity,
// then links each matched file to them via ldac:subjectLanguage. Exported
// for the austlang plugin (src/plugins/austlang/index.js) to call as a post-build
// step — this is the one place crate.js used to know about AUSTLANG
// specifically (addFileEntities used to set ldac:subjectLanguage inline at
// file-creation time); now it's an ordinary post-hoc mutation, the same
// entity-lookup + direct-assignment idiom the merge plugin's
// mergeXlsxIntoCrate also uses (graphEntityById + entity[key] = value).
// `langById` is a Map of file id -> { matchedLanguages }, as returned by the
// austlang matcher. Keyed by id rather than by position because it's produced
// a hook stage earlier than it's consumed (see identifyAllLanguages) — a file
// with no entry is simply one nothing matched.
export function addLanguageEntities(crate, filesWithMeta, langById) {
  const identified = new Map();
  langById.forEach((r) => r.matchedLanguages.forEach((l) => identified.set(l["@id"], l)));
  identified.forEach((language) => {
    crate.addEntity(language);
    if (language.geo) crate.addEntity(language.geo);
  });
  filesWithMeta.forEach((file) => {
    const matched = langById.get(file.id)?.matchedLanguages;
    if (!matched?.length) return;
    const entity = graphEntityById(crate, file.id);
    if (entity) entity["ldac:subjectLanguage"] = matched.map((l) => ({ "@id": l["@id"] }));
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
export function buildCrate(filesWithMeta, config, log = () => {}, opts = {}) {
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

  const fileProperties = config.fileProperties || [];
  for (const fp of fileProperties) crate.addEntity(fp.definition);
  addFolderEntities(crate, filesWithMeta, opts);
  addFileEntities(crate, filesWithMeta, fileProperties, opts);
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
// ro-crate-static-site urlencodes file links wholesale, turning "/" into "%2F"
// and breaking relative navigation; only href values (not "#" anchors) are real links.
function fixEncodedSlashes(html) {
  return html.replace(/href="([^"#][^"]*)"/g, (match, href) =>
    href.includes("%2F") ? `href="${href.replace(/%2F/g, "/")}"` : match
  );
}

export async function crateToPreviewHtml(crate, opts = {}) {
  const { layouts = null, template = null, config = null, css = "" } = opts;
  // Property/type term resolution (crate.resolveTerm, used throughout
  // roCrateToJSON) requires this to have run first — without it, property
  // lookups can silently miss depending on internal resolution timing,
  // which shows up as some entities' properties (e.g. images) rendering
  // and others not, in a way that looks arbitrary per-entity.
  await crate.resolveContext();
  expandCompactPropertiesForRender(crate);
  let html;
  if (template) {
    const cfg = config || {};
    if (!Array.isArray(cfg.propertyGroups) || !cfg.propertyGroups.length) {
      throw new Error(
        "crateToPreviewHtml: config.propertyGroups is required. " +
        "This build did not resolve a property layout from the active profile; " +
        "pass the selected profile's resolved property groups."
      );
    }
    const layout = cfg.propertyGroups;
    const data = await roCrateToJSON(crate, cfg, layout);
    data.cratePath = "";
    data.layout = layout;
    data.hasLayout = true;
    html = await renderTemplate({ data, template, config: { ...cfg, propertyGroups: layout }, css, layout });
  } else {
    if (!layouts || !Array.isArray(layouts.default) || !layouts.default.length) {
      throw new Error(
        "crateToPreviewHtml: opts.layouts.default is required. " +
        "The active profile did not resolve a usable property layout; " +
        "pass the selected profile's resolved property groups (for example, resolveProfileGroups(crate, profile.workflow.propertyGroups))."
      );
    }
    html = await renderSinglePage({ crate, layouts });
  }
  return fixEncodedSlashes(html);
}

// Renders a full multipage site (root page + one page per entity matched by
// config.types) via ro-crate-static-site's renderMultiPage, for templates
// whose config sets multipage !== false. `pageTemplates` is a map of the
// exact template-path strings referenced in config.root.template /
// config.types.<Type>.template to their already-fetched template text (see
// resolveTemplateBundleFromConfig / fetchTemplateBundle in main.js, which
// fetch a templates/ subfolder for these bundles).
// Returns { rootHtml, pages: [{ id, path, html }] }, both already run
// through the same %2F fixup crateToPreviewHtml applies.
export async function crateToMultiPageHtml(crate, { config, css = "", pageTemplates = {} }) {
  await crate.resolveContext();
  expandCompactPropertiesForRender(crate);
  const cfg = config || {};
  if (!Array.isArray(cfg.propertyGroups) || !cfg.propertyGroups.length) {
    throw new Error("crateToMultiPageHtml: config.propertyGroups is required — no default layout fallback. Pass the selected profile's resolved property groups.");
  }
  const layout = cfg.propertyGroups;
  const crateLite = {
    ...(await roCrateToJSON(crate, cfg, layout)),
    cratePath: "",
    hasLayout: true,
    layout,
  };
  const { rootHtml, pages } = await renderMultiPage(crateLite, cfg, css, { pageTemplates });
  return {
    rootHtml: fixEncodedSlashes(rootHtml),
    pages: pages.map(page => ({ ...page, html: fixEncodedSlashes(page.html) })),
  };
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

