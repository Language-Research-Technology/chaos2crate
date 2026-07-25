// resources2crate — browser UI + File System Access wiring.
// The crate assembly and output generation live in ./crate.js (library-based,
// isomorphic). This file only handles picking a folder, reading/writing files,
// and the stepped Build/Show UI.

import {
  buildFileMetadata, buildCrate, crateToJsonString, crateToXlsxBytes, crateToPreviewHtml,
  mergeXlsxIntoCrate, readXlsxHeaders, readXlsxContextPrefixes, loadCrateFromJson, GENERATED_FILENAMES, CONTROL_FILENAMES,
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
    { key: "templateRepoFolder", type: "select", label: "Template from rocss-template-repo",
      placeholder: "Loading folders…", hint: "Optional. Select one folder from the template repo." },
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
  { key: "themeMode", type: "select", label: "Theme", default: "light",
    options: [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    hint: "Switches the interface between light and dark modes." },
  { key: "topLevelFolderType", type: "select", label: "Top-level folders are", default: "object",
    options: [
      { value: "object", label: "Objects (RepositoryObject)" },
      { value: "collection", label: "Collections (RepositoryCollection)" },
    ],
    hint: "When Collections is selected, child folders are emitted as RepositoryObjects; files directly inside a top-level folder are grouped into an object named Files." },
  { key: "overwrite", label: "Overwrite existing outputs", default: true },
  { key: "makeXlsx", label: "Generate ro-crate-metadata.xlsx", default: true },
  { key: "includeSampleData", label: "Include sample data entities", default: false,
    hint: "Adds entities from sample-data.json (or built-in defaults) to the crate graph." },
  { key: "enableLocalTemplateUpload", label: "Enable local template upload", default: false,
    hint: "Shows or hides the Upload template files option in Build settings." },
  { key: "includeAlternateNames", label: "Match Austlang alternate names", default: false,
    hint: "Only applies when \u201cIdentify subject languages\u201d is on. More matches, more false positives." },
];

/* ---------- DOM helpers ---------- */
const $ = (id) => document.getElementById(id);
const logEl = () => $("log");
const SETTINGS_STORAGE_KEY = "resources2crate.settings";

function normalizeThemeMode(value) {
  return value === "dark" ? "dark" : "light";
}

function applyThemeMode(value) {
  document.documentElement.setAttribute("data-theme", normalizeThemeMode(value));
}

function defaultSettingsFromSchema(schema) {
  const defaults = {};
  for (const opt of schema) {
    if (opt.type === "file" || opt.type === "mappingBuilder") continue;
    if (opt.type === "select") defaults[opt.key] = typeof opt.default === "string" ? opt.default : "";
    else defaults[opt.key] = !!opt.default;
    if (opt.children) Object.assign(defaults, defaultSettingsFromSchema(opt.children));
  }
  return defaults;
}

function loadSettingsState() {
  const defaults = defaultSettingsFromSchema(SETTINGS_SCHEMA);
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}") || {};
  } catch {
    saved = {};
  }
  const merged = { ...defaults, ...saved };
  merged.themeMode = normalizeThemeMode(merged.themeMode);
  return merged;
}

function applySettingsToUi(schema, values) {
  for (const opt of schema) {
    if (opt.type === "file" || opt.type === "mappingBuilder") continue;
    const el = $("opt_" + opt.key);
    if (!el) continue;
    if (opt.type === "select") {
      const v = values[opt.key];
      if (typeof v === "string") el.value = v;
    } else {
      el.checked = !!values[opt.key];
    }
    if (opt.children) applySettingsToUi(opt.children, values);
  }
}

function saveSettingsState(values) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(values));
}

function readSettingsFromUi() {
  const values = {};
  collectOptions(SETTINGS_SCHEMA, values);
  values.themeMode = normalizeThemeMode(values.themeMode);
  return values;
}

function persistSettingsFromUi() {
  const values = readSettingsFromUi();
  saveSettingsState(values);
  applyThemeMode(values.themeMode);
}

function syncLogActionButtons() {
  const text = (logEl().textContent || "").trim();
  const hasLog = text.length > 0;
  const clearBtn = $("clearLogBtn");
  const saveBtn = $("saveLogBtn");
  if (clearBtn) clearBtn.disabled = !hasLog;
  if (saveBtn && !hasLog) saveBtn.disabled = true;
}

function log(msg, cls = "info") {
  const span = document.createElement("span");
  span.className = "l-" + cls;
  span.textContent = msg + "\n";
  logEl().appendChild(span);
  logEl().scrollTop = logEl().scrollHeight;
  syncLogActionButtons();
}
function clearLog() {
  logEl().textContent = "";
  syncLogActionButtons();
}

function collectTypeCounts(graph) {
  const counts = new Map();
  for (const entity of graph || []) {
    const raw = entity && entity["@type"];
    const types = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (!types.length) {
      counts.set("(none)", (counts.get("(none)") || 0) + 1);
      continue;
    }
    for (const type of types) {
      const key = String(type || "").trim() || "(none)";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => (b.count - a.count) || a.type.localeCompare(b.type));
}

function renderTypeStatus(typeCounts) {
  const host = $("typeStatus");
  if (!host) return;
  host.innerHTML = "";
  if (!typeCounts || !typeCounts.length) {
    const empty = document.createElement("span");
    empty.className = "type-empty";
    empty.textContent = "No entity types found.";
    host.appendChild(empty);
    return;
  }
  typeCounts.forEach((item) => {
    const pill = document.createElement("span");
    pill.className = "type-pill";
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = item.type;
    const v = document.createElement("span");
    v.className = "v";
    v.textContent = String(item.count);
    pill.append(k, v);
    host.appendChild(pill);
  });
}

/* ---------- view routing ---------- */
const VIEWS = ["view-mode", "view-crate-details", "view-build", "view-show", "view-edit"];
function showView(name) {
  for (const v of VIEWS) $(v).classList.toggle("hidden", v !== name);
  $("contextBar").classList.toggle("hidden", !dirHandle);
  $("menuBtn").classList.toggle("hidden", !(name === "view-build" || name === "view-show" || name === "view-edit"));
  $("settingsBtn").classList.toggle("hidden", name !== "view-build");
  $("showBtn").classList.toggle("hidden", !(name === "view-build" || name === "view-edit"));
  $("editBtn").classList.toggle("hidden", !(name === "view-build" || name === "view-show"));
  $("rebuildBtn").classList.toggle("hidden", !(name === "view-show" || name === "view-edit"));
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
  loadTemplateRepoFolderOptions();
  const settings = $("settingsForm");
  settings.innerHTML = "";
  renderOptions(SETTINGS_SCHEMA, settings);

  const settingsState = loadSettingsState();
  applySettingsToUi(SETTINGS_SCHEMA, settingsState);
  applyThemeMode(settingsState.themeMode);

  settings.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("change", persistSettingsFromUi);
  });

  const localTemplateToggle = $("opt_enableLocalTemplateUpload");
  if (localTemplateToggle) localTemplateToggle.addEventListener("change", refreshTemplateUploadVisibility);
  const uploadTemplateOpt = $("opt_styledPreview");
  if (uploadTemplateOpt) uploadTemplateOpt.addEventListener("change", resetTemplateRepoSelectionWhenUploadEnabled);
  const templateRepoSelect = $("opt_templateRepoFolder");
  if (templateRepoSelect) templateRepoSelect.addEventListener("change", uncheckUploadWhenTemplateRepoSelected);
  refreshTemplateUploadVisibility();
}

