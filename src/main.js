// resources2crate — browser UI + File System Access wiring.
// The crate assembly and output generation live in ./crate.js (library-based,
// isomorphic). This file only handles picking a folder, reading/writing files,
// and the stepped Build/Show UI.

import {
  crateToJsonString, crateToXlsxBytes, crateToPreviewHtml,
  loadCrateFromJson, GENERATED_FILENAMES, CONTROL_FILENAMES,
} from "./crate.js";
import {
  writeFile, verifyPermission, fileExists, readFileText, readJsonFromFolder,
} from "./fs_helpers.js";
import { listGitHubFolder } from "./github.js";
import packageJson from "../package.json";
import { createHookBus } from "./plugins/hooks.js";
import { registerAllPlugins, composeOptionSchema, composeSettingsSchema } from "./plugins/index.js";
import { runPipeline } from "./plugins/pipeline.js";
import { resetUploadedConfigDirHandle } from "./plugins/ro-crate-html-output/index.js";
import { readXlsxHeaders, readXlsxContextPrefixes } from "./plugins/merge/xlsx.js";

// The hook bus is created once and plugins registered once — all
// build-specific state lives in the fresh ctx object passed to emit() on
// each build, not in the handlers themselves. See src/plugins/hooks.js.
const hookBus = createHookBus();
registerAllPlugins(hookBus);

const JSON_FILE = "ro-crate-metadata.json";
const XLSX_FILE = "ro-crate-metadata.xlsx";
const HTML_FILE = "ro-crate-preview.html";
const TEMPLATE_REPO_OWNER = "benfoley";
const TEMPLATE_REPO_NAME = "rocss-template-repo";
const TEMPLATE_REPO_REF = "main";
const MASP_PROFILES_REPO_OWNER = "benfoley";
const MASP_PROFILES_REPO_NAME = "masp-profiles";
const MASP_PROFILES_REPO_REF = "main";
const APP_VERSION = packageJson.version || "dev";

// Build-panel options mostly come from the plugin registry (src/plugins) —
// each plugin owns its own optionSchema/settingsSchema fragment. This core
// array is for build-time options that don't belong to any plugin — right
// now just collectionLabelsBuilder, consumed directly by docx_crate.js's
// crate-building (it sets each Collection entity's own `name`, not just an
// HTML-rendering label), which isn't itself a plugin (see docx_crate.js).
const CORE_OPTION_SCHEMA = [
  { key: "collectionLabelsBuilder", type: "collectionLabelsBuilder", label: "Set menu names for collections…",
    hint: "Optional, for Structured Word documents mode. Map each top-level collection folder to a friendlier label shown in the site's navigation menu and cards (e.g. AnmWeb1_HOME → Home) — the raw folder name is used for anything left blank." },
];
const OPTION_SCHEMA = [...composeOptionSchema(), ...CORE_OPTION_SCHEMA];

// Shown in the Settings modal (accessed from the button next to Menu).
const CORE_SETTINGS_SCHEMA = [
  { key: "inputMode", type: "select", label: "Input type", default: "generic",
    options: [
      { value: "generic", label: "Generic folder of files" },
      { value: "docx", label: "Structured Word documents (.docx)" },
    ],
    hint: "Structured Word documents parses Heading 1/2/3 styles into Collections/Chapters/DocumentParts instead of grouping files generically — see corpus-tools-person-centred-collections-docx's README for the authoring conventions (heading levels, image/caption/photo/SOUND FILE markers)." },
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
  { key: "enableLocalTemplateUpload", label: "Enable local template upload", default: false,
    hint: "Shows or hides the Upload template files option in Build settings." },
];
const SETTINGS_SCHEMA = [...CORE_SETTINGS_SCHEMA, ...composeSettingsSchema()];

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
    if (opt.type === "file" || opt.type === "mappingBuilder" || opt.type === "collectionLabelsBuilder") continue;
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
    if (opt.type === "file" || opt.type === "mappingBuilder" || opt.type === "collectionLabelsBuilder") continue;
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
const VIEWS = ["view-mode", "view-select-profile", "view-crate-details", "view-build", "view-show", "view-edit"];
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
// The "Build mapping…" button — only enabled once a merge spreadsheet is uploaded.
let mergeMappingBuilderBtn = null;
function refreshMergeMappingBuilderBtn() {
  if (mergeMappingBuilderBtn) mergeMappingBuilderBtn.disabled = !uploads.mergeFile;
}

function hintEl(text) { const h = document.createElement("div"); h.className = "hint"; h.textContent = text; return h; }

