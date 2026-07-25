// resources2crate — browser UI + File System Access wiring.
// The crate assembly and output generation live in ./crate.js (library-based,
// isomorphic). This file only handles picking a folder, reading/writing files,
// and the stepped Build/Show UI.

import {
  buildFileMetadata, buildCrate, crateToJsonString, crateToXlsxBytes, crateToPreviewHtml,
  mergeXlsxIntoCrate, readXlsxHeaders, readXlsxContextPrefixes, GENERATED_FILENAMES, CONTROL_FILENAMES,
} from "./crate.js";
// ./austlang.js (and its bundled AUSTLANG data pack) is loaded lazily via
// dynamic import() only when language lookups are enabled — see run() — so the
// ~730 kB data pack stays out of the main bundle.
import { DEFAULT_CONFIG, DEFAULT_SAMPLE_DATA } from "./defaults.js";
// Default column→property mapping for the spreadsheet merge. A folder may
// override it with its own merge-config.json (see processFolder).
import MERGE_CONFIG from "./merge_config.json";

const JSON_FILE = "ro-crate-metadata.json";
const XLSX_FILE = "ro-crate-metadata.xlsx";
const HTML_FILE = "ro-crate-preview.html";
const TEMPLATE_REPO_OWNER = "benfoley";
const TEMPLATE_REPO_NAME = "rocss-template-repo";
const TEMPLATE_REPO_REF = "main";

const OPTION_SCHEMA = [
  { key: "makeHtml", label: "Generate ro-crate-preview.html", default: true, children: [
    { key: "templateRepoPreset", label: "Template from rocss-template-repo", default: false,
      hint: "Pick a folder from the online template repo.", children: [
      { key: "templateRepoFolder", type: "select", label: "Template folder",
        placeholder: "Loading folders…", hint: "Select one folder from the template repo." },
    ] },
    { key: "templateSourceUrl", label: "Template folder URL", default: false,
      hint: "Use a public GitHub folder containing template/config/style files.", children: [
      { key: "templateSourceUrlValue", type: "url", label: "Template folder URL",
        placeholder: "https://github.com/<owner>/<repo>/tree/<branch>/<folder>",
        hint: "Downloads template/config/style from this folder." },
    ] },
    { key: "styledPreview", label: "Upload template files", default: false,
      hint: "Off = the library's plain preview.", children: [
      { key: "configFile", type: "file", label: "Config (JSON)", accept: ".json,.css,.html,application/json,text/css,text/html",
        hint: "Required. If config uses relative paths, include sibling template/style files in the same upload/drop." },
    ] },
  ] },
  { key: "enableLanguageLookups", label: "Identify subject languages (AUSTLANG, by filename)", default: false,
    hint: "Matches filenames against a bundled copy of the AUSTLANG data pack — fully offline, no network." },
  { key: "merge", label: "Merge metadata from a spreadsheet", default: false,
    hint: "Reads an .xlsx and merges its columns into matching entities (by their @id) before generating outputs.", children: [
    { key: "mergeFile", type: "file", label: "Spreadsheet (XLSX)", binary: true,
      accept: ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      hint: "Rows are matched to entities by the @id column." },
    { key: "mergeMappingBuilder", type: "mappingBuilder", label: "Build mapping from spreadsheet columns…",
      hint: "Reads the column headers from the spreadsheet above and lets you set a target property (and type) for each one. You can also load an existing mapping config.json from inside that dialog." },
  ] },
];

// Shown in the Settings modal (accessed from the button next to Menu).
const SETTINGS_SCHEMA = [
  { key: "makeXlsx", label: "Generate ro-crate-metadata.xlsx", default: true },
  { key: "includeSampleData", label: "Include sample data entities", default: false,
    hint: "Adds entities from sample-data.json (or built-in defaults) to the crate graph." },
  { key: "topLevelFolderType", type: "select", label: "Top-level folders are", default: "object",
    options: [
      { value: "object", label: "Objects (RepositoryObject)" },
      { value: "collection", label: "Collections (RepositoryCollection)" },
    ],
    hint: "When Collections is selected, child folders are emitted as RepositoryObjects; files directly inside a top-level folder are grouped into an object named Files." },
  { key: "includeAlternateNames", label: "Match AUSTLANG alternate names", default: false,
    hint: "Only applies when “Identify subject languages” is on. More matches, more false positives." },
  { key: "overwrite", label: "Overwrite existing outputs", default: true },
];

/* ---------- DOM helpers ---------- */
const $ = (id) => document.getElementById(id);
const logEl = () => $("log");
function log(msg, cls = "info") {
  const span = document.createElement("span");
  span.className = "l-" + cls;
  span.textContent = msg + "\n";
  logEl().appendChild(span);
  logEl().scrollTop = logEl().scrollHeight;
}
function clearLog() { logEl().textContent = ""; }

/* ---------- view routing ---------- */
const VIEWS = ["view-folder", "view-mode", "view-crate-details", "view-build", "view-show"];
function showView(name) {
  for (const v of VIEWS) $(v).classList.toggle("hidden", v !== name);
  $("contextBar").classList.toggle("hidden", !dirHandle);
  $("menuBtn").classList.toggle("hidden", !(name === "view-build" || name === "view-show"));
  $("settingsBtn").classList.toggle("hidden", name !== "view-build");
  $("showBtn").classList.toggle("hidden", name !== "view-build");
  $("rebuildBtn").classList.toggle("hidden", name !== "view-show");
}

/* ---------- options form ---------- */
// Uploaded files (from dropzones), keyed by option key.
const uploads = {};
let uploadedConfigDirHandle = null;
// The "Build mapping…" button — only enabled once a merge spreadsheet is uploaded.
let mergeMappingBuilderBtn = null;
function refreshMergeMappingBuilderBtn() {
  if (mergeMappingBuilderBtn) mergeMappingBuilderBtn.disabled = !uploads.mergeFile;
}

function hintEl(text) { const h = document.createElement("div"); h.className = "hint"; h.textContent = text; return h; }

function buildForm() {
  Object.keys(uploads).forEach((k) => delete uploads[k]);
  uploadedConfigDirHandle = null;
  const form = $("optionsForm");
  form.innerHTML = "";
  renderOptions(OPTION_SCHEMA, form);
  setupTemplateSourceExclusivity();
  loadTemplateRepoFolderOptions();
  const settings = $("settingsForm");
  settings.innerHTML = "";
  renderOptions(SETTINGS_SCHEMA, settings);
}

function setupTemplateSourceExclusivity() {
  const uploadOpt = $("opt_styledPreview");
  const urlOpt = $("opt_templateSourceUrl");
  const repoOpt = $("opt_templateRepoPreset");
  if (!uploadOpt || !urlOpt || !repoOpt) return;

  const sync = (changed) => {
    const active = [];
    if (uploadOpt.checked) active.push("upload");
    if (urlOpt.checked) active.push("url");
    if (repoOpt.checked) active.push("repo");
    if (active.length <= 1) return;

    if (changed === "upload") { urlOpt.checked = false; repoOpt.checked = false; }
    else if (changed === "url") { uploadOpt.checked = false; repoOpt.checked = false; }
    else if (changed === "repo") { uploadOpt.checked = false; urlOpt.checked = false; }
    else { urlOpt.checked = false; repoOpt.checked = false; }

    uploadOpt.dispatchEvent(new Event("change"));
    urlOpt.dispatchEvent(new Event("change"));
    repoOpt.dispatchEvent(new Event("change"));
  };

  uploadOpt.addEventListener("change", () => sync("upload"));
  urlOpt.addEventListener("change", () => sync("url"));
  repoOpt.addEventListener("change", () => sync("repo"));
}

