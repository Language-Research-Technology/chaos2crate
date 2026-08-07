// The bundled fallback profile — ro-crate-masp's own profiles/schema-org,
// described upstream as "a minimal RO-Crate profile combined with the
// Schema.org MASP schema crate". It applies whenever the user hasn't chosen
// a profile, so there is no un-profiled build path: the rest of the app only
// ever sees "the profile in effect", never "no profile".
//
// Bundled rather than fetched, because a fallback that can fail to load is
// not a fallback — this way it works offline, survives a GitHub rate limit,
// and can't 404. The files are taken from the dependency as-is; nothing here
// forks or patches them.
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
export const DEFAULT_PROFILE_DESCRIPTION =
  "Minimal RO-Crate using schema.org terms. No domain vocabulary, no optional plugins — just a valid crate.";

// The same { profileJson, modeJson } shape masp.js's fetchProfile returns, so
// both paths feed loadValidator identically.
export function getDefaultProfile() {
  return { profileJson, modeJson };
}
