// Always-on: writes ro-crate-metadata.json. No optionSchema — matches the
// current unconditional behavior (gated only by the overwrite/file-exists
// check every output plugin already respects).
import { HOOKS } from "./hooks.js";
import { crateToJsonString } from "../crate.js";
import { writeFile, fileExists } from "../fs_helpers.js";

const JSON_FILE = "ro-crate-metadata.json";

export const plugin = {
  name: "ro-crate-json-output",
  hooks: {
    [HOOKS.OUTPUT_WRITE]: async (ctx) => {
      const { dirHandle, options, crate, log } = ctx;
      if (options.overwrite || !(await fileExists(dirHandle, JSON_FILE))) {
        await writeFile(dirHandle, JSON_FILE, crateToJsonString(crate));
        log(`Wrote ${JSON_FILE}.`, "ok");
      } else {
        log(`${JSON_FILE} exists and overwrite is off — skipped.`, "warn");
      }
    },
  },
};
