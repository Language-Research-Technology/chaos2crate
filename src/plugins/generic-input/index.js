// Generic-folder input mode: scans every file in the picked folder and
// builds RepositoryObject/RepositoryCollection/File entities from it
// (crate.js's buildFileMetadata + buildCrate). This is the default input
// mode and every other build plugin's baseline (FILES_ANALYZE only fires
// here — docx mode has no equivalent per-file list to analyze).
//
// Registered as an input-mode plugin (INPUT_PLUGINS, keyed by inputMode) —
// unlike the additive hook-tapping plugins in src/plugins/index.js's
// PLUGINS array, input-mode plugins are mutually exclusive: exactly one
// runs per build, dispatched by pipeline.js on ctx.options.inputMode.
import { HOOKS } from "../hooks.js";
import { buildFileMetadata, buildCrate } from "../../crate.js";

export const plugin = {
  name: "generic-input",
  inputMode: "generic",
  async buildCrate(ctx, hookBus) {
    ctx.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    ctx.filesWithMeta = buildFileMetadata(ctx.files);
    ctx.log(`Scanned ${ctx.filesWithMeta.length} file(s).`, "info");
    ctx.sourceCount = ctx.filesWithMeta.length;

    await hookBus.emit(HOOKS.FILES_ANALYZE, ctx);

    ctx.crate = buildCrate(ctx.filesWithMeta, ctx.config, ctx.log, {
      topLevelFolderType: ctx.options.topLevelFolderType,
      // ctx.xlsxCrate is set at config:prepare, before this runs: a spreadsheet
      // already describes the entries and what belongs to what, so the folder
      // scan shouldn't invent a parallel structure alongside it.
      structureFromMetadata: !!ctx.xlsxCrate,
    });
  },
};