function resetTemplateRepoSelectionWhenUploadEnabled() {
  const uploadTemplateOpt = $("opt_styledPreview");
  const templateRepoSelect = $("opt_templateRepoFolder");
  if (!uploadTemplateOpt || !templateRepoSelect) return;
  if (uploadTemplateOpt.checked) templateRepoSelect.value = "";
}

function uncheckUploadWhenTemplateRepoSelected() {
  const uploadTemplateOpt = $("opt_styledPreview");
  const templateRepoSelect = $("opt_templateRepoFolder");
  if (!uploadTemplateOpt || !templateRepoSelect) return;
  if (!templateRepoSelect.value) return;
  if (uploadTemplateOpt.checked) {
    uploadTemplateOpt.checked = false;
    uploadTemplateOpt.dispatchEvent(new Event("change"));
  }
}

function refreshTemplateUploadVisibility() {
  const localTemplateToggle = $("opt_enableLocalTemplateUpload");
  const uploadField = $("field_opt_styledPreview");
  if (!localTemplateToggle || !uploadField) return;

  const enabled = !!localTemplateToggle.checked;
  uploadField.classList.toggle("hidden", !enabled);

  if (!enabled) {
    const uploadOpt = $("opt_styledPreview");
    if (uploadOpt && uploadOpt.checked) {
      uploadOpt.checked = false;
      uploadOpt.dispatchEvent(new Event("change"));
    }
  }
}

function renderOptions(schema, parent) {
  for (const opt of schema) {
    if (opt.type === "file") { parent.appendChild(buildFileField(opt)); continue; }
    if (opt.type === "select") { parent.appendChild(buildSelectField(opt)); continue; }
    if (opt.type === "mappingBuilder") { parent.appendChild(buildMappingBuilderField(opt)); continue; }

    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.id = "field_opt_" + opt.key;
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

function resetCrateDetailsForm() {
  $("cd_id").value = "";
  $("cd_name").value = "";
  $("cd_description").value = "";
  $("cd_datePublished").value = "";
  $("cd_inLanguage").value = "";
  $("cd_license").value = "";
  $("cd_creator").value = "";
}

function resolveLinkedName(value, byId) {
  if (!value) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = resolveLinkedName(item, byId);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "string") {
    const ref = byId.get(value);
    if (ref && typeof ref.name === "string" && ref.name.trim()) return ref.name.trim();
    return value.trim();
  }
  if (typeof value === "object") {
    if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
    const refId = typeof value["@id"] === "string" ? value["@id"] : "";
    if (refId) {
      const ref = byId.get(refId);
      if (ref && typeof ref.name === "string" && ref.name.trim()) return ref.name.trim();
      return refId;
    }
  }
  return "";
}

function getRootDatasetEntity(crateJson) {
  const graph = Array.isArray(crateJson && crateJson["@graph"]) ? crateJson["@graph"] : [];
  if (!graph.length) return null;

  const byId = new Map();
  for (const entity of graph) {
    const id = entity && entity["@id"];
    if (typeof id === "string") byId.set(id, entity);
  }

  let root = byId.get("./") || null;
  if (!root) {
    const md = byId.get("ro-crate-metadata.json");
    const about = md && md.about;
    const aboutId = typeof about === "string" ? about : (about && typeof about["@id"] === "string" ? about["@id"] : "");
    if (aboutId && byId.has(aboutId)) root = byId.get(aboutId);
  }
  if (!root) {
    root = graph.find((entity) => {
      const t = entity && entity["@type"];
      const types = Array.isArray(t) ? t : (t ? [t] : []);
      return types.includes("Dataset") && entity["@id"] !== "ro-crate-metadata.json";
    }) || null;
  }
  if (!root) return null;
  return { root, byId };
}

async function populateCrateDetailsFromExistingCrate(handle) {
  const crateJson = await readJsonFromFolder(handle, JSON_FILE);
  if (!crateJson) return false;

  const extracted = getRootDatasetEntity(crateJson);
  if (!extracted) return false;

  const { root, byId } = extracted;
  const rootId = typeof root["@id"] === "string" ? root["@id"].trim() : "";
  if (rootId) {
    $("cd_id").value = rootId.replace(/^arcp:\/\/name,/i, "");
  }
  if (typeof root.name === "string") $("cd_name").value = root.name;
  if (typeof root.description === "string") $("cd_description").value = root.description;

  if (typeof root.datePublished === "string" && root.datePublished.trim()) {
    const isoDate = root.datePublished.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) $("cd_datePublished").value = isoDate;
  }

  const license = root.license;
  if (typeof license === "string" && license.trim()) {
    $("cd_license").value = license.trim();
  } else if (license && typeof license === "object" && typeof license["@id"] === "string") {
    $("cd_license").value = license["@id"].trim();
  }

  const languageName = resolveLinkedName(root.inLanguage, byId);
  if (languageName) $("cd_inLanguage").value = languageName;

  const creatorName = resolveLinkedName(root.creator, byId);
  if (creatorName) $("cd_creator").value = creatorName;

  return true;
}

function submitCrateDetails() {
  rootDatasetOverride = buildRootDatasetFromForm();
  refreshBuildStepActions();
  showView("view-mode");
}