function buildForm() {
  Object.keys(uploads).forEach((k) => delete uploads[k]);
  resetUploadedConfigDirHandle();
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

function collectSchemaKeys(schema, set) {
  for (const opt of schema) {
    set.add(opt.key);
    if (opt.children) collectSchemaKeys(opt.children, set);
  }
}

// Shows/hides Build-panel fields (Settings are a separate, profile-
// independent surface) per the profile-in-effect's crate-o-mode.json
// buildOptions (see masp-profiles), and pre-fills whatever checkboxes/
// selects it declares values for. Build options are hidden by DEFAULT —
// a key (top-level or nested) is only shown if it's named in
// buildOptions.enabledOptionKeys, so each profile opts into exactly the
// options relevant to its workflow rather than excluding the rest.
//
// Hidden means OFF, not merely invisible: an option the profile didn't
// enable is forced to its off value so the plugin behind it doesn't run.
// Visibility and execution are the same decision, which makes
// enabledOptionKeys the single source of truth for what a build does —
// plugins read ctx.options whether or not a field is on screen, so without
// this any option defaulting to true would keep running unseen, and a
// profile could neither guarantee a capability runs nor that it doesn't.
//
// An ABSENT buildOptions block reads as an empty allow-list ("this profile
// offers no optional processing"), not as "no opinion" — it keeps upstream
// profiles written for crate-o (which know nothing about these options)
// conservative here. The bundled default supplies its own block by overlay
// (src/default_profile.js), which is how it opts into a plain preview.
//
// inputMode is force-locked rather than merely pre-selected, since
// Describe's field set and the docx vs. generic parsing path both depend
// on it matching the profile.
function applyBuildOptionsFromProfile(buildOptions) {
  const allKeys = new Set();
  collectSchemaKeys(OPTION_SCHEMA, allKeys);
  const declared = buildOptions || {};
  const enabled = new Set(declared.enabledOptionKeys || []);

  for (const key of allKeys) {
    const field = $("field_opt_" + key);
    if (field) field.classList.toggle("hidden", !enabled.has(key));

    // File/mappingBuilder/collectionLabelsBuilder fields have no opt_<key>
    // control of their own — their visibility above is the whole story.
    const el = $("opt_" + key);
    if (!el) continue;
    if (!enabled.has(key)) {
      if (el.tagName === "SELECT") el.value = "";
      else el.checked = false;
    } else if (key in declared) {
      if (el.tagName === "SELECT") el.value = declared[key];
      else el.checked = !!declared[key];
    }
    el.dispatchEvent(new Event("change"));
  }

  // Keys the profile declares that aren't Build options — currently just
  // inputMode, a Setting a profile pins because the parsing path depends on
  // it. Settings are otherwise ungated, so they're only touched when named.
  const inputModeEl = $("opt_inputMode");
  if (inputModeEl) inputModeEl.disabled = false;
  for (const [key, value] of Object.entries(declared)) {
    if (key === "enabledOptionKeys" || allKeys.has(key)) continue;
    const el = $("opt_" + key);
    if (!el) continue;
    if (el.tagName === "SELECT") el.value = value;
    else el.checked = !!value;
    el.dispatchEvent(new Event("change"));
  }
  if (inputModeEl && declared.inputMode) inputModeEl.disabled = true;
}

function renderOptions(schema, parent) {
  for (const opt of schema) {
    if (opt.type === "file") { parent.appendChild(buildFileField(opt)); continue; }
    if (opt.type === "select") { parent.appendChild(buildSelectField(opt)); continue; }
    if (opt.type === "mappingBuilder") { parent.appendChild(buildMappingBuilderField(opt)); continue; }
    if (opt.type === "collectionLabelsBuilder") { parent.appendChild(buildCollectionLabelsField(opt)); continue; }

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
  wrap.id = "field_opt_" + opt.key;
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
      resetUploadedConfigDirHandle();
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
  wrap.id = "field_opt_" + opt.key;
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
  wrap.id = "field_opt_" + opt.key;
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

/* ---------- collection-labels builder field ---------- */
let collectionLabelsBuilderBtn = null;
function refreshCollectionLabelsBuilderBtn() {
  if (collectionLabelsBuilderBtn) collectionLabelsBuilderBtn.disabled = !dirHandle;
}
function buildCollectionLabelsField(opt) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.id = "field_opt_" + opt.key;
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "secondary"; btn.style.width = "100%";
  btn.textContent = opt.label;
  btn.disabled = true;
  btn.addEventListener("click", openCollectionLabelsModal);
  collectionLabelsBuilderBtn = btn;
  refreshCollectionLabelsBuilderBtn();
  wrap.appendChild(btn);
  const status = document.createElement("div");
  status.className = "hint"; status.id = "collectionLabelsStatus";
  status.textContent = "No custom names — folder names will be used as-is.";
  wrap.appendChild(status);
  if (opt.hint) wrap.appendChild(hintEl(opt.hint));
  return wrap;
}
function updateCollectionLabelsStatus(count) {
  const el = $("collectionLabelsStatus");
  if (el) el.textContent = count > 0
    ? `Custom names set for ${count} collection(s).`
    : "No custom names — folder names will be used as-is.";
}

/* ---------- collection-labels builder modal ---------- */
// The applied mapping (folder name -> label), threaded into effectiveConfig
// in processFolder's docx-mode branch. Reset whenever a new folder is picked.
let collectionLabelsOverride = null;
// In-progress edits, kept alive across the modal being closed and reopened
// so nothing typed is lost until a new folder is picked.
let collectionLabelsDraft = {};

async function openCollectionLabelsModal() {
  if (!dirHandle) return;
  let folderNames;
  try {
    const { getSubDirectoryHandles } = await import("./plugins/docx-input/docx_crate.js");
    const subDirs = await getSubDirectoryHandles(dirHandle);
    folderNames = subDirs.map((h) => h.name).sort((a, b) => a.localeCompare(b));
  } catch (e) {
    alert("Could not read the folder's sub-directories: " + (e && e.message ? e.message : e));
    return;
  }
  renderCollectionLabelsRows(folderNames);
  $("collectionLabelsModal").classList.remove("hidden");
}

function renderCollectionLabelsRows(folderNames) {
  const container = $("collectionLabelsBody");
  container.innerHTML = "";

  if (!folderNames.length) {
    container.appendChild(hintEl("No sub-folders found directly inside the picked folder."));
    return;
  }

  const head = document.createElement("div");
  head.className = "mapping-head collection-labels-head";
  head.innerHTML = "<span>Folder name</span><span></span><span>Menu label</span>";
  container.appendChild(head);

  folderNames.forEach((folderName) => {
    const row = document.createElement("div");
    row.className = "mapping-row collection-labels-row";
    row.dataset.source = folderName;

    const src = document.createElement("div");
    src.className = "col-source";
    src.textContent = folderName;

    const label = document.createElement("input");
    label.type = "text"; label.className = "map-target";
    label.placeholder = folderName;
    label.value = collectionLabelsDraft[folderName] !== undefined ? collectionLabelsDraft[folderName] : "";
    label.addEventListener("input", () => { collectionLabelsDraft[folderName] = label.value; });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button"; copyBtn.className = "map-copy-btn";
    copyBtn.title = "Copy folder name to menu label";
    copyBtn.textContent = "→";
    copyBtn.addEventListener("click", () => {
      label.value = folderName;
      label.dispatchEvent(new Event("input", { bubbles: true }));
      label.focus();
    });

    row.append(src, copyBtn, label);
    container.appendChild(row);
  });
}

function applyCollectionLabels() {
  const container = $("collectionLabelsBody");
  const labels = {};
  container.querySelectorAll(".collection-labels-row").forEach((row) => {
    const value = row.querySelector(".map-target").value.trim();
    if (value) labels[row.dataset.source] = value;
  });
  collectionLabelsOverride = Object.keys(labels).length ? labels : null;
  updateCollectionLabelsStatus(Object.keys(labels).length);
  $("collectionLabelsModal").classList.add("hidden");
}

/* ---------- merge-mapping builder modal ---------- */
// Entity types the mapping builder offers for a column — matches the
// vocabulary already used by src/plugins/merge/merge_config.json.
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
let mergeMappingConfigExtras = null;
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
    mergeMappingConfigExtras = null;
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
  // Preserve non-mapping lookup settings when a user loads an existing merge config
  // through the mapping modal, so Apply does not silently drop them.
  mergeMappingConfigExtras = {
    ...(typeof parsed.placeMatchRegion === "string" && parsed.placeMatchRegion.trim()
      ? { placeMatchRegion: parsed.placeMatchRegion.trim() }
      : {}),
    ...(parsed.placeLookup && typeof parsed.placeLookup === "object"
      ? { placeLookup: parsed.placeLookup }
      : {}),
  };
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
    // ".language" — see plugins/merge/merge_config.json) to flag a typed/
    // reference column; that dot isn't part of the actual target property name.
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
  const config = {
    ...(sheetName ? { sheet: sheetName } : {}),
    ...(mergeMappingConfigExtras || {}),
    mapping,
  };
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
    const entries = await listGitHubFolder(TEMPLATE_REPO_OWNER, TEMPLATE_REPO_NAME, TEMPLATE_REPO_REF, "");
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

/* ---------- select-profile step ---------- */
// The profile in effect: its id (a masp-profiles folder name, or
// DEFAULT_PROFILE_ID for the bundled schema.org fallback) and everything
// loaded from it: { validator, workflow (crate-o-mode.json, carries
// buildOptions), rootClassDefinition, fieldSchema }. Both reset in
// pickFolder() on every new folder pick — a profile chosen for one folder
// shouldn't silently carry over to the next.
//
// Selecting a profile is optional. Skipping the step loads the bundled
// default instead (ensureProfileData), so from Describe onwards nothing
// downstream has to handle a "no profile" case.
let selectedProfile = null;
let selectedProfileData = null;

// Kept in sync with src/default_profile.js, which is dynamically imported so
// its ~1.6 MB profile crate stays out of the main bundle — these two strings
// are needed to render and identify the picker entry before that import.
const DEFAULT_PROFILE_ID = "__default__";
const DEFAULT_PROFILE_LABEL = "schema.org (default)";

function profileLabel(id) {
  return id === DEFAULT_PROFILE_ID ? DEFAULT_PROFILE_LABEL : id;
}

// Turn a fetched/bundled { profileJson, modeJson } pair into the
// selectedProfileData shape. Shared by both sources so they can't drift.
async function buildProfileData(profileJson, modeJson) {
  const masp = await import("./masp.js");
  const validator = await masp.loadValidator(profileJson, modeJson);
  const rootClassDefinition = masp.getRootClassDefinition(validator);
  const fieldSchema = masp.toDescribeFieldSchema(rootClassDefinition, modeJson.longTextInputs);
  return { validator, workflow: modeJson, rootClassDefinition, fieldSchema };
}

// Guarantees a profile is in effect, loading the bundled default if the user
// skipped selection. Called by the steps that actually need a schema
// (Describe) or buildOptions (Build), rather than forcing a choice up front.
async function ensureProfileData() {
  if (selectedProfileData) return selectedProfileData;
  const { getDefaultProfile } = await import("./default_profile.js");
  const { profileJson, modeJson } = getDefaultProfile();
  selectedProfileData = await buildProfileData(profileJson, modeJson);
  selectedProfile = DEFAULT_PROFILE_ID;
  refreshBuildStepActions();
  return selectedProfileData;
}

// Loading the default can only fail on a genuine fault (a bad bundle, a
// profile the validator rejects) — but callers are fire-and-forget `void`
// calls, so an unhandled rejection would read to the user as a button that
// does nothing. Surface it on the profile step instead, which is both the
// relevant screen and somewhere they can pick a different profile.
function reportProfileLoadFailure(e) {
  const message = e && e.message ? e.message : String(e);
  console.error("Could not load the default profile:", e);
  $("profileStatus").textContent = "Could not load the default profile: " + message;
  showView("view-select-profile");
}

async function openProfileSelection() {
  if (!dirHandle) return;
  $("profileContinueBtn").disabled = !selectedProfile;
  const status = $("profileStatus");
  status.textContent = "";
  const container = $("profileOptionsBody");
  container.innerHTML = "";
  container.appendChild(hintEl("Loading profiles…"));
  try {
    const entries = await listGitHubFolder(MASP_PROFILES_REPO_OWNER, MASP_PROFILES_REPO_NAME, MASP_PROFILES_REPO_REF, "");
    const folderNames = entries.filter((e) => e && e.type === "dir").map((e) => e.name).sort((a, b) => a.localeCompare(b));
    renderProfileOptions(folderNames);
  } catch (e) {
    // The remote list failing is not fatal — the bundled default is still
    // offered, which is the whole point of bundling it.
    renderProfileOptions([]);
    $("profileOptionsBody").appendChild(hintEl("Could not load the profile list: " + (e && e.message ? e.message : e)));
  }
  showView("view-select-profile");
}

function renderProfileOptions(folderNames) {
  const container = $("profileOptionsBody");
  container.innerHTML = "";
  // The bundled default leads the list: it's what you get by not choosing,
  // so it should be visible rather than implied.
  const entries = [
    { id: DEFAULT_PROFILE_ID, title: DEFAULT_PROFILE_LABEL,
      desc: "Minimal RO-Crate using schema.org terms, plus a plain HTML preview. No domain vocabulary, no spreadsheet merge or language lookups — used automatically if you skip this step." },
    ...folderNames.map((name) => ({ id: name, title: name, desc: "Click to use this profile." })),
  ];
  for (const entry of entries) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "profile-option";
    btn.dataset.profile = entry.id;
    btn.classList.toggle("selected", entry.id === selectedProfile);
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = entry.title;
    const d = document.createElement("div");
    d.className = "d";
    d.textContent = entry.desc;
    btn.append(t, d);
    btn.addEventListener("click", () => { void chooseProfile(entry.id); });
    container.appendChild(btn);
  }
}

async function chooseProfile(profileId) {
  const status = $("profileStatus");
  const continueBtn = $("profileContinueBtn");
  const label = profileLabel(profileId);
  continueBtn.disabled = true;
  status.textContent = `Loading ${label}…`;
  setProfileOptionsDisabled(true);
  try {
    let profileJson, modeJson;
    if (profileId === DEFAULT_PROFILE_ID) {
      ({ profileJson, modeJson } = (await import("./default_profile.js")).getDefaultProfile());
    } else {
      const masp = await import("./masp.js");
      ({ profileJson, modeJson } = await masp.fetchProfile(MASP_PROFILES_REPO_OWNER, MASP_PROFILES_REPO_NAME, MASP_PROFILES_REPO_REF, profileId));
    }
    selectedProfileData = await buildProfileData(profileJson, modeJson);
    selectedProfile = profileId;
    status.textContent = `Ready: ${selectedProfileData.rootClassDefinition.name} (${selectedProfileData.fieldSchema.length} field(s)).`;
    continueBtn.disabled = false;
  } catch (e) {
    selectedProfile = null;
    selectedProfileData = null;
    status.textContent = "Could not load profile: " + (e && e.message ? e.message : e);
  } finally {
    setProfileOptionsDisabled(false);
    renderProfileOptions(
      Array.from($("profileOptionsBody").querySelectorAll(".profile-option"))
        .map((b) => b.dataset.profile)
        .filter((id) => id !== DEFAULT_PROFILE_ID)
    );
    refreshBuildStepActions();
  }
}
function setProfileOptionsDisabled(disabled) {
  $("profileOptionsBody").querySelectorAll(".profile-option").forEach((b) => { b.disabled = disabled; });
}

/* ---------- crate details (root dataset) form ---------- */
const DEFAULT_LICENSE_URL = "https://creativecommons.org/licenses/by-nc-nd/4.0/";

// Values collected from the crate-details form, merged into config.rootDataset
// at build time. Populated when the user clicks Continue on that step.
let rootDatasetOverride = null;
// The existing crate's root entity (+ its @id → entity map, for resolving
// linked names), if the picked folder already had one — see
// populateCrateDetailsFromExistingCrate/buildDescribeField.
let existingRootDatasetEntity = null;
let existingRootDatasetById = null;

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

// Renders one Describe-step field from a src/masp.js field-schema entry (see
// toDescribeFieldSchema). Mirrors renderOptions()'s builder-dispatch pattern
// used for the Build panel. Prefills from an existing crate's root entity
// (existingRootDatasetEntity/existingRootDatasetById, set by
// populateCrateDetailsFromExistingCrate) when a matching value is present.
function buildDescribeField(field) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.id = "field_describe_" + field.key;

  const label = document.createElement("label");
  label.className = "file-label";
  label.htmlFor = "describe_" + field.key;
  label.textContent = field.label + (field.required ? " *" : "");
  wrap.appendChild(label);

  let input;
  if (field.inputKind === "textarea") {
    input = document.createElement("textarea");
    input.rows = 3;
  } else if (field.inputKind === "select") {
    input = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = ""; blank.textContent = "Select…";
    input.appendChild(blank);
    for (const v of field.values || []) {
      const value = typeof v === "string" ? v : (v && (v.name || v["@id"])) || String(v);
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = value;
      input.appendChild(opt);
    }
  } else {
    input = document.createElement("input");
    input.type = field.inputKind === "date" ? "date" : field.inputKind === "url" ? "url" : "text";
    if (field.inputKind === "entity-ref") {
      input.placeholder = field.multiple ? "Comma-separated names" : "e.g. Jane Smith";
    }
  }
  input.id = "describe_" + field.key;

  if (existingRootDatasetEntity) {
    // field.key is exactly what the profile declared and exactly what
    // collectDescribeValues() writes onto the entity — no bare-name
    // fallback; profiles are expected to declare properly prefixed names
    // (e.g. "custom:portalName") for anything that isn't a real schema.org
    // term.
    const raw = existingRootDatasetEntity[field.key];
    if (field.inputKind === "entity-ref") {
      const linkedName = resolveLinkedName(raw, existingRootDatasetById);
      if (linkedName) input.value = linkedName;
    } else if (typeof raw === "string" && raw.trim()) {
      input.value = raw.trim();
    } else if (raw && typeof raw === "object" && typeof raw["@id"] === "string") {
      input.value = raw["@id"];
    }
  }

  wrap.appendChild(input);
  if (field.hint) wrap.appendChild(hintEl(field.hint));
  return wrap;
}

