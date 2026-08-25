// The bundled fallback profile — ro-crate-masp's own profiles/schema-org,
// described upstream as "a minimal RO-Crate profile combined with the
// Schema.org MASP schema crate". It applies whenever the user hasn't chosen
// a profile, so there is no un-profiled build path: the rest of the app only
// ever sees "the profile in effect", never "no profile".
//
// Bundled rather than fetched, because a fallback that can fail to load is
// not a fallback — this way it works offline, survives a GitHub rate limit,
// and can't 404. The two files are used from the dependency unmodified; the
// only thing added on top is the buildOptions block below, which is ours to
// own (see BUILD_OPTIONS).
//
// This module is only ever reached by dynamic import (see ensureProfileData
// in main.js), which is what keeps the ~1.6 MB profile crate in its own
// chunk instead of the main bundle — the same treatment austlang/matcher.js
// gets for its data pack. Static imports below (rather than a nested
// dynamic import) so the JSON is resolved at build time and the chunk
// boundary sits exactly at this file.
import profileJson from "ro-crate-masp/profiles/schema-org/profile-crate/ro-crate-metadata.json" with { type: "json" };
import modeJson from "ro-crate-masp/profiles/schema-org/profile-crate/crate-o-mode.json" with { type: "json" };

// Sentinel id for the default in the profile picker, distinguishable from
// any real masp-profiles folder name.
export const DEFAULT_PROFILE_ID = "__default__";
export const DEFAULT_PROFILE_LABEL = "schema.org (default)";

// tools.chaos2crate.buildOptions is a chaos2crate extension to
// crate-o-mode.json — upstream ro-crate-masp has no reason to carry a key
// only this app reads, so the default profile's build behaviour is declared
// here rather than pushed into their file or forked into masp-profiles
// (which would cost the offline guarantee that bundling exists for). It's
// namespaced under "tools" (matching c2c-masp-profiles' tool-config.json)
// so other consumers of the same mode file can carry their own config
// alongside it without colliding.
//
// Enabling makeHtml is what gets the default a preview at all: an option not
// named in enabledOptionKeys is hidden AND forced off, so without this the
// plain renderer never runs. Nothing else is enabled — no templateRepoFolder
// or styledPreview (both reach the network to resolve a template), no merge,
// no language lookups. The result is a self-contained page rendered from the
// profile's own propertyGroups, with the library's built-in template.
const BUILD_OPTIONS = {
  enabledOptionKeys: ["makeHtml"],
  plugins: ["makeHtml"],
};

// A real masp-profiles entry's tool-config.json declares rootDataset.conformsTo
// (processFolder in main.js copies it onto every built crate's root dataset),
// but the vendored schema-org file has none — so a crate built with no profile
// chosen ended up with no conformsTo at all, and picking that folder back up
// had nothing to identify which profile (if any) built it (see
// detectProfileFromExistingCrate in main.js / src/profile_detection.js).
// This mirrors the exact self-id shape ro-crate-masp's own meta-profile uses
// for itself (".../profiles/ro-crate-masp/profile-crate/#profile"), just
// under "schema-org" — a real, published page, not an invented URI.
const DEFAULT_PROFILE_CONFORMS_TO = "https://language-research-technology.github.io/ro-crate-masp/profiles/schema-org/profile-crate/#profile";

// The same { profileJson, modeJson } shape masp.js's fetchProfile returns, so
// both paths feed loadValidator identically. modeJson is copied rather than
// mutated — an imported JSON module is a shared singleton, and patching it in
// place would leak across calls.
export function getDefaultProfile() {
  return {
    profileJson,
    modeJson: {
      ...modeJson,
      rootDataset: { ...(modeJson.rootDataset || {}), conformsTo: DEFAULT_PROFILE_CONFORMS_TO },
      tools: {
        ...(modeJson.tools || {}),
        chaos2crate: {
          ...(modeJson.tools?.chaos2crate || {}),
          buildOptions: { ...(modeJson.tools?.chaos2crate?.buildOptions || {}), ...BUILD_OPTIONS },
        },
      },
    },
  };
}
