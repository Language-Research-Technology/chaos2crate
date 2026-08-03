// The build pipeline's core orchestration — what processFolder() used to do
// inline. Owns only the mandatory, non-optional steps (reading which input
// mode to use, producing the initial crate, computing entity stats) and the
// sequence of hook emissions around them; every optional behavior (AUSTLANG,
// merge, JSON/XLSX/HTML output, profile validation) lives in a plugin
// (src/plugins/*.js) tapping one of those hooks.
import { HOOKS } from "./hooks.js";
import { INPUT_PLUGINS } from "./index.js";

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

  ctx.log(`Config: ${ctx.configSource}.`, "muted");
  const inputPlugin = INPUT_PLUGINS[ctx.options.inputMode] || INPUT_PLUGINS.generic;
  await inputPlugin.buildCrate(ctx, hookBus);

  await hookBus.emit(HOOKS.CRATE_BUILT, ctx);

  const graph = ctx.crate.getJson()["@graph"] || [];
  ctx.entities = graph.length;
  ctx.typeCounts = collectTypeCounts(graph);

  await hookBus.emit(HOOKS.CRATE_VALIDATE, ctx);
  await hookBus.emit(HOOKS.OUTPUT_WRITE, ctx);

  return { files: ctx.sourceCount, entities: ctx.entities, typeCounts: ctx.typeCounts };
}