function refreshBuildStepActions() {
  const describeBtn = $("buildStepDescribe");
  const buildBtn = $("buildStepOpenBuild");
  if (!describeBtn || !buildBtn) return;
  const hasFolder = !!dirHandle;
  const hasDescribe = !!rootDatasetOverride;
  describeBtn.disabled = !hasFolder;
  buildBtn.disabled = !(hasFolder && hasDescribe);
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

function buildGitHubTreeUrl(owner, repo, ref, folderPath) {
  const safePath = String(folderPath || "").split("/").map((p) => encodeURIComponent(p)).join("/");
  return `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(ref)}/${safePath}`;
}

function buildGitHubRawUrl(owner, repo, ref, filePath) {
  const safePath = String(filePath || "").split("/").map((p) => encodeURIComponent(p)).join("/");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${safePath}`;
}

async function fetchGitHubTextFile(owner, repo, ref, filePath, downloadUrl = "") {
  const url = downloadUrl || buildGitHubRawUrl(owner, repo, ref, filePath);
  const res = await fetch(bustCacheUrl(url), { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not download ${filePath} (${res.status} ${res.statusText}).`);
  return await res.text();
}

async function fetchTemplateBundle(owner, repo, ref, folderPath) {
  const safeFolder = String(folderPath || "").replace(/^\/+|\/+$/g, "");
  if (!safeFolder) throw new Error("No template folder selected.");

  const encodedFolder = safeFolder.split("/").map((p) => encodeURIComponent(p)).join("/");
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFolder}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(apiUrl, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`Could not list template folder "${safeFolder}" (${res.status} ${res.statusText}).`);
  const entries = await res.json();
  if (!Array.isArray(entries)) throw new Error(`Unexpected API response for template folder "${safeFolder}".`);

  const files = entries
    .filter((e) => e && e.type === "file" && typeof e.name === "string")
    .map((e) => ({
      name: e.name,
      path: e.path || `${safeFolder}/${e.name}`,
      downloadUrl: typeof e.download_url === "string" ? e.download_url : "",
      type: "file",
    }));

  const templateFile = pickPreferredFile(files, ".html", ["template", "tabular", "preview", "index"]);
  const configFile = pickPreferredFile(files, ".json", ["config", "preview"]);
  const styleFile = pickPreferredFile(files, ".css", ["style", "preview", "default"]);

  const template = templateFile
    ? await fetchGitHubTextFile(owner, repo, ref, templateFile.path, templateFile.downloadUrl)
    : null;
  const configText = configFile
    ? await fetchGitHubTextFile(owner, repo, ref, configFile.path, configFile.downloadUrl)
    : null;
  const css = styleFile
    ? await fetchGitHubTextFile(owner, repo, ref, styleFile.path, styleFile.downloadUrl)
    : "";

  let config = null;
  if (configText !== null) {
    try { config = JSON.parse(configText); }
    catch (e) { throw new Error(`Template config ${configFile.name} is not valid JSON: ${e.message}`); }
  }

  return {
    template,
    config,
    css,
    files: {
      template: templateFile ? templateFile.name : null,
      config: configFile ? configFile.name : null,
      style: styleFile ? styleFile.name : null,
    },
    source: buildGitHubTreeUrl(owner, repo, ref, safeFolder),
  };
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

  const graph = crate.getJson()["@graph"] || [];
  const entities = graph.length;
  const typeCounts = collectTypeCounts(graph);

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
        const selectedFolder = (options.templateRepoFolder || "").trim();
        const repoSelected = !!selectedFolder;
        if (options.styledPreview || repoSelected) {
          // Precedence for template/config/style: repo folder → uploaded file → local folder.
          let template = null, templateSrc = "none";
          let cfg = null, cfgSrc = "none";
          let css = "", cssSrc = "none";

          if (repoSelected) {
            const remote = await fetchTemplateBundle(TEMPLATE_REPO_OWNER, TEMPLATE_REPO_NAME, TEMPLATE_REPO_REF, selectedFolder);
            template = remote.template;
            cfg = remote.config;
            css = remote.css;
            const base = `repo (${selectedFolder})`;
            templateSrc = remote.files.template ? `${base}/${remote.files.template}` : `${base}; no template found`;
            cfgSrc = remote.files.config ? `${base}/${remote.files.config}` : "none";
            cssSrc = remote.files.style ? `${base}/${remote.files.style}` : "none";
          }

          if (options.styledPreview && options.configUpload) {
            const cfgText = await options.configUpload.file.text();
            try { cfg = JSON.parse(cfgText); }
            catch (e) { throw new Error(`uploaded config "${options.configUpload.name}" is not valid JSON: ${e.message}`); }
            cfgSrc = `uploaded (${options.configUpload.name})`;
          } else if (!repoSelected) {
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
            lastHtmlTemplate = { template, config: cfg, css, source: templateSrc };
          } else {
            log("Preview: plain (library default template; no custom template file provided).", "muted");
            html = await crateToPreviewHtml(crate);
            lastHtmlTemplate = null;
          }
        } else {
          log("Preview: plain (library default template).", "muted");
          html = await crateToPreviewHtml(crate);
          lastHtmlTemplate = null;
        }
        await writeFile(dirHandle, HTML_FILE, html);
        log(`Wrote ${HTML_FILE}.`, "ok");
      } catch (e) {
        log(`HTML preview failed: ${e.message}`, "err");
      }
    } else log(`${HTML_FILE} exists and overwrite is off — skipped.`, "warn");
  }

  return { files: filesWithMeta.length, entities, typeCounts };
}

let buildHtml = null;  // ro-crate-preview.html captured after the last successful build
// The styled template/config/css resolved by the most recent successful build
// in this session (null if that build used the plain template). Edit-save
// reuses this so it doesn't silently downgrade a styled preview to plain.
let lastHtmlTemplate = null;