function renderOptions(schema, parent) {
  for (const opt of schema) {
    if (opt.type === "file") { parent.appendChild(buildFileField(opt)); continue; }
    if (opt.type === "url") { parent.appendChild(buildUrlField(opt)); continue; }
    if (opt.type === "select") { parent.appendChild(buildSelectField(opt)); continue; }
    if (opt.type === "mappingBuilder") { parent.appendChild(buildMappingBuilderField(opt)); continue; }

    const wrap = document.createElement("div");
    wrap.className = "field";
    const row = document.createElement("div");
    row.className = "checkbox";
    const input = document.createElement("input");
    input.type = "checkbox"; input.id = "opt_" + opt.key; input.checked = !!opt.default;
    const label = document.createElement("label");
    label.htmlFor = input.id; label.textContent = opt.label;
    row.append(input, label);
    wrap.appendChild(row);
    if (opt.hint) wrap.appendChild(hintEl(opt.hint));

    if (opt.children) {
      const panel = document.createElement("div");
      panel.className = "subpanel"; panel.id = "panel_" + opt.key;
      renderOptions(opt.children, panel);
      wrap.appendChild(panel);
      const sync = () => panel.classList.toggle("hidden", !input.checked);
      input.addEventListener("change", sync);
      sync();
    }
    parent.appendChild(wrap);
  }
}

function buildFileField(opt) {
  const wrap = document.createElement("div");
  wrap.className = "field file-field";
  wrap.appendChild(Object.assign(document.createElement("div"), { className: "file-label", textContent: opt.label }));

  const drop = document.createElement("label");
  drop.className = "dropzone"; drop.htmlFor = "file_" + opt.key;
  const defaultDropText = opt.key === "configFile"
    ? "Drop config, style and template files here"
    : "Drop a file or click to choose";
  const dz = Object.assign(document.createElement("span"), { className: "dz-text", textContent: defaultDropText });
  drop.appendChild(dz);

  const input = document.createElement("input");
  input.type = "file"; input.id = "file_" + opt.key; input.accept = opt.accept || ""; input.className = "hidden";
  if (opt.key === "configFile") input.multiple = true;

  const clear = document.createElement("button");
  clear.type = "button"; clear.className = "secondary dz-clear hidden"; clear.textContent = "Remove";

  // Store the File itself; its bytes/text are read at build time (supports
  // binary files like .xlsx as well as text config/style).
  const setFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (opt.key === "configFile") {
      uploadedConfigDirHandle = null;
      const cfg = files.find((f) => f.name.toLowerCase() === "config.json")
        || files.find((f) => f.name.toLowerCase().endsWith(".json"))
        || files[0];
      const cfgPath = String(cfg.webkitRelativePath || cfg.name || "").replace(/\\/g, "/");
      const cfgDir = cfgPath.includes("/") ? cfgPath.slice(0, cfgPath.lastIndexOf("/") + 1) : "";
      const siblingFiles = new Map();
      files.forEach((f) => {
        const p = String(f.webkitRelativePath || f.name || "").replace(/\\/g, "/");
        const rel = cfgDir && p.startsWith(cfgDir) ? p.slice(cfgDir.length) : p;
        if (rel) siblingFiles.set(rel, f);
        if (f.name) siblingFiles.set(f.name, f);
      });
      uploads[opt.key] = { name: cfg.name, file: cfg, siblingFiles };
      dz.textContent = files.length > 1 ? `${cfg.name} (+${files.length - 1} file(s))` : cfg.name;
    } else {
      const file = files[0];
      uploads[opt.key] = { name: file.name, file };
      dz.textContent = file.name;
    }
    drop.classList.add("has-file");
    clear.classList.remove("hidden");
    if (opt.key === "mergeFile") refreshMergeMappingBuilderBtn();
  };
  const clearFile = () => {
    delete uploads[opt.key];
    dz.textContent = defaultDropText; drop.classList.remove("has-file");
    clear.classList.add("hidden"); input.value = "";
    if (opt.key === "mergeFile") refreshMergeMappingBuilderBtn();
  };

  input.addEventListener("change", () => { if (input.files && input.files.length) setFiles(input.files); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("drag");
    if (e.dataTransfer.files && e.dataTransfer.files.length) setFiles(e.dataTransfer.files);
  });
  clear.addEventListener("click", clearFile);

  wrap.append(drop, input, clear);
  if (opt.hint) wrap.appendChild(hintEl(opt.hint));
  return wrap;
}

function buildUrlField(opt) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.appendChild(Object.assign(document.createElement("div"), { className: "file-label", textContent: opt.label }));

  const input = document.createElement("input");
  input.type = "url";
  input.id = "opt_" + opt.key;
  input.placeholder = opt.placeholder || "https://";
  input.autocomplete = "off";
  input.style.width = "100%";
  input.style.padding = "9px 10px";
  input.style.borderRadius = "8px";
  input.style.border = "1px solid var(--border)";
  input.style.background = "var(--panel-2)";
  input.style.color = "var(--text)";
  input.style.fontFamily = "var(--mono)";
  input.style.fontSize = "12px";

  wrap.appendChild(input);
  if (opt.hint) wrap.appendChild(hintEl(opt.hint));
  return wrap;
}

function buildSelectField(opt) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.appendChild(Object.assign(document.createElement("div"), { className: "file-label", textContent: opt.label }));

  const select = document.createElement("select");
  select.id = "opt_" + opt.key;
  select.style.width = "100%";
  select.style.padding = "9px 10px";
  select.style.borderRadius = "8px";
  select.style.border = "1px solid var(--border)";
  select.style.background = "var(--panel-2)";
  select.style.color = "var(--text)";
  select.style.fontFamily = "var(--mono)";
  select.style.fontSize = "12px";

  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = opt.placeholder || "Select…";
  select.appendChild(ph);

  if (Array.isArray(opt.options)) {
    opt.options.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label || item.value;
      select.appendChild(option);
    });
  }

  if (typeof opt.default === "string") select.value = opt.default;

  wrap.appendChild(select);
  if (opt.hint) wrap.appendChild(hintEl(opt.hint));
  return wrap;
}

function buildMappingBuilderField(opt) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "secondary"; btn.style.width = "100%";
  btn.textContent = opt.label;
  btn.disabled = true;
  btn.addEventListener("click", openMergeMappingModal);
  mergeMappingBuilderBtn = btn;
  refreshMergeMappingBuilderBtn();
  wrap.appendChild(btn);
  const status = document.createElement("div");
  status.className = "hint"; status.id = "mergeMappingStatus";
  status.textContent = "No custom mapping — bundled defaults will be used.";
  wrap.appendChild(status);
  if (opt.hint) wrap.appendChild(hintEl(opt.hint));
  return wrap;
}
function updateMergeMappingStatus(mappingCount) {
  const el = $("mergeMappingStatus");
  if (el) el.textContent = `Custom mapping applied: ${mappingCount} column(s).`;
}

/* ---------- merge-mapping builder modal ---------- */
// Entity types the mapping builder offers for a column — matches the
// vocabulary already used by src/merge_config.json.
const MAPPING_TYPE_OPTIONS = ["", "Person", "Organization", "Place", "Language", "License", "File"];

