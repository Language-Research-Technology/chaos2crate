// Runs the selected MASP profile's validator against the built crate and
// logs pass/fail — automatic whenever a profile is selected, no
// optionSchema. ro-crate-masp is a heavy dependency (pulls in the whole
// validator library), so it's still dynamically imported here, same as
// before this was extracted from processFolder.
import { HOOKS } from "../hooks.js";

export const plugin = {
  name: "validate-crate",
  hooks: {
    [HOOKS.CRATE_VALIDATE]: async (ctx) => {
      const { crate, selectedProfileData, log } = ctx;
      if (!selectedProfileData) return;
      try {
        const { validateBuiltCrate } = await import("../../masp.js");
        const result = await validateBuiltCrate(selectedProfileData.validator, crate);
        if (result.ok) {
          log("Profile validation passed — crate conforms to the selected profile.", "ok");
        } else {
          log(`Profile validation found ${result.errors.length} issue(s):`, "warn");
          for (const e of result.errors) log(`  • ${e.message}`, "warn");
        }
      } catch (e) {
        log(`Profile validation could not run: ${e.message}`, "warn");
      }
    },
  },
};