async function run() {
  if (!dirHandle) return;
  const runBtn = $("runBtn");
  runBtn.disabled = true; runBtn.textContent = "Building…";
  $("showHtmlBtn").classList.add("hidden"); buildHtml = null;
  const started = performance.now();
  log("Build started at " + new Date().toLocaleTimeString() + ".", "muted");
  $("statFiles").textContent = "—"; $("statEntities").textContent = "—"; $("statTime").textContent = "—";
  renderTypeStatus([]);
  try {
    if (!(await verifyPermission(dirHandle, true))) { log("Permission to read/write the folder was denied.", "err"); return; }
    const options = readOptions();
    const files = await walkDirectory(dirHandle);
    const result = await processFolder(dirHandle, files, options);
    $("statFiles").textContent = result.files;
    $("statEntities").textContent = result.entities;
    renderTypeStatus(result.typeCounts);
    const secs = ((performance.now() - started) / 1000).toFixed(2);
    $("statTime").textContent = secs + "s";
    log("Done in " + secs + "s.", "ok");
    // Capture the generated preview so the build-view button can open it in a
    // new tab synchronously (no await between the click and window.open).
    buildHtml = await readFileText(dirHandle, HTML_FILE);
    if (buildHtml !== null) $("showHtmlBtn").classList.remove("hidden");
    // A build always writes ro-crate-metadata.json (or it already existed), so
    // the context bar's Show and Edit buttons can now be enabled.
    $("showBtn").disabled = false;
    $("editBtn").disabled = false;
  } catch (e) {
    log("Error: " + (e && e.message ? e.message : e), "err");
    console.error(e);
  } finally {
    runBtn.disabled = false; runBtn.textContent = "Build RO-Crate";
    $("saveLogBtn").disabled = false;
  }
}

