// Merges metadata from an uploaded spreadsheet into matching crate entities
// (by @id) — mergeXlsxIntoCrate itself (./xlsx.js) is the crate-mutating
// primitive; this file owns the "when/how to gather options for it" logic
// that used to live inline in processFolder.
import { HOOKS } from "../hooks.js";
import { mergeXlsxIntoCrate } from "./xlsx.js";
import { readJsonFromFolder } from "../../fs_helpers.js";
import MERGE_CONFIG from "./merge_config.json" with { type: "json" };

export const plugin = {
  name: "merge",
  optionSchema: {
    key: "merge", label: "Merge metadata from a spreadsheet", default: false,
    hint: "Reads an .xlsx and merges its columns into matching entities (by their @id) before generating outputs.",
    children: [
      { key: "mergeFile", type: "file", label: "Spreadsheet (XLSX)", binary: true,
        accept: ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        hint: "Rows are matched to entities by the @id column." },
      { key: "mergeMappingBuilder", type: "mappingBuilder", label: "Build mapping from spreadsheet columns…",
        hint: "Reads the column headers from the spreadsheet above and lets you set a target property (and type) for each one. You can also load an existing mapping config.json from inside that dialog." },
      { key: "doPlaceLookups", label: "Do placenames lookup", default: true,
        hint: "When on, merged Place entities try to look up coordinates and generate linked Geometry entities." },
    ],
  },
  hooks: {
    [HOOKS.CRATE_BUILT]: async (ctx) => {
      const { options, dirHandle, crate, log } = ctx;
      if (!options.merge) return;
      if (!options.mergeUpload) {
        log("Merge is on but no spreadsheet was selected — skipping merge.", "warn");
        return;
      }

      let mergeConfig = MERGE_CONFIG, mcSrc = "bundled default";
      if (options.mergeConfigUpload) {
        const mcText = await options.mergeConfigUpload.file.text();
        try { mergeConfig = JSON.parse(mcText); }
        catch (e) { throw new Error(`uploaded merge config "${options.mergeConfigUpload.name}" is not valid JSON: ${e.message}`); }
        mcSrc = `uploaded (${options.mergeConfigUpload.name})`;
      } else {
        const folderMc = await readJsonFromFolder(dirHandle, "merge-config.json");
        if (folderMc) { mergeConfig = folderMc; mcSrc = "merge-config.json from folder"; }
      }
      log(`Merging ${options.mergeUpload.name} · mapping ${mcSrc}.`, "muted");
      const bytes = await options.mergeUpload.file.arrayBuffer();
      const effectiveMergeConfig = {
        ...mergeConfig,
        placeLookup: {
          ...(mergeConfig && typeof mergeConfig.placeLookup === "object" ? mergeConfig.placeLookup : {}),
          enabled: options.doPlaceLookups !== false,
        },
      };
      if (options.doPlaceLookups === false) log("Placename lookup disabled by settings.", "muted");
      await mergeXlsxIntoCrate(crate, bytes, effectiveMergeConfig, log);
    },
  },
};
