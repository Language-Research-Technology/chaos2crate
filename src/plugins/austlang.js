// Identifies subject languages by filename against a bundled, offline copy
// of the AUSTLANG data pack. The actual matching logic + the ~730kB data
// pack (src/austlang.js) is dynamically imported only when this plugin's
// option is on, so it stays out of the main bundle regardless of whether
// the plugin file itself is statically imported into the registry.
import { HOOKS } from "./hooks.js";
import { addLanguageEntities } from "../crate.js";

export const plugin = {
  name: "austlang",
  optionSchema: {
    key: "enableLanguageLookups", label: "Identify subject languages (AUSTLANG, by filename)", default: false,
    hint: "Matches filenames against a bundled copy of the AUSTLANG data pack — fully offline, no network.",
    children: [
      { key: "includeAlternateNames", label: "Match Austlang alternate names", default: false,
        hint: "More matches, more false positives." },
    ],
  },
  hooks: {
    [HOOKS.FILES_ANALYZE]: async (ctx) => {
      if (!ctx.options.enableLanguageLookups) return;
      const { identifyAllLanguages } = await import("../austlang.js");
      ctx.langByIndex = await identifyAllLanguages(ctx.filesWithMeta, ctx.options.includeAlternateNames, ctx.log);
    },
    [HOOKS.CRATE_BUILT]: (ctx) => {
      if (!ctx.langByIndex) return;
      const n = addLanguageEntities(ctx.crate, ctx.filesWithMeta, ctx.langByIndex);
      ctx.log(`Identified ${n} unique language(s).`, n ? "ok" : "muted");
    },
  },
};
