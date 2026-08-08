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
import { readFileBytes } from "../../fs_helpers.js";

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

// Validate the spreadsheet's own crate against the profile before its data
// reaches the build, so problems are attributed to the spreadsheet rather
// than surfacing later as puzzling errors about the built crate.
async function reportOnCrate(ctx, crate, sourceName) {
  const { selectedProfileData, log } = ctx;
  const { collectWarnings } = await import("./xlsx_crate.js");

  const warnings = collectWarnings(crate, selectedProfileData?.validator || null);
  for (const w of warnings) log(`  ! ${w.message}`, "warn");

  if (!selectedProfileData) return;
  try {
    const { validateBuiltCrate } = await import("../../masp.js");
    const result = await validateBuiltCrate(selectedProfileData.validator, crate);
    if (result.ok) {
      log(`${sourceName} conforms to the selected profile${warnings.length ? ` (${warnings.length} warning(s) above)` : ""}.`, "ok");
    } else {
      log(`${sourceName} has ${result.errors.length} profile error(s):`, "warn");
      for (const e of result.errors) log(`  • ${e.message}`, "warn");
    }
  } catch (e) {
    log(`Could not validate ${sourceName} against the profile: ${e.message}`, "warn");
  }
}
