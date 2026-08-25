// The single "core deps" object every selected c2c-plugins plugin factory
// is called with — see c2c-plugins' README for which subset each plugin
// actually reads via its own createPlugin(deps). Passing the same full
// object to every plugin avoids needing a precise per-plugin dependency
// list here; an unused key is simply never read.
import {
  buildFileMetadata, buildCrate, addLanguageEntities,
  crateToPreviewHtml, crateToMultiPageHtml, crateToXlsxBytes, crateToJsonString,
  graphEntityById,
} from "../crate.js";
import {
  writeFileAtPath, readJsonFromFolder, writeFile, fileExists,
  readFileBytes, readFileTextFromDirectory, verifyPermission, statFile,
} from "../fs_helpers.js";
import { bustCacheUrl, buildGitHubTreeUrl, fetchGitHubTextFile, listGitHubFolder } from "../github.js";

// A generic modal shell any plugin can open for its own standalone UI
// action (e.g. an optionSchema "action" tile's own run(runtime) handler —
// main.js's renderOptionGroupTiles) — index.html supplies only the overlay,
// title, and dismiss icon (#pluginActionModal); render(body, close) builds
// everything else itself via createElement, the same "no host markup, no
// HTML string" discipline the rest of this app's own modal-with-children
// tiles already follow. Lives here rather than in main.js so a plugin gets
// it the same way it gets every other host capability — through `deps`,
// with no import of anything from main.js in either direction.
//
// close(value) resolves the returned promise and hides the modal. onDismiss
// (optional) decides what the generic × icon and a backdrop click resolve
// to — defaults to close(undefined) — since only the plugin itself knows
// whether "dismissed without an explicit choice" means "apply defaults" or
// "cancel" for its own feature (see setlist_match_action.js's own two
// openers, c2c-chordpro-plugin, for one of each).
function openModal({ title, render, onDismiss, modalClassName } = {}) {
  const overlay = document.getElementById("pluginActionModal");
  const modalEl = overlay.querySelector(".modal");
  const titleEl = document.getElementById("pluginActionModalTitle");
  const body = document.getElementById("pluginActionModalBody");
  const dismissBtn = document.getElementById("pluginActionModalDismiss");

  titleEl.textContent = title || "";
  body.replaceChildren();
  if (modalClassName) modalEl.classList.add(modalClassName);
  overlay.classList.remove("hidden");

  return new Promise((resolve) => {
    let resolved = false;
    const close = (value) => {
      if (resolved) return;
      resolved = true;
      overlay.classList.add("hidden");
      body.replaceChildren();
      if (modalClassName) modalEl.classList.remove(modalClassName);
      dismissBtn.onclick = null;
      overlay.onclick = null;
      resolve(value);
    };
    const dismiss = () => close(onDismiss ? onDismiss() : undefined);
    dismissBtn.onclick = dismiss;
    overlay.onclick = (e) => { if (e.target === overlay) dismiss(); };
    render(body, close);
  });
}

export function buildDeps() {
  return {
    buildFileMetadata, buildCrate, addLanguageEntities,
    crateToPreviewHtml, crateToMultiPageHtml, crateToXlsxBytes, crateToJsonString,
    graphEntityById,
    writeFileAtPath, readJsonFromFolder, writeFile, fileExists,
    readFileBytes, readFileTextFromDirectory, verifyPermission, statFile,
    bustCacheUrl, buildGitHubTreeUrl, fetchGitHubTextFile, listGitHubFolder,
    openModal,
    // masp.js is a heavy validator library — kept dynamically imported from
    // this repo's own tree rather than statically imported here or in any
    // c2c-plugins plugin, so it stays code-split regardless of which
    // plugins a build selects.
    loadMasp: () => import("../masp.js"),
  };
}
