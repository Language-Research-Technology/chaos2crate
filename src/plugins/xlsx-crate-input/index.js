// Seeds a build from an .xlsx that is itself an RO-Crate — either
// additional-ro-crate-metadata.xlsx sitting in the picked folder, or one the
// user uploads. Its root dataset fills gaps in the Describe-step config and
// its entities are merged into the crate the folder scan produced.
//
// Additive rather than an INPUT_PLUGIN on purpose: the folder scan still has
// to run, because generic-input is what creates the File entities the
// workbook's isPartOf/image references point at. This plugin supplies
// metadata; it does not replace the input mode.
import { HOOKS } from "../hooks.js";
import { FOLDER_XLSX_NAME } from "./xlsx_crate.js";
import { readFileBytes, readJsonFromFolder } from "../../fs_helpers.js";

const DESCRIPTOR_FILENAME = "ro-crate-metadata.json";

export const plugin = {
  name: "xlsx-crate-input",
  optionSchema: {
    key: "xlsxCrate", label: "Use metadata from an RO-Crate spreadsheet", default: false,
    hint: `Reads an .xlsx that is itself an RO-Crate. Uses ${FOLDER_XLSX_NAME} from the picked folder unless you upload one below.`,
    children: [
      { key: "xlsxCrateFile", type: "file", label: "RO-Crate spreadsheet (XLSX)", binary: true,
        accept: ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        hint: `Optional — overrides ${FOLDER_XLSX_NAME} in the folder. Validated against the selected profile as soon as it's chosen.` },
    ],
  },
  hooks: {
    // Offer prefill data for the Describe step from whichever crate-metadata
    // source in the folder was touched most recently — the spreadsheet the
    // collection is authored in, or the JSON a previous build (or rocxl)
    // wrote. Moved here (from being hardcoded in main.js's folder-pick flow)
    // so which sources count as "existing crate metadata" stays this
    // plugin's call, not the app's.
    [HOOKS.FOLDER_PICKED]: async (ctx) => {
      const { pickNewestCrateSource, readCrateJsonFromSource } = await import("./xlsx_crate.js");
      const source = await pickNewestCrateSource(ctx.dirHandle);
      if (!source) return;
      try {
        ctx.crateJson = await readCrateJsonFromSource(source);
        ctx.crateSourceLabel = `${source.name} (modified ${new Date(source.lastModified).toLocaleString()})`;
      } catch (e) {
        // A spreadsheet that won't parse shouldn't cost the user the JSON
        // sitting next to it — but if the JSON itself was the one that
        // failed, re-reading it again would just fail the same way.
        ctx.log(`Could not read ${source.name} for prefill: ${e.message}`, "warn");
        const fallback = source.kind !== "json" ? await readJsonFromFolder(ctx.dirHandle, DESCRIPTOR_FILENAME) : null;
        ctx.crateJson = fallback;
        ctx.crateSourceLabel = fallback ? DESCRIPTOR_FILENAME : "";
      }
    },

    // Seed the root dataset before the crate is built, so the values are in
    // ctx.config by the time generic-input calls buildCrate().
    [HOOKS.CONFIG_PREPARE]: async (ctx) => {
      const { options, dirHandle, log } = ctx;
      if (!options.xlsxCrate) return;

      const source = await resolveSource(options, dirHandle);
      if (!source) {
        log(`Spreadsheet metadata is on, but no file was uploaded and the folder has no ${FOLDER_XLSX_NAME} — skipping.`, "warn");
        return;
      }

      const { readCrateFromXlsxBytes, rootPropertiesFromCrate, seedRootDataset, collectWarnings } =
        await import("./xlsx_crate.js");

      let crate;
      try {
        crate = await readCrateFromXlsxBytes(source.bytes);
      } catch (e) {
        throw new Error(`Could not read ${source.name} as an RO-Crate spreadsheet: ${e.message}`);
      }
      log(`Reading crate metadata from ${source.name} (${source.origin}).`, "muted");

      const taken = seedRootDataset(ctx.config.rootDataset, rootPropertiesFromCrate(crate));
      log(taken.length
        ? `Took ${taken.length} root propert(ies) from the spreadsheet: ${taken.join(", ")}.`
        : "Spreadsheet root added nothing the Describe step hadn't already set.", "muted");

      await reportOnCrate(ctx, crate, source.name);

      // Held for CRATE_BUILT — reading the workbook twice would be wasteful
      // and could report the same warnings twice.
      ctx.xlsxCrate = crate;
    },

    [HOOKS.CRATE_BUILT]: async (ctx) => {
      if (!ctx.options.xlsxCrate || !ctx.xlsxCrate) return;
      const { mergeCrateEntities, applyCollectionMembership } = await import("./xlsx_crate.js");
      mergeCrateEntities(ctx.crate, ctx.xlsxCrate, ctx.log);
      // After the merge, so the entities the workbook's membership points at
      // are already in the crate to be checked against.
      applyCollectionMembership(ctx.crate, ctx.xlsxCrate, ctx.log);
    },
  },
};