function renderDescribeFields(fieldSchema) {
  const container = $("crateDetailsBody");
  container.innerHTML = "";
  for (const field of fieldSchema) container.appendChild(buildDescribeField(field));
}

async function openCrateDetails() {
  // Loads the bundled default if the user skipped profile selection, so the
  // Describe step always has a field schema to render.
  try {
    await ensureProfileData();
  } catch (e) {
    reportProfileLoadFailure(e);
    return;
  }
  renderDescribeFields(selectedProfileData.fieldSchema);
  if (dirHandle && !$("cd_id").value.trim()) $("cd_id").value = slugify(dirHandle.name);
  for (const field of selectedProfileData.fieldSchema) {
    const el = $("describe_" + field.key);
    if (!el) continue;
    if (field.inputKind === "date" && !el.value) el.value = todayIsoDate();
    if (field.key === "license" && !el.value.trim()) el.value = DEFAULT_LICENSE_URL;
    if (field.key === "name" && !el.value.trim() && dirHandle) el.value = dirHandle.name;
  }
  showView("view-crate-details");
}

// Builds the config.rootDataset fragment for this build, from whatever
// fields the selected profile rendered. An entity-ref field (e.g. "creator"
// typed ["Person"]) becomes a full entity (with @id derived from its free
// text) — comma-separated if `multiple` — so the ro-crate library registers
// it as a linked node in the graph when assigned.
function collectDescribeValues(fieldSchema) {
  const idText = $("cd_id").value.trim();
  const rootDataset = { "@id": normalizeArcpId(idText || (dirHandle && dirHandle.name) || "crate") };

  for (const field of fieldSchema) {
    const el = $("describe_" + field.key);
    if (!el) continue;
    const raw = el.value.trim();
    if (!raw) continue;

    if (field.inputKind === "entity-ref") {
      const names = field.multiple ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [raw];
      const refs = names.map((name) => ({ "@id": `#${slugify(field.entityType)}-${slugify(name)}`, "@type": field.entityType, name }));
      rootDataset[field.key] = field.multiple ? refs : refs[0];
      continue;
    }
    if (field.key === "license") {
      rootDataset.license = { "@id": raw };
      continue;
    }
    rootDataset[field.key] = raw;
  }
  return rootDataset;
}

