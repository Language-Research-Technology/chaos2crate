// Generates ro-crate-preview.html — resolves a template/config/css bundle
// (repo folder → uploaded file → local folder, in that precedence) and
// renders either a multipage or single-page preview. Owns the whole
// template-resolution helper cluster that used to live inline in main.js;
// only the shared GitHub-fetch primitives (also used for the profile list
// and template-repo folder dropdown) and generic FSA read/write helpers are
// imported from neutral modules rather than duplicated here.
import { HOOKS } from "../hooks.js";
import { crateToPreviewHtml, crateToMultiPageHtml } from "../../crate.js";
import { writeFile, writeFileAtPath, readJsonFromFolder, readFileTextFromDirectory, verifyPermission, fileExists } from "../../fs_helpers.js";
import { bustCacheUrl, buildGitHubTreeUrl, fetchGitHubTextFile, listGitHubFolder } from "../../github.js";
import { resolveProfileGroups } from "./layout.js";

const HTML_FILE = "ro-crate-preview.html";
const TEMPLATE_REPO_OWNER = "benfoley";
const TEMPLATE_REPO_NAME = "rocss-template-repo";
const TEMPLATE_REPO_REF = "main";

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

// Local-template-folder access is separate from the picked crate folder
// (dirHandle) — the user grants it once via showDirectoryPicker, cached
// here for the rest of the session.
let uploadedConfigDirHandle = null;
export function resetUploadedConfigDirHandle() {
  uploadedConfigDirHandle = null;
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

async function fetchTemplateBundle(owner, repo, ref, folderPath) {
  const safeFolder = String(folderPath || "").replace(/^\/+|\/+$/g, "");
  if (!safeFolder) throw new Error("No template folder selected.");

  const entries = await listGitHubFolder(owner, repo, ref, safeFolder);

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

  // Multipage bundles (see rocss-template-repo's README) keep their per-role
  // templates in a templates/ subfolder, referenced from config.json as
  // e.g. "templates/root-template.html" — a path relative to this folder.
  // Fetch every .html file there, keyed by that same relative path, so
  // crateToMultiPageHtml's pageTemplates lookup can resolve them directly.
  const pageTemplates = {};
  const templatesSubfolder = entries.find((e) => e && e.type === "dir" && e.name === "templates");
  if (templatesSubfolder) {
    const subEntries = await listGitHubFolder(owner, repo, ref, `${safeFolder}/templates`);
    const subHtmlFiles = subEntries.filter((e) => e && e.type === "file" && /\.html?$/i.test(e.name || ""));
    for (const entry of subHtmlFiles) {
      const text = await fetchGitHubTextFile(owner, repo, ref, entry.path, entry.download_url || "");
      pageTemplates[`templates/${entry.name}`] = text;
    }
  }

  return {
    template,
    config,
    css,
    pageTemplates,
    files: {
      template: templateFile ? templateFile.name : null,
      config: configFile ? configFile.name : null,
      style: styleFile ? styleFile.name : null,
    },
    source: buildGitHubTreeUrl(owner, repo, ref, safeFolder),
  };
}

export const plugin = {
  name: "ro-crate-html-output",
  optionSchema: {
    key: "makeHtml", label: "Generate ro-crate-preview.html", default: true,
    children: [
      { key: "templateRepoFolder", type: "select", label: "Template from rocss-template-repo",
        placeholder: "Loading folders…", hint: "Optional. Select one folder from the template repo." },
      { key: "styledPreview", label: "Upload template files", default: false,
        hint: "Off = the library's plain preview.", children: [
        { key: "configFile", type: "file", label: "Config (JSON)", accept: ".json,.css,.html,application/json,text/css,text/html",
          hint: "Required. If config uses relative paths, include sibling template/style files in the same upload/drop." },
      ] },
    ],
  },
  hooks: {
    [HOOKS.OUTPUT_WRITE]: async (ctx) => {
      const { dirHandle, options, crate, log } = ctx;
      if (!options.makeHtml) return;
      if (!(options.overwrite || !(await fileExists(dirHandle, HTML_FILE)))) {
        log(`${HTML_FILE} exists and overwrite is off — skipped.`, "warn");
        return;
      }
      try {
        // resolveTerm() (used below to place profile-declared property
        // names) needs the context resolved first — crateToPreviewHtml/
        // crateToMultiPageHtml also call this themselves, but only after
        // the layout has already been computed; safe/idempotent to call twice.
        await crate.resolveContext();
        const profilePropertyGroups = ctx.selectedProfileData?.workflow?.propertyGroups;
        const layout = resolveProfileGroups(crate, profilePropertyGroups);
        if (layout.length) {
          log(`Preview: profile layout applied (${layout.length} group(s): ${layout.map((g) => g.name).join(", ")}).`, "muted");
        }

        let html;
        const selectedFolder = (options.templateRepoFolder || "").trim();
        const repoSelected = !!selectedFolder;
        let pageTemplates = null;
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
            if (remote.pageTemplates && Object.keys(remote.pageTemplates).length > 0) {
              pageTemplates = remote.pageTemplates;
            }
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
          // A template's own config.json-declared propertyGroups (the most
          // specific, deliberate customization) still wins over the
          // profile's — the profile only fills in when the template didn't
          // set its own.
          const cfgHasOwnGroups = !!(cfg && Array.isArray(cfg.propertyGroups) && cfg.propertyGroups.length);
          const effectiveCfg = cfg && !cfgHasOwnGroups ? { ...cfg, propertyGroups: layout } : cfg;

          if (pageTemplates && !options.configUpload && cfg && cfg.multipage !== false) {
            log(`Preview: multipage template bundle (repo ${selectedFolder}) · config ${cfgSrc}.`, "muted");
            const multi = await crateToMultiPageHtml(crate, { config: effectiveCfg, css, pageTemplates });
            for (const page of multi.pages) {
              await writeFileAtPath(dirHandle, page.path, page.html);
            }
            log(`Wrote ${multi.pages.length} page(s) under ro-crate-preview_html/.`, "ok");
            html = multi.rootHtml;
            ctx.lastHtmlTemplate = null;
          } else if (template) {
            log(`Preview: styled tabular · template ${templateSrc} · config ${cfgSrc} · style ${cssSrc}.`, "muted");
            html = await crateToPreviewHtml(crate, { template, config: effectiveCfg, css });
            ctx.lastHtmlTemplate = { template, config: effectiveCfg, css, source: templateSrc };
          } else {
            log("Preview: plain (library default template; no custom template file provided).", "muted");
            html = await crateToPreviewHtml(crate, { layouts: { default: layout } });
            ctx.lastHtmlTemplate = null;
          }
        } else {
          log("Preview: plain (library default template).", "muted");
          html = await crateToPreviewHtml(crate, { layouts: { default: layout } });
          ctx.lastHtmlTemplate = null;
        }
        await writeFile(dirHandle, HTML_FILE, html);
        log(`Wrote ${HTML_FILE}.`, "ok");
        ctx.buildHtml = html;
      } catch (e) {
        log(`HTML preview failed: ${e.message}`, "err");
      }
    },
  },
};