// Upload wins over the folder file: an explicit choice beats a convention.
async function resolveSource(options, dirHandle) {
  if (options.xlsxCrateUpload) {
    return {
      name: options.xlsxCrateUpload.name,
      origin: "uploaded",
      bytes: await options.xlsxCrateUpload.file.arrayBuffer(),
    };
  }
  const bytes = dirHandle ? await readFileBytes(dirHandle, FOLDER_XLSX_NAME) : null;
  if (!bytes) return null;
  return { name: FOLDER_XLSX_NAME, origin: "found in the folder", bytes };
}

// A pre-existing cycle-detection gap in ro-crate-masp's validator (its
// per-entity "already validated" cache is only written *after* a check
// completes, not before it starts — see masp.js) means a circular reference
// between entities can make it re-attempt, and re-fail, the same rule for
// the same entity many times before it exhausts the call stack. Left alone,
// that turns into hundreds of identical "property X failed for entity Y"
// log() calls in one synchronous burst. Collapse consecutive duplicates and
// cap the total so one bad entity can't flood the log.
const MAX_LOGGED_MESSAGES = 40;
function logDeduped(messages, log, cls, bullet) {
  const counts = new Map();
  for (const msg of messages) counts.set(msg, (counts.get(msg) || 0) + 1);
  const unique = [...counts.entries()];
  for (const [msg, count] of unique.slice(0, MAX_LOGGED_MESSAGES)) {
    log(`  ${bullet} ${msg}${count > 1 ? ` (×${count})` : ""}`, cls);
  }
  if (unique.length > MAX_LOGGED_MESSAGES) {
    log(`  …and ${unique.length - MAX_LOGGED_MESSAGES} more distinct message(s) suppressed.`, cls);
  }
}

// Validate the spreadsheet's own crate against the profile before its data
// reaches the build, so problems are attributed to the spreadsheet rather
// than surfacing later as puzzling errors about the built crate.
async function reportOnCrate(ctx, crate, sourceName) {
  const { selectedProfileData, log } = ctx;
  const { collectWarnings } = await import("./xlsx_crate.js");

  const warnings = collectWarnings(crate, selectedProfileData?.validator || null);
  logDeduped(warnings.map((w) => w.message), log, "warn", "!");

  if (!selectedProfileData) return;
  try {
    const { validateBuiltCrate } = await import("../../masp.js");
    const result = await validateBuiltCrate(selectedProfileData.validator, crate);
    if (result.ok) {
      log(`${sourceName} conforms to the selected profile${warnings.length ? ` (${warnings.length} warning(s) above)` : ""}.`, "ok");
    } else {
      log(`${sourceName} has ${result.errors.length} profile error(s):`, "warn");
      logDeduped(result.errors.map((e) => e.message), log, "warn", "•");
    }
  } catch (e) {
    log(`Could not validate ${sourceName} against the profile: ${e.message}`, "warn");
  }
}