/* ---------- actions ---------- */
async function pickFolder(nextView = "view-mode") {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if (e && e.name === "AbortError") return;
    console.error("Could not open folder:", e);
    return;
  }
  rootDatasetOverride = null;
  buildHtml = null;
  lastHtmlTemplate = null;
  resetCrateDetailsForm();
  try {
    await populateCrateDetailsFromExistingCrate(dirHandle);
  } catch (e) {
    console.warn("Could not prefill describe form from existing crate JSON:", e);
  }
  $("ctxFolder").textContent = dirHandle.name;
  await refreshModeCards();
  showView(nextView);
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
  $("cardEdit").classList.toggle("hidden", !hasJson);
  $("editBtn").disabled = !hasJson;
  refreshBuildStepActions();
}
function openBuild() {
  if (!confirmLeaveEditIfDirty()) return;
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

function clearLogPanel() {
  clearLog();
}

function isDescribeViewActive() {
  const view = $("view-crate-details");
  return !!(view && !view.classList.contains("hidden"));
}

function isBuildViewActive() {
  const view = $("view-build");
  return !!(view && !view.classList.contains("hidden"));
}

function isModalOpen() {
  const ids = ["modal", "settingsModal", "mergeMappingModal"];
  return ids.some((id) => {
    const el = $(id);
    return !!(el && !el.classList.contains("hidden"));
  });
}
let showHtml = null, showJson = null, previewUrl = null;
let previewFileUrls = [];
let showHasXlsx = false;
let showXlsxPreview = null;
let showXlsxSheetIndex = 0;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderWorksheetAsHtml(worksheet, maxRows = 200, maxCols = 20) {
  const bounds = worksheet.dimensions;
  if (!bounds) return `<div class="sheet-wrap"><div class="sheet-title">Sheet: ${escapeHtml(worksheet.name)}</div><div class="sheet-note">This worksheet is empty.</div></div>`;

  const rowEnd = Math.min(bounds.bottom, bounds.top + maxRows - 1);
  const colEnd = Math.min(bounds.right, bounds.left + maxCols - 1);
  const header = [];
  for (let c = bounds.left; c <= colEnd; c++) header.push(`<th>${escapeHtml(worksheet.getCell(bounds.top, c).text || "")}</th>`);

  const rows = [];
  for (let r = bounds.top + 1; r <= rowEnd; r++) {
    const cells = [];
    for (let c = bounds.left; c <= colEnd; c++) {
      cells.push(`<td>${escapeHtml(worksheet.getCell(r, c).text || "")}</td>`);
    }
    rows.push(`<tr>${cells.join("")}</tr>`);
  }

  const clippedRows = bounds.bottom > rowEnd;
  const clippedCols = bounds.right > colEnd;
  const note = clippedRows || clippedCols
    ? `<div class="sheet-note">Showing first ${rowEnd - bounds.top + 1} row(s) and ${colEnd - bounds.left + 1} column(s).</div>`
    : "";

  return [
    `<div class="sheet-wrap">`,
    `<div class="sheet-title">Sheet: ${escapeHtml(worksheet.name)}</div>`,
    note,
    `<table class="sheet-grid"><thead><tr>${header.join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
    `</div>`,
  ].join("");
}

async function readFileBytes(handle, filename) {
  const fh = await handle.getFileHandle(filename, { create: false });
  return await (await fh.getFile()).arrayBuffer();
}

async function buildXlsxPreviewData(handle) {
  const mod = await import("exceljs");
  const Workbook = mod.Workbook || (mod.default && mod.default.Workbook);
  if (!Workbook) throw new Error("Could not load Excel parser.");

  const bytes = await readFileBytes(handle, XLSX_FILE);
  const wb = new Workbook();
  await wb.xlsx.load(bytes);
  const sheets = wb.worksheets.map((ws) => ({
    name: ws.name || "Sheet",
    html: renderWorksheetAsHtml(ws),
  }));
  return { sheets };
}

function renderXlsxSheetInPane(index = 0) {
  const pane = $("showPane");
  const data = showXlsxPreview;
  if (!pane || !data || !Array.isArray(data.sheets) || data.sheets.length === 0) {
    pane.innerHTML = `<div class="sheet-wrap"><div class="sheet-note">Workbook has no worksheets.</div></div>`;
    return;
  }

  const safeIndex = Math.max(0, Math.min(index, data.sheets.length - 1));
  showXlsxSheetIndex = safeIndex;
  const options = data.sheets.map((s, i) => (
    `<option value="${i}"${i === safeIndex ? " selected" : ""}>${escapeHtml(s.name)}</option>`
  )).join("");

  pane.innerHTML = [
    `<div class="sheet-wrap">`,
    `<div class="sheet-switch">`,
    `<label for="showXlsxSheetSelect" class="sheet-switch-label">Sheet</label>`,
    `<select id="showXlsxSheetSelect" class="sheet-switch-select">${options}</select>`,
    `</div>`,
    data.sheets[safeIndex].html,
    `</div>`,
  ].join("");

  const select = $("showXlsxSheetSelect");
  if (select) {
    select.addEventListener("change", () => {
      const next = Number.parseInt(select.value, 10);
      renderXlsxSheetInPane(Number.isNaN(next) ? 0 : next);
    });
  }
}

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
  if (!confirmLeaveEditIfDirty()) return;
  try {
    if (!(await verifyPermission(dirHandle, false))) return;
    showHtml = await readFileText(dirHandle, HTML_FILE);
    showJson = await readFileText(dirHandle, JSON_FILE);
    showHasXlsx = await fileExists(dirHandle, XLSX_FILE);
    showXlsxPreview = null;
    showXlsxSheetIndex = 0;
    if (showHtml === null && showJson === null && !showHasXlsx) { $("modal").classList.remove("hidden"); return; }
    showView("view-show");
    await renderShow(showHtml !== null ? "preview" : (showJson !== null ? "json" : "xlsx"));
  } catch (e) {
    $("showFileName").textContent = "";
    $("showPreview").classList.add("hidden");
    const pane = $("showPane");
    pane.classList.remove("sheet-mode");
    pane.classList.remove("hidden");
    pane.textContent = "Error reading the RO-Crate: " + (e && e.message ? e.message : e);
    showView("view-show");
  }
}

async function renderShow(mode) {
  const preview = $("showPreview"), pane = $("showPane");
  const tabP = $("showTabPreview"), tabJ = $("showTabJson"), tabX = $("showTabXlsx");
  // Fall back to whichever file is present if the requested one is missing.
  if (mode === "preview" && showHtml === null) mode = "json";
  if (mode === "json" && showJson === null) mode = showHasXlsx ? "xlsx" : "preview";
  if (mode === "xlsx" && !showHasXlsx) mode = showJson !== null ? "json" : "preview";

  tabP.disabled = showHtml === null;
  tabJ.disabled = showJson === null;
  tabX.disabled = !showHasXlsx;
  tabP.classList.toggle("active", mode === "preview");
  tabJ.classList.toggle("active", mode === "json");
  tabX.classList.toggle("active", mode === "xlsx");

  if (mode === "preview") {
    $("showFileName").textContent = HTML_FILE;
    pane.classList.remove("sheet-mode");
    pane.classList.add("hidden");
    pane.textContent = "";
    pane.innerHTML = "";
    preview.classList.remove("hidden");
  } else if (mode === "xlsx") {
    $("showFileName").textContent = XLSX_FILE;
    preview.classList.add("hidden");
    pane.classList.remove("hidden");
    pane.classList.add("sheet-mode");
    if (!showXlsxPreview) {
      pane.textContent = "Loading workbook preview...";
      try {
        showXlsxPreview = await buildXlsxPreviewData(dirHandle);
      } catch (e) {
        pane.classList.remove("sheet-mode");
        pane.textContent = "Could not render workbook preview: " + (e && e.message ? e.message : e);
        return;
      }
    }
    renderXlsxSheetInPane(showXlsxSheetIndex);
  } else {
    let pretty = showJson;
    try { pretty = JSON.stringify(JSON.parse(showJson), null, 2); } catch { /* raw */ }
    $("showFileName").textContent = JSON_FILE;
    preview.classList.add("hidden");
    pane.classList.remove("hidden");
    pane.classList.remove("sheet-mode");
    pane.innerHTML = "";
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

/* ---------- Edit ---------- */
// Loads ro-crate-metadata.json into a live ROCrate instance and edits it
// directly (setProperty/addEntity/deleteEntity/…), the same public API
// mergeXlsxIntoCrate already relies on. Saving re-serializes that instance
// through the same crateTo* functions the Build flow uses.
const EDIT_DESCRIPTOR_ID = "ro-crate-metadata.json";
const STRUCTURAL_ENTITY_TYPES = new Set(["File", "RepositoryObject", "RepositoryCollection"]);
const EDIT_NEW_TYPES = ["Person", "Organization", "Place", "Language", "License", "CreativeWork"];

let editCrate = null;
let editSelectedId = null;
let editDirty = false;

function asArray(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }
function entityTypes(entity) { return asArray(entity && entity["@type"]).map(String); }
function entityDisplayName(entity) {
  const names = asArray(entity && entity.name).filter((n) => typeof n === "string" && n.trim());
  return names.length ? names[0] : String((entity && entity["@id"]) || "");
}
function entityIdIsStructural(entity) {
  if (!entity || !editCrate) return true;
  const id = entity["@id"];
  if (id === editCrate.rootId || id === EDIT_DESCRIPTOR_ID) return true;
  return entityTypes(entity).some((t) => STRUCTURAL_ENTITY_TYPES.has(t));
}
function isEditViewActive() {
  const view = $("view-edit");
  return !!(view && !view.classList.contains("hidden"));
}
// Guard for switching away from Edit (Menu/Show/Build) with unsaved changes.
function confirmLeaveEditIfDirty() {
  if (!isEditViewActive() || !editDirty) return true;
  return confirm("You have unsaved changes in the crate editor. Discard them?");
}

function editLog(msg) {
  const el = $("editLog");
  if (!el) return;
  if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.classList.remove("hidden");
  el.textContent = msg;
}

function markEditDirty() {
  editDirty = true;
  updateEditSaveState();
}
function updateEditSaveState() {
  const btn = $("editSaveBtn");
  const badge = $("editDirtyBadge");
  if (btn) btn.disabled = !editDirty;
  if (badge) badge.classList.toggle("hidden", !editDirty);
}

async function openEdit() {
  if (!dirHandle) return;
  if (!confirmLeaveEditIfDirty()) return;
  try {
    if (!(await verifyPermission(dirHandle, true))) { alert("Permission to read/write the folder was denied."); return; }
    const text = await readFileText(dirHandle, JSON_FILE);
    if (text === null) { $("modal").classList.remove("hidden"); return; }
    let json;
    try { json = JSON.parse(text); }
    catch (e) { alert(`${JSON_FILE} is not valid JSON: ${e.message}`); return; }
    editCrate = loadCrateFromJson(json);
    editDirty = false;
    editLog("");
    updateEditSaveState();
    showView("view-edit");
    populateEditTypeFilter();
    refreshEditEntityIdOptions();
    renderEditEntityList();
    const firstId = editCrate.rootId
      || (editCrate.graph.find((e) => e["@id"] !== EDIT_DESCRIPTOR_ID) || {})["@id"]
      || null;
    selectEditEntity(firstId);
  } catch (e) {
    alert("Could not open the crate for editing: " + (e && e.message ? e.message : e));
    console.error(e);
  }
}

function populateEditTypeFilter() {
  const select = $("editTypeFilter");
  if (!select || !editCrate) return;
  const current = select.value;
  const types = new Set();
  editCrate.graph.forEach((e) => { if (e["@id"] !== EDIT_DESCRIPTOR_ID) entityTypes(e).forEach((t) => types.add(t)); });
  select.innerHTML = '<option value="">All types</option>' +
    [...types].sort().map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  select.value = [...types].includes(current) ? current : "";
}

function refreshEditEntityIdOptions() {
  const dl = $("editEntityIdOptions");
  if (!dl || !editCrate) return;
  dl.innerHTML = editCrate.graph
    .filter((e) => e["@id"] !== EDIT_DESCRIPTOR_ID)
    .map((e) => `<option value="${escapeHtml(e["@id"])}">${escapeHtml(entityDisplayName(e))}</option>`)
    .join("");
}

function editEntityMatchesFilter(entity, search, typeFilter) {
  if (typeFilter && !entityTypes(entity).includes(typeFilter)) return false;
  if (!search) return true;
  const hay = (entityDisplayName(entity) + " " + entity["@id"]).toLowerCase();
  return hay.includes(search);
}

function renderEditEntityList() {
  const host = $("editEntityList");
  if (!host || !editCrate) return;
  const search = ($("editSearch").value || "").trim().toLowerCase();
  const typeFilter = $("editTypeFilter").value || "";
  host.innerHTML = "";
  const entities = editCrate.graph
    .filter((e) => e["@id"] !== EDIT_DESCRIPTOR_ID)
    .filter((e) => editEntityMatchesFilter(e, search, typeFilter))
    .sort((a, b) => entityDisplayName(a).localeCompare(entityDisplayName(b)));
  if (!entities.length) {
    host.appendChild(hintEl("No entities match."));
    return;
  }
  entities.forEach((entity) => {
    const id = entity["@id"];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "entity-item" + (id === editSelectedId ? " active" : "");
    const isRoot = id === editCrate.rootId;
    item.innerHTML = [
      `<span class="entity-item-name">${escapeHtml(entityDisplayName(entity))}`,
      isRoot ? ` <span class="entity-root-badge">root</span>` : "",
      `</span>`,
      `<span class="entity-item-meta">`,
      `<span class="entity-item-type">${escapeHtml(entityTypes(entity).join(", ") || "Thing")}</span>`,
      `<span class="entity-item-id">${escapeHtml(id)}</span>`,
      `</span>`,
    ].join("");
    item.addEventListener("click", () => selectEditEntity(id));
    host.appendChild(item);
  });
}

function selectEditEntity(id) {
  editSelectedId = id || null;
  renderEditEntityList();
  renderEditForm();
}

// Distinguishes a property's editor: values that resolved (config.link) to
// another entity render as reference chips; everything else is a plain value.
function propValueKind(values) {
  const first = values.find((v) => v !== undefined && v !== null);
  return first && typeof first === "object" ? "ref" : "text";
}

function commitEditPropertyValues(id, prop, newValues) {
  if (!newValues.length) editCrate.deleteProperty(id, prop);
  else editCrate.setProperty(id, prop, newValues.length === 1 ? newValues[0] : newValues);
  markEditDirty();
}

function buildEditPropertyRow(entity, prop) {
  const row = document.createElement("div");
  row.className = "prop-row";
  const values = asArray(entity[prop]);
  const kind = propValueKind(values);

  const head = document.createElement("div");
  head.className = "prop-row-head";
  const label = document.createElement("span");
  label.className = "prop-label";
  label.textContent = prop;
  const delPropBtn = document.createElement("button");
  delPropBtn.type = "button"; delPropBtn.className = "prop-del-btn"; delPropBtn.title = "Delete property";
  delPropBtn.textContent = "×";
  delPropBtn.addEventListener("click", () => {
    editCrate.deleteProperty(editSelectedId, prop);
    markEditDirty();
    renderEditForm();
  });
  head.append(label, delPropBtn);
  row.appendChild(head);

  const valuesHost = document.createElement("div");
  valuesHost.className = "prop-values";
  row.appendChild(valuesHost);

  values.forEach((val, idx) => {
    const valRow = document.createElement("div");
    valRow.className = "value-row";
    if (kind === "ref") {
      const isLinked = val && typeof val === "object";
      const refId = isLinked ? String(val["@id"]) : String(val);
      const refName = isLinked ? entityDisplayName(val) : refId;
      const chip = document.createElement("button");
      chip.type = "button"; chip.className = "ref-chip";
      chip.textContent = refName !== refId ? `${refName}  (${refId})` : refId;
      chip.title = "Jump to this entity";
      chip.addEventListener("click", () => { if (editCrate.hasEntity(refId)) selectEditEntity(refId); });
      valRow.appendChild(chip);
    } else {
      const input = document.createElement("input");
      input.type = "text"; input.className = "value-input";
      input.value = val === undefined || val === null ? "" : String(val);
      input.addEventListener("change", () => {
        const raw = asArray(entity[prop]).slice();
        raw[idx] = input.value;
        commitEditPropertyValues(editSelectedId, prop, raw);
        renderEditForm();
      });
      valRow.appendChild(input);
    }
    const removeBtn = document.createElement("button");
    removeBtn.type = "button"; removeBtn.className = "value-remove-btn"; removeBtn.title = "Remove value";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      const raw = asArray(entity[prop]).slice();
      raw.splice(idx, 1);
      commitEditPropertyValues(editSelectedId, prop, raw);
      renderEditForm();
    });
    valRow.appendChild(removeBtn);
    valuesHost.appendChild(valRow);
  });

  const addRow = document.createElement("div");
  addRow.className = "value-add-row";
  if (kind === "ref") {
    const input = document.createElement("input");
    input.type = "text"; input.className = "value-input"; input.setAttribute("list", "editEntityIdOptions");
    input.placeholder = "@id of entity to reference…";
    const addBtn = document.createElement("button");
    addBtn.type = "button"; addBtn.className = "secondary"; addBtn.textContent = "Add reference";
    addBtn.addEventListener("click", () => {
      const refId = input.value.trim();
      if (!refId) return;
      if (!editCrate.hasEntity(refId)) editCrate.addEntity({ "@id": refId, "@type": "Thing" });
      const raw = asArray(entity[prop]).slice();
      raw.push({ "@id": refId });
      commitEditPropertyValues(editSelectedId, prop, raw);
      refreshEditEntityIdOptions();
      renderEditForm();
      renderEditEntityList();
    });
    addRow.append(input, addBtn);
  } else {
    const addBtn = document.createElement("button");
    addBtn.type = "button"; addBtn.className = "secondary"; addBtn.textContent = "+ Add value";
    addBtn.addEventListener("click", () => {
      const raw = asArray(entity[prop]).slice();
      raw.push("");
      commitEditPropertyValues(editSelectedId, prop, raw);
      renderEditForm();
    });
    addRow.appendChild(addBtn);
  }
  row.appendChild(addRow);
  return row;
}

function buildAddPropertyRow(entity) {
  const wrap = document.createElement("div");
  wrap.className = "prop-add-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text"; nameInput.className = "value-input";
  nameInput.placeholder = "New property name (e.g. custom:participant)";
  const typeSelect = document.createElement("select");
  typeSelect.innerHTML = '<option value="text">Text value</option><option value="ref">Reference to another entity</option>';
  const refInput = document.createElement("input");
  refInput.type = "text"; refInput.className = "value-input hidden";
  refInput.placeholder = "@id of entity to reference…"; refInput.setAttribute("list", "editEntityIdOptions");
  typeSelect.addEventListener("change", () => refInput.classList.toggle("hidden", typeSelect.value !== "ref"));
  const addBtn = document.createElement("button");
  addBtn.type = "button"; addBtn.textContent = "+ Add property";
  addBtn.addEventListener("click", () => {
    const prop = nameInput.value.trim();
    if (!prop || prop.startsWith("@")) { alert('Enter a property name that doesn’t start with "@".'); return; }
    if (prop in entity) { alert(`"${prop}" already exists on this entity.`); return; }
    if (typeSelect.value === "ref") {
      const refId = refInput.value.trim();
      if (!refId) { alert("Enter the @id of the entity to reference."); return; }
      if (!editCrate.hasEntity(refId)) editCrate.addEntity({ "@id": refId, "@type": "Thing" });
      editCrate.setProperty(editSelectedId, prop, { "@id": refId });
    } else {
      editCrate.setProperty(editSelectedId, prop, "");
    }
    markEditDirty();
    refreshEditEntityIdOptions();
    renderEditForm();
    renderEditEntityList();
  });
  wrap.append(nameInput, typeSelect, refInput, addBtn);
  return wrap;
}

function renderEditForm() {
  const pane = $("editFormPane");
  if (!pane) return;
  if (!editCrate || !editSelectedId || !editCrate.hasEntity(editSelectedId)) {
    pane.innerHTML = `<div class="edit-empty">Select an entity on the left to edit its properties.</div>`;
    return;
  }
  const entity = editCrate.getEntity(editSelectedId);
  const structural = entityIdIsStructural(entity);
  pane.innerHTML = "";

  const header = document.createElement("div");
  header.className = "edit-entity-header";
  header.innerHTML = [
    `<div class="field">`,
    `<label class="file-label">@id</label>`,
    `<input type="text" id="editFieldId" value="${escapeHtml(editSelectedId)}"${structural ? " disabled" : ""} />`,
    structural
      ? `<div class="hint">This id is structural (root dataset, file, or folder) and can’t be renamed here.</div>`
      : `<div class="hint">Renaming updates every reference to this entity.</div>`,
    `</div>`,
    `<div class="field">`,
    `<label class="file-label">@type</label>`,
    `<input type="text" id="editFieldType" value="${escapeHtml(entityTypes(entity).join(", "))}" />`,
    `<div class="hint">Comma-separated.</div>`,
    `</div>`,
  ].join("");
  pane.appendChild(header);

  if (!structural) {
    const idInput = header.querySelector("#editFieldId");
    idInput.addEventListener("change", () => {
      const next = idInput.value.trim();
      if (!next || next === editSelectedId) { idInput.value = editSelectedId; return; }
      if (editCrate.hasEntity(next)) { alert(`"${next}" is already used by another entity.`); idInput.value = editSelectedId; return; }
      editCrate.updateEntityId(editSelectedId, next);
      editSelectedId = next;
      markEditDirty();
      refreshEditEntityIdOptions();
      renderEditEntityList();
      renderEditForm();
    });
  }
  header.querySelector("#editFieldType").addEventListener("change", (e) => {
    const types = e.target.value.split(",").map((t) => t.trim()).filter(Boolean);
    if (!types.length) { e.target.value = entityTypes(entity).join(", "); return; }
    editCrate.setProperty(editSelectedId, "@type", types.length === 1 ? types[0] : types);
    markEditDirty();
    populateEditTypeFilter();
    renderEditEntityList();
  });

  const propsHost = document.createElement("div");
  propsHost.className = "edit-props";
  pane.appendChild(propsHost);

  const keys = Object.keys(entity).filter((k) => k !== "@id" && k !== "@type" && k !== "@reverse");
  keys.sort().forEach((prop) => propsHost.appendChild(buildEditPropertyRow(entity, prop)));

  pane.appendChild(buildAddPropertyRow(entity));

  const actions = document.createElement("div");
  actions.className = "edit-entity-actions";
  const delBtn = document.createElement("button");
  delBtn.type = "button"; delBtn.className = "secondary";
  delBtn.textContent = "Delete this entity";
  delBtn.disabled = editSelectedId === editCrate.rootId;
  delBtn.addEventListener("click", () => deleteEditEntity(editSelectedId));
  actions.appendChild(delBtn);
  if (delBtn.disabled) actions.appendChild(hintEl("The root dataset can't be deleted."));
  pane.appendChild(actions);
}

function deleteEditEntity(id) {
  if (!editCrate || !id || id === editCrate.rootId) return;
  const entity = editCrate.getEntity(id);
  const label = entity ? entityDisplayName(entity) : id;
  if (!confirm(`Delete "${label}"? This also removes references to it from other entities.`)) return;
  editCrate.deleteEntity(id, { references: true });
  markEditDirty();
  editSelectedId = editCrate.rootId;
  populateEditTypeFilter();
  refreshEditEntityIdOptions();
  renderEditEntityList();
  renderEditForm();
}

async function saveEdit() {
  if (!editCrate || !dirHandle) return;
  const btn = $("editSaveBtn");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    if (!(await verifyPermission(dirHandle, true))) { editLog("Permission to write the folder was denied."); return; }
    await writeFile(dirHandle, JSON_FILE, crateToJsonString(editCrate));
    const notes = [`Wrote ${JSON_FILE}.`];
    if (await fileExists(dirHandle, XLSX_FILE)) {
      await writeFile(dirHandle, XLSX_FILE, await crateToXlsxBytes(editCrate));
      notes.push(`Updated ${XLSX_FILE}.`);
    }
    if (await fileExists(dirHandle, HTML_FILE)) {
      if (lastHtmlTemplate) {
        const html = await crateToPreviewHtml(editCrate, {
          template: lastHtmlTemplate.template, config: lastHtmlTemplate.config, css: lastHtmlTemplate.css,
        });
        await writeFile(dirHandle, HTML_FILE, html);
        notes.push(`Updated ${HTML_FILE} (styled template from this session's last build: ${lastHtmlTemplate.source}).`);
      } else {
        await writeFile(dirHandle, HTML_FILE, await crateToPreviewHtml(editCrate));
        notes.push(`Updated ${HTML_FILE} (plain template — Build in this session with template options first to reuse a styled one here).`);
      }
    }
    editDirty = false;
    editLog(notes.join(" "));
    await refreshModeCards();
  } catch (e) {
    editLog("Save failed: " + (e && e.message ? e.message : e));
    console.error(e);
  } finally {
    btn.textContent = "Save";
    updateEditSaveState();
  }
}

