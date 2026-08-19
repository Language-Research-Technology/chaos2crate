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

export function buildDeps() {
  return {
    buildFileMetadata, buildCrate, addLanguageEntities,
    crateToPreviewHtml, crateToMultiPageHtml, crateToXlsxBytes, crateToJsonString,
    graphEntityById,
    writeFileAtPath, readJsonFromFolder, writeFile, fileExists,
    readFileBytes, readFileTextFromDirectory, verifyPermission, statFile,
    bustCacheUrl, buildGitHubTreeUrl, fetchGitHubTextFile, listGitHubFolder,
    // masp.js is a heavy validator library — kept dynamically imported from
    // this repo's own tree rather than statically imported here or in any
    // c2c-plugins plugin, so it stays code-split regardless of which
    // plugins a build selects.
    loadMasp: () => import("../masp.js"),
  };
}