function resetCrateDetailsForm() {
  $("cd_id").value = "";
  $("crateDetailsBody").innerHTML = "";
  existingRootDatasetEntity = null;
  existingRootDatasetById = null;
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

// Only the fixed "Identifier" field can be prefilled here — the rest of the
// Describe form doesn't exist yet at this point (pickFolder() runs before a
// profile is chosen, and the profile-driven fields aren't rendered until
// openCrateDetails()). Instead, remember the existing crate's root entity so
// buildDescribeField() can prefill each rendered field from it once the form
// does exist.
async function populateCrateDetailsFromExistingCrate(handle) {
  const crateJson = await readJsonFromFolder(handle, JSON_FILE);
  if (!crateJson) return false;

  const extracted = getRootDatasetEntity(crateJson);
  if (!extracted) return false;

  const { root, byId } = extracted;
  existingRootDatasetEntity = root;
  existingRootDatasetById = byId;

  const rootId = typeof root["@id"] === "string" ? root["@id"].trim() : "";
  if (rootId) $("cd_id").value = rootId.replace(/^arcp:\/\/name,/i, "");

  return true;
}

function submitCrateDetails() {
  rootDatasetOverride = collectDescribeValues(selectedProfileData.fieldSchema);
  refreshBuildStepActions();
  showView("view-mode");
}

function refreshBuildStepActions() {
  const profileBtn = $("buildStepProfile");
  const describeBtn = $("buildStepDescribe");
  const buildBtn = $("buildStepOpenBuild");
  if (!profileBtn || !describeBtn || !buildBtn) return;
  const hasFolder = !!dirHandle;
  const hasDescribe = !!rootDatasetOverride;
  // Profile selection is optional — skipping it falls back to the bundled
  // default (ensureProfileData), so Describe only waits on a folder.
  profileBtn.disabled = !hasFolder;
  describeBtn.disabled = !hasFolder;
  buildBtn.disabled = !(hasFolder && hasDescribe);
}

/* ---------- File System Access ---------- */
let dirHandle = null;

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
/* ---------- Build ---------- */
// Thin wrapper: assembles rootDataset/metadataLicence entirely from the
// selected profile (its crate-o-mode.json rootDataset.type/conformsTo and
// metadataLicence, plus the Describe-step values) and the collection-labels
// override, builds the shared pipeline context, and hands off to
// runPipeline() (src/plugins/pipeline.js) — everything else (which input
// mode to parse, AUSTLANG, merge, JSON/XLSX/HTML output, profile
// validation) happens via hook-tapping plugins from there. A profile is
// always in effect by the time this runs — openBuild()/openCrateDetails()
// call ensureProfileData(), which falls back to the bundled schema.org
// default — so there is no "no profile" case to handle.
async function processFolder(dirHandle, files, options) {
  const profileWorkflow = selectedProfileData.workflow;
  const profileRootDataset = profileWorkflow.rootDataset || {};
  const rootDataset = {
    ...(profileRootDataset.type ? { "@type": profileRootDataset.type } : {}),
    ...(profileRootDataset.conformsTo ? { conformsTo: { "@id": profileRootDataset.conformsTo } } : {}),
    ...rootDatasetOverride,
  };
  const effectiveConfig = {
    rootDataset,
    ...(profileWorkflow.metadataLicence ? { metadataLicence: profileWorkflow.metadataLicence } : {}),
    ...(profileWorkflow.fileProperties ? { fileProperties: profileWorkflow.fileProperties } : {}),
    ...(collectionLabelsOverride ? { collectionLabels: collectionLabelsOverride } : {}),
  };

  const ctx = {
    dirHandle, files, options, log,
    config: effectiveConfig,
    configSource: `"${profileLabel(selectedProfile)}" profile`,
    selectedProfileData,
  };

  const result = await runPipeline(ctx, hookBus);

  if ("buildHtml" in ctx) buildHtml = ctx.buildHtml;
  if ("lastHtmlTemplate" in ctx) lastHtmlTemplate = ctx.lastHtmlTemplate;

  return result;
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
  selectedProfile = null;
  selectedProfileData = null;
  $("profileStatus").textContent = "";
  $("profileContinueBtn").disabled = true;
  collectionLabelsOverride = null;
  collectionLabelsDraft = {};
  updateCollectionLabelsStatus(0);
  refreshCollectionLabelsBuilderBtn();
  buildHtml = null;
  lastHtmlTemplate = null;
  resetCrateDetailsForm();
  try {
    // Just remembers the existing root entity for buildDescribeField() to
    // prefill from — can't set rootDatasetOverride yet, since that now
    // requires a profile's field schema (chosen in the next step) to collect
    // values through.
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
async function openBuild() {
  // No profile chosen (including via the Show/Edit "Rebuild" shortcut, which
  // reaches Build directly) is not an error — the bundled default applies.
  try {
    await ensureProfileData();
  } catch (e) {
    reportProfileLoadFailure(e);
    return;
  }
  if (!confirmLeaveEditIfDirty()) return;
  clearLog();
  $("showHtmlBtn").classList.add("hidden");
  $("saveLogBtn").disabled = true;
  log("Set your options, then click Build RO-Crate.", "muted");
  applyBuildOptionsFromProfile(selectedProfileData ? selectedProfileData.workflow.buildOptions : null);
  // applyBuildOptionsFromProfile() just reset every Build-option field's
  // visibility from scratch (including "Upload template files", shown
  // whenever a profile enables "styledPreview"), which would otherwise
  // override the separate "Enable local template upload" setting that's
  // meant to keep it hidden until turned on — reassert that now.
  refreshTemplateUploadVisibility();
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
  const ids = ["modal", "settingsModal", "mergeMappingModal", "collectionLabelsModal"];
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
  if (currentPageUrl) {
    URL.revokeObjectURL(currentPageUrl);
    currentPageUrl = null;
  }
  previewFileUrls.forEach((u) => URL.revokeObjectURL(u));
  previewFileUrls = [];
}

// The blob URL used for the currently-open preview page, so click-through
// navigation (see openPageInPreview) can revoke it before replacing it.
let currentPageUrl = null;

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

// Builds a relative-path -> blob URL map for every non-HTML file under
// `handle` (media, xlsx, json, css, …). HTML files are deliberately excluded
// here — a multipage build's other pages (ro-crate-preview_html/**/index.html)
// need their OWN src/href attributes rewritten too, which this map alone
// can't do; see openPageInPreview, which materializes pages one at a time,
// on click, instead of trying to pre-rewrite the whole site's cross-links at
// once (those links are mutual — page A links to B and B back to A — so
// there's no single-pass order that could pre-materialize a blob URL for one
// before the other exists).
async function buildAssetUrlMap(handle) {
  const map = new Map();
  const created = [];
  async function walk(h, prefix = "") {
    for await (const entry of h.values()) {
      if (entry.kind === "directory") {
        await walk(entry, prefix ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }
      if (entry.kind !== "file" || entry.name.toLowerCase().endsWith(".html")) continue;
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

// Inline script injected into every materialized preview page. Runs as part
// of normal page parsing (no dependency on a 'load' event firing, and no
// need for the opener to reach into the popup's DOM to attach a listener —
// both of which turned out to be unreliable: reaching into popup.document
// from the opener can silently fail with no console output if the browser
// treats the blob: document as having a distinct security context). Instead
// the page manages its own clicks and tells the opener what to do next via
// postMessage, which works reliably across windows regardless.
const PREVIEW_NAV_SCRIPT = `<script>
document.addEventListener("click", function (ev) {
  var link = ev.target.closest("[data-r2c-page]");
  if (!link || !window.opener) return;
  ev.preventDefault();
  window.opener.postMessage({ source: "r2c-preview", page: link.getAttribute("data-r2c-page") }, "*");
});
</script>`;

// Rewrites one page's non-HTML src/href attributes to the matching asset
// blob URL. Links to other crate-generated HTML pages are left as their
// original relative path but flagged with data-r2c-page (and defanged to
// href="#") for PREVIEW_NAV_SCRIPT to pick up, so that page can be
// materialized on demand — with its own relative-path depth — instead of
// needing every page in the site pre-rewritten up front.
function rewritePageAssets(html, assetMap) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("[src],[href]")) {
    for (const attr of ["src", "href"]) {
      const raw = el.getAttribute(attr);
      if (!raw || isAbsoluteLikeUrl(raw)) continue;
      const { base, suffix } = splitUrlParts(raw);
      const key = normalizeRelativePath(base);
      if (!key) continue;
      if (key.toLowerCase().endsWith(".html")) {
        el.setAttribute("data-r2c-page", key);
        if (attr === "href") el.setAttribute("href", "#");
        continue;
      }
      const mapped = assetMap.get(key) || assetMap.get(encodeURI(key));
      if (mapped) el.setAttribute(attr, mapped + suffix);
    }
  }
  doc.body.insertAdjacentHTML("beforeend", PREVIEW_NAV_SCRIPT);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

async function getFileHandleAtPath(dirHandle, relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop();
  let dir = dirHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: false });
  return dir.getFileHandle(filename, { create: false });
}

// Opens (or click-navigates to) one crate-generated HTML page inside `popup`:
// reads it fresh from `handle`, rewrites its asset references via `assetMap`,
// and injects PREVIEW_NAV_SCRIPT so further click-through (handled by
// handlePreviewMessage below) works too. Reused for both the initial "Open
// the HTML" page and every subsequent in-preview navigation, so every page
// you can reach gets the same treatment — not just the first one.
async function openPageInPreview(popup, handle, assetMap, relativePath) {
  const fileHandle = await getFileHandleAtPath(handle, relativePath);
  const text = await (await fileHandle.getFile()).text();
  const rewritten = rewritePageAssets(text, assetMap);

  if (currentPageUrl) URL.revokeObjectURL(currentPageUrl);
  currentPageUrl = URL.createObjectURL(new Blob([rewritten], { type: "text/html" }));
  popup.location.replace(currentPageUrl);
}

// The popup/handle/assetMap for the currently-open preview session, so
// handlePreviewMessage (a message from PREVIEW_NAV_SCRIPT, arriving well
// after openHtmlInNewTab's call stack has finished) can still act on it.
let previewSession = null;

function handlePreviewMessage(event) {
  if (!previewSession || event.source !== previewSession.popup) return;
  if (!event.data || event.data.source !== "r2c-preview" || !event.data.page) return;
  const { popup, handle, assetMap } = previewSession;
  openPageInPreview(popup, handle, assetMap, event.data.page).catch((e) => {
    console.error("Preview navigation failed:", e);
    try {
      popup.document.body.insertAdjacentHTML("afterbegin",
        `<div style="position:sticky;top:0;background:#fee;color:#900;padding:8px;font:14px sans-serif;z-index:9999">Couldn't open that page: ${e && e.message ? e.message : e}</div>`);
    } catch { /* popup gone */ }
  });
}
window.addEventListener("message", handlePreviewMessage);

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
// For a multipage build, this also wires up click-through navigation (see
// openPageInPreview) so Collection/Document pages you click into get the
// same asset-URL treatment as the first page, instead of showing broken
// images/links.
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
    previewSession = null;
    if (dirHandle) {
      const { map, created } = await buildAssetUrlMap(dirHandle);
      previewFileUrls = created;
      previewSession = { popup, handle: dirHandle, assetMap: map };
      await openPageInPreview(popup, dirHandle, map, HTML_FILE);
    } else {
      previewUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      popup.location.replace(previewUrl);
    }
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
        notes.push(`${HTML_FILE} left unchanged — no layout available this session (Build once with this folder open to refresh it).`);
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
  const versionEl = $("appVersion");
  if (versionEl) versionEl.textContent = `v${APP_VERSION}`;
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
  $("collectionLabelsCancel").addEventListener("click", () => $("collectionLabelsModal").classList.add("hidden"));
  $("collectionLabelsApply").addEventListener("click", applyCollectionLabels);
  $("collectionLabelsModal").addEventListener("click", (e) => { if (e.target === $("collectionLabelsModal")) $("collectionLabelsModal").classList.add("hidden"); });
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
  $("buildStepProfile").addEventListener("click", () => { void openProfileSelection(); });
  $("profileBackBtn").addEventListener("click", () => { showView("view-mode"); });
  $("profileContinueBtn").addEventListener("click", () => {
    if (!selectedProfile) return;
    void openCrateDetails();
  });
  // These guards must mirror refreshBuildStepActions()'s disabled conditions
  // exactly — a guard stricter than the disabled state is an enabled button
  // that silently does nothing. Neither requires a chosen profile: skipping
  // that step falls back to the bundled default (ensureProfileData).
  $("buildStepDescribe").addEventListener("click", () => {
    if (!dirHandle) return;
    void openCrateDetails();
  });
  $("buildStepOpenBuild").addEventListener("click", () => {
    if (!dirHandle || !rootDatasetOverride) return;
    void openBuild();
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
    void openBuild();
  });
  $("modalCancel").addEventListener("click", () => $("modal").classList.add("hidden"));
  $("modalBuild").addEventListener("click", () => { $("modal").classList.add("hidden"); void openCrateDetails(); });
}
boot();
