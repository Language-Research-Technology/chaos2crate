// Writes ro-crate-metadata.xlsx, gated by the "Generate ro-crate-metadata.xlsx"
// Settings toggle (settingsSchema, not optionSchema — it stays in the
// Settings modal, its current location; only the fields explicitly asked to
// move to Build options — placename/Austlang lookups — changed location).
import { HOOKS } from "../hooks.js";
import { crateToXlsxBytes } from "../../crate.js";
import { writeFile, fileExists } from "../../fs_helpers.js";

const XLSX_FILE = "ro-crate-metadata.xlsx";

export const plugin = {
  name: "ro-crate-xlsx-output",
  settingsSchema: {
    key: "makeXlsx", label: "Generate ro-crate-metadata.xlsx", default: true,
  },
  hooks: {
    [HOOKS.OUTPUT_WRITE]: async (ctx) => {
      const { dirHandle, options, crate, log } = ctx;
      if (!options.makeXlsx) return;
      if (options.overwrite || !(await fileExists(dirHandle, XLSX_FILE))) {
        const bytes = await crateToXlsxBytes(crate);
        await writeFile(dirHandle, XLSX_FILE, bytes);
        log(`Wrote ${XLSX_FILE}.`, "ok");
      } else {
        log(`${XLSX_FILE} exists and overwrite is off — skipped.`, "warn");
      }
    },
  },
};