/* ---------- boot ---------- */
function boot() {
  if (!("showDirectoryPicker" in window)) { $("unsupported").classList.remove("hidden"); return; }
  $("app").classList.remove("hidden");
  buildForm();
  showView("view-mode");
  refreshModeCards();

  $("menuBtn").addEventListener("click", async () => {
    if (!confirmLeaveEditIfDirty()) return;
    await refreshModeCards(); showView("view-mode");
  });
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
  $("buildStepChooseFolder").addEventListener("click", () => { void pickFolder("view-mode"); });
  $("buildStepDescribe").addEventListener("click", () => {
    if (!dirHandle) return;
    openCrateDetails();
  });
  $("buildStepOpenBuild").addEventListener("click", () => {
    if (!dirHandle || !rootDatasetOverride) return;
    openBuild();
  });
  $("cardShow").addEventListener("click", openShow);
  $("showBtn").addEventListener("click", openShow);
  $("showTabPreview").addEventListener("click", () => { void renderShow("preview"); });
  $("showTabJson").addEventListener("click", () => { void renderShow("json"); });
  $("showTabXlsx").addEventListener("click", () => { void renderShow("xlsx"); });
  $("openPreviewBtn").addEventListener("click", openPreviewWindow);
  const key = (fn) => (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };
  $("cardShow").addEventListener("keydown", key(openShow));
  $("cardEdit").addEventListener("click", openEdit);
  $("cardEdit").addEventListener("keydown", key(openEdit));
  $("editBtn").addEventListener("click", openEdit);
  $("editSaveBtn").addEventListener("click", saveEdit);
  $("editSearch").addEventListener("input", renderEditEntityList);
  $("editTypeFilter").addEventListener("change", renderEditEntityList);
  $("editAddEntityToggle").addEventListener("click", () => { $("editAddEntityForm").classList.toggle("hidden"); });
  $("editNewType").addEventListener("change", () => {
    $("editNewCustomType").classList.toggle("hidden", $("editNewType").value !== "__custom");
  });
  $("editNewCancel").addEventListener("click", () => {
    $("editAddEntityForm").classList.add("hidden");
    $("editNewName").value = ""; $("editNewCustomType").value = "";
  });
  $("editNewCreate").addEventListener("click", () => {
    if (!editCrate) return;
    const typeVal = $("editNewType").value;
    const type = typeVal === "__custom" ? ($("editNewCustomType").value.trim() || "Thing") : typeVal;
    const name = $("editNewName").value.trim();
    const base = `#${slugify(name || type) || "entity"}`;
    let id = base, i = 2;
    while (editCrate.hasEntity(id)) { id = `${base}-${i++}`; }
    const data = { "@id": id, "@type": type };
    if (name) data.name = name;
    editCrate.addEntity(data);
    markEditDirty();
    $("editAddEntityForm").classList.add("hidden");
    $("editNewName").value = ""; $("editNewCustomType").value = "";
    populateEditTypeFilter();
    refreshEditEntityIdOptions();
    renderEditEntityList();
    selectEditEntity(id);
  });
  $("crateDetailsBackBtn").addEventListener("click", async () => { await refreshModeCards(); showView("view-mode"); });
  $("crateDetailsContinueBtn").addEventListener("click", submitCrateDetails);
  $("crateDetailsForm").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target && e.target.tagName === "TEXTAREA") return;
    e.preventDefault();
    submitCrateDetails();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (isModalOpen()) return;
    const tag = e.target && e.target.tagName ? e.target.tagName : "";
    if (tag === "TEXTAREA") return;
    if (tag === "INPUT" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return;
    if (isDescribeViewActive()) {
      e.preventDefault();
      submitCrateDetails();
      return;
    }
    if (isBuildViewActive()) {
      const runBtn = $("runBtn");
      if (!runBtn || runBtn.disabled) return;
      e.preventDefault();
      run();
      return;
    }
  });
  $("runBtn").addEventListener("click", run);
  $("showHtmlBtn").addEventListener("click", () => openHtmlInNewTab(buildHtml));
  $("clearLogBtn").addEventListener("click", clearLogPanel);
  $("saveLogBtn").addEventListener("click", saveLog);
  syncLogActionButtons();
  $("rebuildBtn").addEventListener("click", () => {
    if (!dirHandle) return;
    openBuild();
  });
  $("modalCancel").addEventListener("click", () => $("modal").classList.add("hidden"));
  $("modalBuild").addEventListener("click", () => { $("modal").classList.add("hidden"); openCrateDetails(); });
}
boot();