// In-progress edits, keyed by source column name, kept alive across the modal
// being closed and reopened (Cancel, backdrop click, or Apply) so nothing
// typed is lost until the user actually reloads or picks a new spreadsheet.
let mergeMappingDraft = {};
// The current spreadsheet's columns, kept so a loaded mapping config.json can
// re-render the rows without re-reading the spreadsheet.
let mergeMappingHeaders = [];
let mergeMappingSheetName = "";
let mergeWorkbookBytes = null;
let mergeWorkbookContextPrefixes = new Map();
let mergeMappingConfigSources = null;
const BUILTIN_CONTEXT_PREFIXES = new Set(["ldac", "pcdm", "custom", "AUSTLANG"]);

function updateMergeSourceModeBadge() {
  const badge = $("mappingSourceModeBadge");
  if (!badge) return;
  const showingConfigSources = Array.isArray(mergeMappingConfigSources) && mergeMappingConfigSources.length > 0;
  badge.classList.toggle("hidden", !showingConfigSources);
}

function mappingTargetPrefix(term) {
  const t = String(term || "").trim();
  if (!t || t.includes("://")) return "";
  const i = t.indexOf(":");
  if (i <= 0) return "";
  const prefix = t.slice(0, i);
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(prefix) ? prefix : "";
}

function updateMergePrefixHint() {
  const hint = $("mappingPrefixHint");
  const container = $("mergeMappingBody");
  if (!hint || !container) return;

  const required = new Set();
  container.querySelectorAll(".mapping-row .map-target").forEach((input) => {
    const p = mappingTargetPrefix(input.value);
    if (p) required.add(p);
  });

  const unresolved = [...required].filter((p) => !BUILTIN_CONTEXT_PREFIXES.has(p) && !mergeWorkbookContextPrefixes.has(p));
  if (!unresolved.length) {
    hint.classList.add("hidden");
    hint.textContent = "";
    return;
  }

  hint.textContent = `Prefix context not found in workbook: ${unresolved.join(", ")}. Add a context table (e.g. prefix + uri) or an @context JSON row.`;
  hint.classList.remove("hidden");
}

function setMergeMappingSheetOptions(sheetNames, selectedSheetName) {
  const select = $("mappingSheetSelect");
  if (!select) return;
  select.innerHTML = "";
  (sheetNames || []).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  select.disabled = (sheetNames || []).length <= 1;
  if (selectedSheetName) select.value = selectedSheetName;
}

async function refreshMergeMappingSheet(preferredSheetName = "") {
  if (!mergeWorkbookBytes) return;
  const { headers, sheetName, sheetNames } = await readXlsxHeaders(mergeWorkbookBytes, preferredSheetName);
  mergeMappingHeaders = headers;
  mergeMappingSheetName = sheetName;
  setMergeMappingSheetOptions(sheetNames, sheetName);
  renderMergeMappingRows(headers, sheetName);
}

async function openMergeMappingModal() {
  const upload = uploads.mergeFile;
  if (!upload) {
    alert('Select a spreadsheet in "Spreadsheet (XLSX)" first.');
    return;
  }
  try {
    mergeWorkbookBytes = await upload.file.arrayBuffer();
    mergeWorkbookContextPrefixes = await readXlsxContextPrefixes(mergeWorkbookBytes);
    mergeMappingConfigSources = null;
    await refreshMergeMappingSheet();
  } catch (e) {
    alert("Could not read the spreadsheet: " + (e && e.message ? e.message : e));
    return;
  }
  $("mappingConfigDropText").textContent = "Drop a mapping config.json here, or click to load one";
  $("mappingConfigDrop").classList.remove("has-file");
  $("mappingConfigError").classList.add("hidden");
  $("mappingConfigFile").value = "";
  $("mappingPrefixHint").classList.add("hidden");
  $("mappingPrefixHint").textContent = "";
  updateMergeSourceModeBadge();
  $("mergeMappingModal").classList.remove("hidden");
}

// A loaded config.json must look like { mapping: [{ source, target, type? }, ...] }
// (the same shape mergeXlsxIntoCrate consumes), optionally with sheet.
function isValidMergeMappingConfig(obj) {
  const validSheet = obj && (obj.sheet === undefined || typeof obj.sheet === "string");
  return !!obj && typeof obj === "object" && validSheet && Array.isArray(obj.mapping) && obj.mapping.length > 0
    && obj.mapping.every((m) => m && typeof m.source === "string" && typeof m.target === "string"
      && (m.type === undefined || typeof m.type === "string"));
}

async function loadMappingConfigFile(file) {
  const errEl = $("mappingConfigError");
  errEl.classList.add("hidden"); errEl.textContent = "";
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    errEl.textContent = "Could not parse JSON: " + (e && e.message ? e.message : e);
    errEl.classList.remove("hidden");
    return;
  }
  if (!isValidMergeMappingConfig(parsed)) {
    errEl.textContent = 'Not a valid mapping config — expected {"sheet": "…" (optional), "mapping": [{"source": "…", "target": "…", "type": "…" (optional)}, …]}.';
    errEl.classList.remove("hidden");
    return;
  }
  const requestedSheet = String(parsed.sheet || "").trim();
  if (requestedSheet) {
    try {
      await refreshMergeMappingSheet(requestedSheet);
    } catch (e) {
      errEl.textContent = e && e.message ? e.message : String(e);
      errEl.classList.remove("hidden");
      return;
    }
  }
  mergeMappingConfigSources = [...new Set(
    parsed.mapping
      .map((m) => String(m.source || "").trim())
      .filter((s) => s && s !== "@id")
  )];
  updateMergeSourceModeBadge();
  parsed.mapping.forEach((m) => { mergeMappingDraft[m.source] = { target: m.target, type: m.type || "" }; });
  $("mappingConfigDropText").textContent = file.name;
  $("mappingConfigDrop").classList.add("has-file");
  renderMergeMappingRows(mergeMappingHeaders, mergeMappingSheetName);
}

