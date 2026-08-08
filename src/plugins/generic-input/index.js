// Generic-folder input mode: scans every file in the picked folder and
// builds RepositoryObject/RepositoryCollection/File entities from it
// (crate.js's buildFileMetadata + buildCrate). This is the default input
// mode and every other build plugin's baseline — and the only one with a flat
// file list, so the only one that declares analyzeFiles and therefore the only
// one whose builds emit files:analyze.
//
// Registered as an input-mode plugin (INPUT_PLUGINS, keyed by inputMode) —
// unlike the additive hook-tapping plugins in src/plugins/index.js's
// PLUGINS array, input-mode plugins are mutually exclusive: exactly one
// runs per build, dispatched by pipeline.js on ctx.options.inputMode.
import { buildFileMetadata, buildCrate } from "../../crate.js";

export const plugin = {
  name: "generic-input",
  inputMode: "generic",
  // Declaring this is what makes the pipeline emit files:analyze — see
  // runPipeline. Everything here is still plain data: taps get to annotate
  // ctx.filesWithMeta before buildCrate turns any of it into entities.
  analyzeFiles(ctx) {
    ctx.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    ctx.filesWithMeta = buildFileMetadata(ctx.files);
    ctx.log(`Scanned ${ctx.filesWithMeta.length} file(s).`, "info");
    ctx.sourceCount = ctx.filesWithMeta.length;
  },

  buildCrate(ctx) {
    ctx.crate = buildCrate(ctx.filesWithMeta, ctx.config, ctx.log, {
      topLevelFolderType: ctx.options.topLevelFolderType,
      // ctx.xlsxCrate is set at config:prepare, before this runs: a spreadsheet
      // already describes the entries and what belongs to what, so the folder
      // scan shouldn't invent a parallel structure alongside it.
      structureFromMetadata: !!ctx.xlsxCrate,
    });
  },
};
