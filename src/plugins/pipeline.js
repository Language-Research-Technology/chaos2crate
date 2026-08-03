// The build pipeline's core orchestration — what processFolder() used to do
// inline. Owns only the mandatory, non-optional steps (reading which input
// mode to use, producing the initial crate, computing entity stats) and the
// sequence of hook emissions around them; every optional behavior (AUSTLANG,
// merge, JSON/XLSX/HTML output, profile validation) lives in a plugin
// (src/plugins/*.js) tapping one of those hooks.
import { HOOKS } from "./hooks.js";
import { buildFileMetadata, buildCrate } from "../crate.js";

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

// ctx (built by main.js's processFolder before calling this) must carry:
// dirHandle, files, options, log, config (effective, overrides applied),
// configSource ("built-in default" | "config.json from folder"),
// selectedProfileData. Mutated in place as the pipeline runs; the caller
// reads ctx.buildHtml/ctx.lastHtmlTemplate back out afterward (set by
// ro-crate-html-output, if it ran).
export async function runPipeline(ctx, hookBus) {
  await hookBus.emit(HOOKS.CONFIG_PREPARE, ctx);

  if (ctx.options.inputMode === "docx") {
    ctx.log(`Config: ${ctx.configSource}.`, "muted");
    ctx.log("Parsing structured Word documents (Heading 1/2/3 → Collections/Chapters)…", "info");
    const { buildCrateFromDocxFolder, scanDocxFolder } = await import("../docx_crate.js");
    const scan = await scanDocxFolder(ctx.dirHandle);
    if (scan.docxCount === 0) {
      throw new Error(
        "No .docx files found in this folder's sub-folders. Expected one folder per collection " +
        "directly inside the picked folder, each containing structured .docx files."
      );
    }
    if (!scan.hasHeadingStyles) {
      ctx.log(
        "Warning: none of the sampled .docx files use Word's Heading 1/2/3 paragraph styles — " +
        "structure (Collections/Chapters) may come out empty. See the README for the required authoring conventions.",
        "warn"
      );
    }
    const result = await buildCrateFromDocxFolder(ctx.dirHandle, ctx.config, (msg) => ctx.log(msg, "muted"));
    if (!result) {
      throw new Error(
        "No collection sub-folders with .docx files were found. Expected one folder per collection " +
        "directly inside the picked folder, each containing structured .docx files — see " +
        "corpus-tools-person-centred-collections-docx's README for the folder layout."
      );
    }
    ctx.crate = result.crate;
    ctx.sourceCount = result.documentPartCount;
    ctx.log(`Built crate: ${result.collectionCount} collection(s), ${result.documentPartCount} document(s).`, "ok");
  } else {
    ctx.log(`Config: ${ctx.configSource}.`, "muted");
    ctx.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    ctx.filesWithMeta = buildFileMetadata(ctx.files);
    ctx.log(`Scanned ${ctx.filesWithMeta.length} file(s).`, "info");
    ctx.sourceCount = ctx.filesWithMeta.length;

    await hookBus.emit(HOOKS.FILES_ANALYZE, ctx);

    ctx.crate = buildCrate(ctx.filesWithMeta, ctx.config, ctx.log, { topLevelFolderType: ctx.options.topLevelFolderType });
  }

  await hookBus.emit(HOOKS.CRATE_BUILT, ctx);

  const graph = ctx.crate.getJson()["@graph"] || [];
  ctx.entities = graph.length;
  ctx.typeCounts = collectTypeCounts(graph);

  await hookBus.emit(HOOKS.CRATE_VALIDATE, ctx);
  await hookBus.emit(HOOKS.OUTPUT_WRITE, ctx);

  return { files: ctx.sourceCount, entities: ctx.entities, typeCounts: ctx.typeCounts };
}