function renderMergeMappingRows(headers, sheetName) {
  const container = $("mergeMappingBody");
  container.innerHTML = "";
  container.dataset.sheetName = sheetName || "";

  const sheetColumns = headers
    .map((h) => String(h || "").trim())
    .filter((h) => h && h !== "@id");
  const columns = Array.isArray(mergeMappingConfigSources) && mergeMappingConfigSources.length
    ? mergeMappingConfigSources
    : sheetColumns;

  if (!columns.length) {
    const msg = Array.isArray(mergeMappingConfigSources) && mergeMappingConfigSources.length
      ? "No source columns found in the loaded mapping config."
      : "No columns found in the first row of this sheet.";
    container.appendChild(hintEl(msg));
    updateMergePrefixHint();
    return;
  }

  const head = document.createElement("div");
  head.className = "mapping-head";
  head.innerHTML = "<span>Source column</span><span></span><span>Target property</span><span>Type</span>";
  container.appendChild(head);

  columns.forEach((header) => {
    const row = document.createElement("div");
    row.className = "mapping-row";
    row.dataset.source = header;

    const src = document.createElement("div");
    src.className = "col-source";
    src.textContent = header;

    const draft = mergeMappingDraft[header] || {};
    // Source columns sometimes use a leading-dot convention (".author",
    // ".language" — see merge_config.json) to flag a typed/reference column;
    // that dot isn't part of the actual target property name.
    const defaultTarget = header.replace(/^\.+/, "");

    const target = document.createElement("input");
    target.type = "text"; target.className = "map-target";
    target.placeholder = "e.g. name, custom:participant";
    // Defaults to the source column name (same as clicking the copy arrow);
    // an explicit empty draft (the user cleared it) is respected on redraw.
    target.value = draft.target !== undefined ? draft.target : defaultTarget;
    target.addEventListener("input", () => {
      mergeMappingDraft[header] = { ...mergeMappingDraft[header], target: target.value };
      updateMergePrefixHint();
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button"; copyBtn.className = "map-copy-btn";
    copyBtn.title = "Copy source column name to target property";
    copyBtn.textContent = "→";
    copyBtn.addEventListener("click", () => {
      target.value = defaultTarget;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.focus();
    });

    const type = document.createElement("select");
    type.className = "map-type";
    MAPPING_TYPE_OPTIONS.forEach((t) => {
      const o = document.createElement("option");
      o.value = t; o.textContent = t || "(plain value)";
      type.appendChild(o);
    });
    type.value = draft.type || "";
    type.addEventListener("change", () => {
      mergeMappingDraft[header] = { ...mergeMappingDraft[header], type: type.value };
    });

    row.append(src, copyBtn, target, type);
    container.appendChild(row);
  });

  updateMergePrefixHint();
}

function applyMergeMapping() {
  const container = $("mergeMappingBody");
  const sheetName = container.dataset.sheetName || "";
  const mapping = [];
  container.querySelectorAll(".mapping-row").forEach((row) => {
    const target = row.querySelector(".map-target").value.trim();
    if (!target) return;
    const entry = { source: row.dataset.source, target };
    const type = row.querySelector(".map-type").value;
    if (type) entry.type = type;
    mapping.push(entry);
  });
  if (!mapping.length) {
    alert("Set a target property for at least one column before applying.");
    return;
  }
  const config = sheetName ? { sheet: sheetName, mapping } : { mapping };
  const file = new File([JSON.stringify(config, null, 2)], "merge-config.json", { type: "application/json" });
  // No visible dropzone for this anymore — the mapping modal is the only UI
  // for it — so processFolder's mergeConfigUpload is set directly.
  uploads.mergeConfigFile = { name: file.name, file };
  updateMergeMappingStatus(mapping.length);
  $("mergeMappingModal").classList.add("hidden");
}

async function loadTemplateRepoFolderOptions() {
  const select = $("opt_templateRepoFolder");
  if (!select) return;
  select.disabled = true;
  try {
    const apiUrl = `https://api.github.com/repos/${TEMPLATE_REPO_OWNER}/${TEMPLATE_REPO_NAME}/contents?ref=${encodeURIComponent(TEMPLATE_REPO_REF)}`;
    const res = await fetch(apiUrl, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const entries = await res.json();
    if (!Array.isArray(entries)) throw new Error("Unexpected API response");
    const folders = entries
      .filter((e) => e && e.type === "dir" && typeof e.name === "string")
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    select.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = folders.length ? "Select a template folder…" : "No folders found";
    select.appendChild(ph);
    folders.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
    select.disabled = folders.length === 0;
  } catch (e) {
    select.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = `Could not load folders (${e.message})`;
    select.appendChild(ph);
    select.disabled = true;
  }
}

function collectOptions(schema, o) {
  for (const opt of schema) {
    if (opt.type === "file") continue;
    if (opt.type === "url") {
      const el = $("opt_" + opt.key);
      if (el) o[opt.key] = (el.value || "").trim();
      continue;
    }
    if (opt.type === "select") {
      const el = $("opt_" + opt.key);
      if (el) o[opt.key] = el.value || "";
      continue;
    }
    const el = $("opt_" + opt.key);
    if (el) o[opt.key] = el.checked;
    if (opt.children) collectOptions(opt.children, o);
  }
}
function readOptions() {
  const o = {};
  collectOptions(OPTION_SCHEMA, o);
  collectOptions(SETTINGS_SCHEMA, o);
  o.configUpload = uploads.configFile || null;
  o.mergeUpload = uploads.mergeFile || null;
  o.mergeConfigUpload = uploads.mergeConfigFile || null;
  return o;
}

/* ---------- crate details (root dataset) form ---------- */
const DEFAULT_LICENSE_URL = "https://creativecommons.org/licenses/by-nc-nd/4.0/";

// Values collected from the crate-details form, merged into config.rootDataset
// at build time. Populated when the user clicks Continue on that step.
let rootDatasetOverride = null;

function todayIsoDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slugify(text) {
  return String(text || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Free text (just the part after "arcp://name,") -> full "arcp://name,<slug>" id.
// Tolerates the prefix being typed/pasted in anyway by stripping it first.
function normalizeArcpId(input) {
  const trimmed = String(input || "").trim().replace(/^arcp:\/\/name,/i, "");
  return `arcp://name,${slugify(trimmed) || "crate"}`;
}

function openCrateDetails() {
  if (dirHandle) {
    if (!$("cd_name").value.trim()) $("cd_name").value = dirHandle.name;
    if (!$("cd_id").value.trim()) $("cd_id").value = slugify(dirHandle.name);
  }
  if (!$("cd_datePublished").value) $("cd_datePublished").value = todayIsoDate();
  if (!$("cd_license").value.trim()) $("cd_license").value = DEFAULT_LICENSE_URL;
  showView("view-crate-details");
}

// Builds the config.rootDataset fragment for this build. inLanguage and creator
// become full entities (with @id derived from their free text) so the ro-crate
// library registers them as linked nodes in the graph when assigned.
function buildRootDatasetFromForm() {
  const languageText = $("cd_inLanguage").value.trim();
  const creatorText = $("cd_creator").value.trim();
  const idText = $("cd_id").value.trim();
  const name = $("cd_name").value.trim();
  const rootDataset = {
    "@id": normalizeArcpId(idText || name),
    name,
    description: $("cd_description").value.trim(),
    datePublished: $("cd_datePublished").value || todayIsoDate(),
    license: { "@id": $("cd_license").value.trim() || DEFAULT_LICENSE_URL },
  };
  if (languageText) {
    rootDataset.inLanguage = { "@id": `#language-${slugify(languageText)}`, "@type": "Language", name: languageText };
  }
  if (creatorText) {
    rootDataset.creator = { "@id": `#person-${slugify(creatorText)}`, "@type": "Person", name: creatorText };
  }
  return rootDataset;
}

function submitCrateDetails() {
  rootDatasetOverride = buildRootDatasetFromForm();
  openBuild();
}

/* ---------- File System Access ---------- */
let dirHandle = null;

async function verifyPermission(handle, readWrite) {
  const opts = { mode: readWrite ? "readwrite" : "read" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}
async function walkDirectory(handle, prefix = "") {
  const files = [];
  for await (const entry of handle.values()) {
    const nm = entry.name;
    if (nm.startsWith(".") || nm.startsWith("~$")) continue;
    if (GENERATED_FILENAMES.has(nm) || CONTROL_FILENAMES.has(nm)) continue;
    const rel = prefix ? prefix + "/" + nm : nm;
    if (entry.kind === "file") files.push({ fileName: nm, relativePath: rel });
    else if (entry.kind === "directory") files.push(...await walkDirectory(entry, rel));
  }
  return files;
}
async function writeFile(handle, filename, contents) {
  const fh = await handle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(contents);
  await w.close();
}
async function fileExists(handle, filename) {
  try { await handle.getFileHandle(filename, { create: false }); return true; }
  catch { return false; }
}
async function readFileText(handle, filename) {
  try {
    const fh = await handle.getFileHandle(filename, { create: false });
    return await (await fh.getFile()).text();
  } catch (e) {
    if (e && e.name === "NotFoundError") return null;
    throw e;
  }
}

async function readFileTextFromDirectory(handle, relativePath) {
  if (!handle) return null;
  const parts = String(relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return null;
  let dir = handle;
  for (let i = 0; i < parts.length - 1; i++) {
    try { dir = await dir.getDirectoryHandle(parts[i], { create: false }); }
    catch (e) {
      if (e && e.name === "NotFoundError") return null;
      throw e;
    }
  }
  try {
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: false });
    return await (await fh.getFile()).text();
  } catch (e) {
    if (e && e.name === "NotFoundError") return null;
    throw e;
  }
}

async function readJsonFromFolder(handle, filename) {
  const text = await readFileText(handle, filename);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${filename} in the folder is not valid JSON: ${e.message}`); }
}

// raw.githubusercontent.com is served through a CDN that caches per exact URL
// for a few minutes, so a recent push can otherwise still serve stale content;
// a unique query param forces a fresh fetch from origin.
function bustCacheUrl(rawUrl) {
  return `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}_=${Date.now()}`;
}

function parseGitHubFolderUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error("Template folder URL is not a valid URL."); }
  if (url.hostname !== "github.com") {
    throw new Error("Template folder URL must be a github.com URL.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "tree") {
    throw new Error("Use a GitHub folder URL like /owner/repo/tree/branch/path.");
  }
  const owner = parts[0];
  const repo = parts[1];
  const ref = decodeURIComponent(parts[3]);
  const folderPath = decodeURIComponent(parts.slice(4).join("/"));
  return { owner, repo, ref, folderPath };
}

function pickPreferredFile(files, ext, hints = []) {
  const byExt = files.filter((f) => f && f.type === "file" && typeof f.name === "string" && f.name.toLowerCase().endsWith(ext));
  if (!byExt.length) return null;
  for (const h of hints) {
    const found = byExt.find((f) => f.name.toLowerCase().includes(h));
    if (found) return found;
  }
  return byExt[0];
}

function preferredUploadedFile(uploadedFiles, ext, hints = []) {
  if (!uploadedFiles) return null;
  const uniqueFiles = [];
  const seen = new Set();
  uploadedFiles.forEach((file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    uniqueFiles.push(file);
  });
  return pickPreferredFile(uniqueFiles, ext, hints);
}

function getNestedValue(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[key];
  }
  return cur;
}

function pickConfigString(cfg, paths) {
  for (const p of paths) {
    const v = getNestedValue(cfg, p);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function isLikelyInlineTemplate(text) {
  return /<[a-z!/][^>]*>/i.test(text);
}

function isLikelyInlineCss(text) {
  return /[{;}]/.test(text) && /\s/.test(text);
}

function isAbsolutePathSpec(value) {
  return /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^~\//.test(value);
}

function pathTailCandidates(value) {
  const rel = String(value || "").replace(/^~\//, "").replace(/^[A-Za-z]:[\\/]/, "").replace(/^\/+/, "").replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join("/"));
  return out;
}

function hasUploadedMatch(uploadedFiles, spec) {
  if (!uploadedFiles) return false;
  const rel = String(spec || "").replace(/^\.\//, "").replace(/^~\//, "").replace(/^[A-Za-z]:[\\/]/, "").replace(/^\/+/, "").replace(/\\/g, "/");
  const base = rel.split("/").pop();
  return !!(uploadedFiles.get(rel) || uploadedFiles.get(base));
}

function needsLocalTemplateFolder(cfg, uploadedFiles) {
  const refs = [
    pickConfigString(cfg, ["root:template", "root.template", "template", "templateFile", "templatePath", "templateUrl", "files.template", "paths.template", "assets.template"]),
    pickConfigString(cfg, ["style", "css", "styleFile", "stylePath", "styleUrl", "cssFile", "cssPath", "cssUrl", "files.style", "files.css", "paths.style", "paths.css", "assets.style", "assets.css"]),
  ].filter(Boolean);
  for (const v of refs) {
    if (/^https?:\/\//i.test(v)) continue;
    if (isLikelyInlineTemplate(v) || isLikelyInlineCss(v)) continue;
    if (hasUploadedMatch(uploadedFiles, v)) continue;
    return true;
  }
  return false;
}

async function ensureUploadedConfigDirectoryHandle() {
  if (uploadedConfigDirHandle) {
    const ok = await verifyPermission(uploadedConfigDirHandle, false);
    if (ok) return uploadedConfigDirHandle;
    uploadedConfigDirHandle = null;
  }
  try {
    const picked = await window.showDirectoryPicker({ mode: "read" });
    const ok = await verifyPermission(picked, false);
    if (!ok) throw new Error("Permission to read the config folder was denied.");
    uploadedConfigDirHandle = picked;
    return uploadedConfigDirHandle;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Config folder selection was cancelled.");
    throw e;
  }
}

async function resolveTemplateAsset(spec, kind, { dirHandle = null, baseRawUrl = "", uploadedFiles = null } = {}) {
  const val = String(spec || "").trim();
  if (!val) return { text: kind === "css" ? "" : null, source: "none" };

  if (kind === "template" && isLikelyInlineTemplate(val)) return { text: val, source: "inline config" };
  if (kind === "css" && isLikelyInlineCss(val)) return { text: val, source: "inline config" };

  if (/^https?:\/\//i.test(val)) {
    const res = await fetch(bustCacheUrl(val), { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not download ${kind} from URL (${res.status} ${res.statusText}).`);
    return { text: await res.text(), source: `url (${val})` };
  }

  if (baseRawUrl) {
    const url = new URL(val.replace(/^\.\//, ""), baseRawUrl).toString();
    const res = await fetch(bustCacheUrl(url), { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not download ${kind} from config path "${val}" (${res.status} ${res.statusText}).`);
    return { text: await res.text(), source: `url (${url})` };
  }

  if (uploadedFiles) {
    const rel = val.replace(/^\.\//, "").replace(/^~\//, "").replace(/^[A-Za-z]:[\\/]/, "").replace(/^\/+/, "").replace(/\\/g, "/");
    const base = rel.split("/").pop();
    const uploaded = uploadedFiles.get(rel) || uploadedFiles.get(base);
    if (uploaded) return { text: await uploaded.text(), source: `upload (${rel})` };
  }

  if (dirHandle) {
    if (isAbsolutePathSpec(val)) {
      for (const candidate of pathTailCandidates(val)) {
        const text = await readFileTextFromDirectory(dirHandle, candidate);
        if (text !== null) return { text, source: `folder (${candidate})` };
      }
    } else {
      const rel = val.replace(/^\.\//, "");
      const text = await readFileTextFromDirectory(dirHandle, rel);
      if (text !== null) return { text, source: `folder (${rel})` };
    }
  }

  throw new Error(`Could not resolve ${kind} from config value "${val}".`);
}

async function resolveTemplateBundleFromConfig(cfg, opts = {}) {
  const templateRef = pickConfigString(cfg, [
    "root:template", "root.template",
    "template", "templateFile", "templatePath", "templateUrl",
    "files.template", "paths.template", "assets.template",
  ]);
  const styleRef = pickConfigString(cfg, [
    "style", "css", "styleFile", "stylePath", "styleUrl", "cssFile", "cssPath", "cssUrl",
    "files.style", "files.css", "paths.style", "paths.css", "assets.style", "assets.css",
  ]);

  let templateResolved = templateRef ? await resolveTemplateAsset(templateRef, "template", opts) : { text: null, source: "none" };
  let styleResolved = styleRef ? await resolveTemplateAsset(styleRef, "css", opts) : { text: "", source: "none" };

  if (!templateRef && opts.uploadedFiles) {
    const uploadedTemplate = preferredUploadedFile(opts.uploadedFiles, ".html", ["template", "preview"]);
    if (uploadedTemplate) {
      templateResolved = {
        text: await uploadedTemplate.text(),
        source: `upload (${uploadedTemplate.name})`,
      };
    }
  }

  if (!styleRef && opts.uploadedFiles) {
    const uploadedStyle = preferredUploadedFile(opts.uploadedFiles, ".css", ["style", "preview"]);
    if (uploadedStyle) {
      styleResolved = {
        text: await uploadedStyle.text(),
        source: `upload (${uploadedStyle.name})`,
      };
    }
  }

  return {
    template: templateResolved.text,
    css: styleResolved.text || "",
    templateSrc: templateResolved.source,
    cssSrc: styleResolved.source,
  };
}

async function fetchTemplateBundleFromUrl(rawUrl) {
  const { owner, repo, ref, folderPath } = parseGitHubFolderUrl(rawUrl);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(folderPath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(apiUrl, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Could not read template folder (${res.status} ${res.statusText}).`);
  }
  const entries = await res.json();
  if (!Array.isArray(entries)) {
    throw new Error("Template URL does not point to a folder.");
  }

  const jsonFile = pickPreferredFile(entries, ".json", ["config", "preview"]);
  const htmlFile = pickPreferredFile(entries, ".html", ["template", "preview"]);
  const cssFile = pickPreferredFile(entries, ".css", ["style", "preview"]);
  const rawBaseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref).replace(/%2F/g, "/")}/${encodeURIComponent(folderPath).replace(/%2F/g, "/")}/`;

  const readText = async (entry) => {
    if (!entry || !entry.download_url) return null;
    const r = await fetch(bustCacheUrl(entry.download_url), { cache: "no-store" });
    if (!r.ok) throw new Error(`Could not download ${entry.name} (${r.status} ${r.statusText}).`);
    return r.text();
  };

  const template = await readText(htmlFile);
  const configText = await readText(jsonFile);
  const css = (await readText(cssFile)) || "";
  let config = null;
  let templateSrc = htmlFile ? `folder file (${htmlFile.name})` : "none";
  let cssSrc = cssFile ? `folder file (${cssFile.name})` : "none";
  if (configText !== null) {
    try { config = JSON.parse(configText); }
    catch (e) { throw new Error(`Downloaded config file "${jsonFile.name}" is not valid JSON: ${e.message}`); }

    // If config.json specifies template/style sources, those take precedence.
    const resolved = await resolveTemplateBundleFromConfig(config, { baseRawUrl: rawBaseUrl });
    if (resolved.template) { templateSrc = resolved.templateSrc; }
    if (resolved.css) { cssSrc = resolved.cssSrc; }
    return {
      template: resolved.template || template,
      config,
      css: resolved.css || css,
      sourceLabel: `${owner}/${repo}@${ref}/${folderPath}`,
      files: {
        template: resolved.template ? resolved.templateSrc : (htmlFile ? htmlFile.name : null),
        config: jsonFile ? jsonFile.name : null,
        style: resolved.css ? resolved.cssSrc : (cssFile ? cssFile.name : null),
      },
    };
  }

  return {
    template,
    config,
    css,
    sourceLabel: `${owner}/${repo}@${ref}/${folderPath}`,
    files: {
      template: htmlFile ? htmlFile.name : templateSrc,
      config: jsonFile ? jsonFile.name : null,
      style: cssFile ? cssFile.name : cssSrc,
    },
  };
}

function buildGitHubTreeUrl(owner, repo, ref, folderPath) {
  const safePath = String(folderPath || "").split("/").map((p) => encodeURIComponent(p)).join("/");
  return `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(ref)}/${safePath}`;
}

function describeRemoteSource(label, value, fallback) {
  if (!value) return fallback;
  if (value.startsWith("url (") || value.startsWith("inline") || value.startsWith("folder (")) return value;
  return `${label}/${value}`;
}

/* ---------- Build ---------- */
async function processFolder(dirHandle, files, options) {
  const config = (await readJsonFromFolder(dirHandle, "config.json")) || DEFAULT_CONFIG;
  const sampleData = options.includeSampleData
    ? ((await readJsonFromFolder(dirHandle, "sample-data.json")) || DEFAULT_SAMPLE_DATA)
    : null;
  log(
    `Config: ${config === DEFAULT_CONFIG ? "built-in default" : "config.json from folder"} · ` +
    (options.includeSampleData
      ? `Sample data: ${sampleData === DEFAULT_SAMPLE_DATA ? "built-in default" : "sample-data.json from folder"}.`
      : "Sample data: disabled by settings."),
    "muted"
  );

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const filesWithMeta = buildFileMetadata(files);
  log(`Scanned ${filesWithMeta.length} file(s).`, "info");

  let langByIndex = null;
  if (options.enableLanguageLookups) {
    const { identifyAllLanguages } = await import("./austlang.js");
    langByIndex = await identifyAllLanguages(filesWithMeta, options.includeAlternateNames, log);
  }

  const effectiveConfig = rootDatasetOverride
    ? { ...config, rootDataset: { ...config.rootDataset, ...rootDatasetOverride } }
    : config;
  const crate = buildCrate(filesWithMeta, effectiveConfig, sampleData, langByIndex, log, {
    topLevelFolderType: options.topLevelFolderType,
    includeSampleData: !!options.includeSampleData,
  });

  // Optional: merge metadata from an uploaded spreadsheet (before outputs).
  if (options.merge && options.mergeUpload) {
    // Mapping config precedence: uploaded file → folder file → bundled default.
    let mergeConfig = MERGE_CONFIG, mcSrc = "bundled default";
    if (options.mergeConfigUpload) {
      const mcText = await options.mergeConfigUpload.file.text();
      try { mergeConfig = JSON.parse(mcText); }
      catch (e) { throw new Error(`uploaded merge config "${options.mergeConfigUpload.name}" is not valid JSON: ${e.message}`); }
      mcSrc = `uploaded (${options.mergeConfigUpload.name})`;
    } else {
      const folderMc = await readJsonFromFolder(dirHandle, "merge-config.json");
      if (folderMc) { mergeConfig = folderMc; mcSrc = "merge-config.json from folder"; }
    }
    log(`Merging ${options.mergeUpload.name} · mapping ${mcSrc}.`, "muted");
    const bytes = await options.mergeUpload.file.arrayBuffer();
    await mergeXlsxIntoCrate(crate, bytes, mergeConfig, log);
  } else if (options.merge && !options.mergeUpload) {
    log("Merge is on but no spreadsheet was selected — skipping merge.", "warn");
  }

  const entities = crate.getJson()["@graph"].length;

  // ro-crate-metadata.json
  if (options.overwrite || !(await fileExists(dirHandle, JSON_FILE))) {
    await writeFile(dirHandle, JSON_FILE, crateToJsonString(crate));
    log(`Wrote ${JSON_FILE}.`, "ok");
  } else log(`${JSON_FILE} exists and overwrite is off — skipped.`, "warn");

  // ro-crate-metadata.xlsx
  if (options.makeXlsx) {
    if (options.overwrite || !(await fileExists(dirHandle, XLSX_FILE))) {
      const bytes = await crateToXlsxBytes(crate);
      await writeFile(dirHandle, XLSX_FILE, bytes);
      log(`Wrote ${XLSX_FILE}.`, "ok");
    } else log(`${XLSX_FILE} exists and overwrite is off — skipped.`, "warn");
  }

  // ro-crate-preview.html
  if (options.makeHtml) {
    if (options.overwrite || !(await fileExists(dirHandle, HTML_FILE))) {
      try {
        let html;
        const urlSelected = !!options.templateSourceUrl;
        const repoSelected = !!options.templateRepoPreset;
        const sourceUrl = (options.templateSourceUrlValue || "").trim();
        if (options.styledPreview || urlSelected || repoSelected) {
          // Precedence for template/config/style: uploaded file → URL folder → local folder.
          let template = null, templateSrc = "none";
          let cfg = null, cfgSrc = "none";
          let css = "", cssSrc = "none";

          if (repoSelected) {
            const selectedFolder = (options.templateRepoFolder || "").trim();
            if (!selectedFolder) throw new Error("Template repo source is selected but no template folder was chosen.");
            const repoUrl = buildGitHubTreeUrl(TEMPLATE_REPO_OWNER, TEMPLATE_REPO_NAME, TEMPLATE_REPO_REF, selectedFolder);
            const remote = await fetchTemplateBundleFromUrl(repoUrl);
            template = remote.template;
            cfg = remote.config;
            css = remote.css;
            const base = `repo (${selectedFolder})`;
            templateSrc = describeRemoteSource(base, remote.files.template, `${base}; no template found`);
            cfgSrc = describeRemoteSource(base, remote.files.config, "none");
            cssSrc = describeRemoteSource(base, remote.files.style, "none");
          }

          if (urlSelected) {
            if (!sourceUrl) throw new Error("Template folder URL is selected but no URL was provided.");
            const remote = await fetchTemplateBundleFromUrl(sourceUrl);
            template = remote.template;
            cfg = remote.config;
            css = remote.css;
            const base = `URL (${remote.sourceLabel})`;
            templateSrc = describeRemoteSource(base, remote.files.template, `${base}; no template found`);
            cfgSrc = describeRemoteSource(base, remote.files.config, "none");
            cssSrc = describeRemoteSource(base, remote.files.style, "none");
          }

          if (options.styledPreview && options.configUpload) {
            const cfgText = await options.configUpload.file.text();
            try { cfg = JSON.parse(cfgText); }
            catch (e) { throw new Error(`uploaded config "${options.configUpload.name}" is not valid JSON: ${e.message}`); }
            cfgSrc = `uploaded (${options.configUpload.name})`;
          } else if (!urlSelected && !repoSelected) {
            const folderCfg = await readJsonFromFolder(dirHandle, "preview-config.json");
            if (folderCfg) { cfg = folderCfg; cfgSrc = "preview-config.json from folder"; }
          }

          if (options.styledPreview && cfg) {
            const uploadedFiles = options.configUpload?.siblingFiles || null;
            let configDirHandle = null;
            if (needsLocalTemplateFolder(cfg, uploadedFiles)) {
              configDirHandle = await ensureUploadedConfigDirectoryHandle();
            }
            const resolved = await resolveTemplateBundleFromConfig(cfg, {
              uploadedFiles,
              dirHandle: configDirHandle,
            });
            if (resolved.template) { template = resolved.template; templateSrc = resolved.templateSrc; }
            if (resolved.css) { css = resolved.css; cssSrc = resolved.cssSrc; }
          }
          if (template) {
            log(`Preview: styled tabular · template ${templateSrc} · config ${cfgSrc} · style ${cssSrc}.`, "muted");
            html = await crateToPreviewHtml(crate, { template, config: cfg, css });
          } else {
            log("Preview: plain (library default template; no custom template file provided).", "muted");
            html = await crateToPreviewHtml(crate);
          }
        } else {
          log("Preview: plain (library default template).", "muted");
          html = await crateToPreviewHtml(crate);
        }
        await writeFile(dirHandle, HTML_FILE, html);
        log(`Wrote ${HTML_FILE}.`, "ok");
      } catch (e) {
        log(`HTML preview failed: ${e.message}`, "err");
      }
    } else log(`${HTML_FILE} exists and overwrite is off — skipped.`, "warn");
  }

  return { files: filesWithMeta.length, entities };
}

let buildHtml = null;  // ro-crate-preview.html captured after the last successful build

async function run() {
  if (!dirHandle) return;
  const runBtn = $("runBtn");
  runBtn.disabled = true; runBtn.textContent = "Building…";
  $("showHtmlBtn").classList.add("hidden"); buildHtml = null;
  const started = performance.now();
  $("statFiles").textContent = "—"; $("statEntities").textContent = "—"; $("statTime").textContent = "—";
  try {
    if (!(await verifyPermission(dirHandle, true))) { log("Permission to read/write the folder was denied.", "err"); return; }
    const options = readOptions();
    const files = await walkDirectory(dirHandle);
    const result = await processFolder(dirHandle, files, options);
    $("statFiles").textContent = result.files;
    $("statEntities").textContent = result.entities;
    const secs = ((performance.now() - started) / 1000).toFixed(2);
    $("statTime").textContent = secs + "s";
    log("Done in " + secs + "s.", "ok");
    // Capture the generated preview so the build-view button can open it in a
    // new tab synchronously (no await between the click and window.open).
    buildHtml = await readFileText(dirHandle, HTML_FILE);
    if (buildHtml !== null) $("showHtmlBtn").classList.remove("hidden");
    // A build always writes ro-crate-metadata.json (or it already existed), so
    // the context bar's Show button can now be enabled.
    $("showBtn").disabled = false;
  } catch (e) {
    log("Error: " + (e && e.message ? e.message : e), "err");
    console.error(e);
  } finally {
    runBtn.disabled = false; runBtn.textContent = "Build RO-Crate";
    $("saveLogBtn").disabled = false;
  }
}

/* ---------- actions ---------- */
async function pickFolder() {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if (e && e.name === "AbortError") return;
    console.error("Could not open folder:", e);
    return;
  }
  $("ctxFolder").textContent = dirHandle.name;
  await refreshModeCards();
  showView("view-mode");
}

// Offer "Show" only when the folder already has crate output to view:
// an ro-crate-metadata.json or an ro-crate-preview.html. A fresh folder with
// neither shows the Build card alone, and the context bar's Show button (in
// build mode) stays disabled until a build produces one of those files.
async function refreshModeCards() {
  let hasJson = false, hasHtml = false;
  if (dirHandle) {
    try {
      hasJson = await fileExists(dirHandle, JSON_FILE);
      hasHtml = await fileExists(dirHandle, HTML_FILE);
    } catch { /* treat as none → hide Show */ }
  }
  $("cardShow").classList.toggle("hidden", !(hasJson || hasHtml));
  $("showBtn").disabled = !(hasJson || hasHtml);
}
function openBuild() {
  clearLog();
  $("showHtmlBtn").classList.add("hidden");
  $("saveLogBtn").disabled = true;
  log("Set your options, then click Build RO-Crate.", "muted");
  refreshModeCards();
  showView("view-build");
}

// Download the current build log as a .log file.
function saveLog() {
  const text = $("log").textContent || "";
  if (!text.trim()) return;
  const name = `resources2crate-${dirHandle ? dirHandle.name : "build"}.log`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
let showHtml = null, showJson = null, previewUrl = null;
let previewFileUrls = [];

function revokePreviewUrls() {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  previewFileUrls.forEach((u) => URL.revokeObjectURL(u));
  previewFileUrls = [];
}

function isAbsoluteLikeUrl(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//") || value.startsWith("#");
}

function splitUrlParts(value) {
  const hashIdx = value.indexOf("#");
  const queryIdx = value.indexOf("?");
  const cut = [hashIdx, queryIdx].filter((n) => n >= 0).reduce((a, b) => Math.min(a, b), value.length);
  return {
    base: value.slice(0, cut),
    suffix: value.slice(cut),
  };
}

function normalizeRelativePath(value) {
  let v = (value || "").trim();
  if (!v) return "";
  try { v = decodeURIComponent(v); } catch { /* keep as-is */ }
  v = v.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const out = [];
  for (const part of v.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

async function buildFileUrlMap(handle) {
  const map = new Map();
  const created = [];
  async function walk(h, prefix = "") {
    for await (const entry of h.values()) {
      if (entry.kind === "directory") {
        const next = prefix ? `${prefix}/${entry.name}` : entry.name;
        await walk(entry, next);
        continue;
      }
      if (entry.kind !== "file") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = await entry.getFile();
      const url = URL.createObjectURL(file);
      created.push(url);
      map.set(rel, url);
      // Accept both encoded and decoded lookup forms.
      map.set(encodeURI(rel), url);
    }
  }
  await walk(handle, "");
  return { map, created };
}

async function materializePreviewHtml(html, handle) {
  const { map, created } = await buildFileUrlMap(handle);
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("[src],[href]")) {
    for (const attr of ["src", "href"]) {
      const raw = el.getAttribute(attr);
      if (!raw || isAbsoluteLikeUrl(raw)) continue;
      const { base, suffix } = splitUrlParts(raw);
      const key = normalizeRelativePath(base);
      if (!key) continue;
      const mapped = map.get(key) || map.get(encodeURI(key));
      if (mapped) el.setAttribute(attr, mapped + suffix);
    }
  }
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, created };
}

async function openShow() {
  if (!dirHandle) return;
  try {
    if (!(await verifyPermission(dirHandle, false))) return;
    showHtml = await readFileText(dirHandle, HTML_FILE);
    showJson = await readFileText(dirHandle, JSON_FILE);
    if (showHtml === null && showJson === null) { $("modal").classList.remove("hidden"); return; }
    showView("view-show");
    renderShow(showHtml !== null ? "preview" : "json");
  } catch (e) {
    $("showFileName").textContent = "";
    $("showPreview").classList.add("hidden");
    const pane = $("showPane");
    pane.classList.remove("hidden");
    pane.textContent = "Error reading the RO-Crate: " + (e && e.message ? e.message : e);
    showView("view-show");
  }
}

function renderShow(mode) {
  const preview = $("showPreview"), pane = $("showPane");
  const tabP = $("showTabPreview"), tabJ = $("showTabJson");
  // Fall back to whichever file is present if the requested one is missing.
  if (mode === "preview" && showHtml === null) mode = "json";
  if (mode === "json" && showJson === null) mode = "preview";

  tabP.disabled = showHtml === null;
  tabJ.disabled = showJson === null;
  tabP.classList.toggle("active", mode === "preview");
  tabJ.classList.toggle("active", mode === "json");

  if (mode === "preview") {
    $("showFileName").textContent = HTML_FILE;
    pane.classList.add("hidden");
    pane.textContent = "";
    preview.classList.remove("hidden");
  } else {
    let pretty = showJson;
    try { pretty = JSON.stringify(JSON.parse(showJson), null, 2); } catch { /* raw */ }
    $("showFileName").textContent = JSON_FILE;
    preview.classList.add("hidden");
    pane.classList.remove("hidden");
    pane.textContent = pretty;
  }
}

// Open HTML as a real document in a new browser tab. The generated
// ro-crate-preview.html relies on in-page (:target) links to toggle tables,
// which don't work inside an embedded/srcdoc frame, so it needs its own URL.
// Must be called synchronously from a click handler (no awaits before it) so
// the browser doesn't treat window.open as an unsolicited popup.
async function openHtmlInNewTab(html) {
  if (!html) return;
  const popup = window.open("about:blank", "_blank");
  if (!popup) return;
  popup.document.title = "Loading preview...";
  popup.document.body.textContent = "Loading preview...";
  try {
    revokePreviewUrls();
    let toOpen = html;
    if (dirHandle) {
      const materialized = await materializePreviewHtml(html, dirHandle);
      toOpen = materialized.html;
      previewFileUrls = materialized.created;
    }
    previewUrl = URL.createObjectURL(new Blob([toOpen], { type: "text/html" }));
    popup.location.replace(previewUrl);
  } catch (e) {
    popup.document.body.textContent = "Failed to open preview: " + (e && e.message ? e.message : e);
    console.error(e);
  }
}
function openPreviewWindow() { openHtmlInNewTab(showHtml); }

/* ---------- boot ---------- */
function boot() {
  if (!("showDirectoryPicker" in window)) { $("unsupported").classList.remove("hidden"); return; }
  $("app").classList.remove("hidden");
  buildForm();
  showView("view-folder");

  $("pickBtn").addEventListener("click", pickFolder);
  $("changeFolderBtn").addEventListener("click", pickFolder);
  $("menuBtn").addEventListener("click", async () => { await refreshModeCards(); showView("view-mode"); });
  $("settingsBtn").addEventListener("click", () => $("settingsModal").classList.remove("hidden"));
  $("settingsClose").addEventListener("click", () => $("settingsModal").classList.add("hidden"));
  $("settingsModal").addEventListener("click", (e) => { if (e.target === $("settingsModal")) $("settingsModal").classList.add("hidden"); });
  $("mergeMappingCancel").addEventListener("click", () => $("mergeMappingModal").classList.add("hidden"));
  $("mergeMappingApply").addEventListener("click", applyMergeMapping);
  $("mergeMappingModal").addEventListener("click", (e) => { if (e.target === $("mergeMappingModal")) $("mergeMappingModal").classList.add("hidden"); });
  $("mappingConfigFile").addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length) loadMappingConfigFile(e.target.files[0]);
  });
  $("mappingConfigDrop").addEventListener("dragover", (e) => { e.preventDefault(); $("mappingConfigDrop").classList.add("drag"); });
  $("mappingConfigDrop").addEventListener("dragleave", () => $("mappingConfigDrop").classList.remove("drag"));
  $("mappingConfigDrop").addEventListener("drop", (e) => {
    e.preventDefault(); $("mappingConfigDrop").classList.remove("drag");
    if (e.dataTransfer.files && e.dataTransfer.files.length) loadMappingConfigFile(e.dataTransfer.files[0]);
  });
  $("mappingSheetSelect").addEventListener("change", async (e) => {
    const name = e.target.value;
    try {
      await refreshMergeMappingSheet(name);
    } catch (err) {
      alert("Could not read sheet: " + (err && err.message ? err.message : err));
    }
  });
  $("cardBuild").addEventListener("click", openCrateDetails);
  $("cardShow").addEventListener("click", openShow);
  $("showBtn").addEventListener("click", openShow);
  $("showTabPreview").addEventListener("click", () => renderShow("preview"));
  $("showTabJson").addEventListener("click", () => renderShow("json"));
  $("openPreviewBtn").addEventListener("click", openPreviewWindow);
  const key = (fn) => (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };
  $("cardBuild").addEventListener("keydown", key(openCrateDetails));
  $("cardShow").addEventListener("keydown", key(openShow));
  $("crateDetailsBackBtn").addEventListener("click", () => showView("view-mode"));
  $("crateDetailsContinueBtn").addEventListener("click", submitCrateDetails);
  $("runBtn").addEventListener("click", run);
  $("showHtmlBtn").addEventListener("click", () => openHtmlInNewTab(buildHtml));
  $("saveLogBtn").addEventListener("click", saveLog);
  $("rebuildBtn").addEventListener("click", openCrateDetails);
  $("modalCancel").addEventListener("click", () => $("modal").classList.add("hidden"));
  $("modalBuild").addEventListener("click", () => { $("modal").classList.add("hidden"); openCrateDetails(); });
}
boot();
