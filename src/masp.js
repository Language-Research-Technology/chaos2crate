// MASP (Machine Actionable Schema/Profile — ro-crate-masp) integration.
// Isomorphic like crate.js: pure logic, no FSA/DOM. Fetches a profile crate
// from GitHub, loads it through the real ro-crate-masp validator, and maps
// its introspection output into a schema the UI can render a dynamic
// Describe-step form and gate Build options from.
//
// ro-crate-masp has no working package "main" entry (declared in its
// package.json but the file doesn't exist in the repo) — import the
// validator module directly. lib/masp-validator.js lazy-loads `fs` only when
// given a file-path string; passing already-fetched/parsed objects (as we
// always do here) never touches it, so this runs fine in the browser.
import { MaspValidator } from "ro-crate-masp/lib/masp-validator.js";
import { ROCrate } from "ro-crate";

const SCALAR_TYPES = new Set(["Text", "Date", "URL"]);

function buildGitHubRawUrl(owner, repo, ref, filePath) {
  const safePath = String(filePath || "").split("/").map((p) => encodeURIComponent(p)).join("/");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${safePath}`;
}

async function fetchGitHubJson(owner, repo, ref, filePath) {
  const url = buildGitHubRawUrl(owner, repo, ref, filePath);
  const res = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not download ${filePath} (${res.status} ${res.statusText}).`);
  return res.json();
}

// Fetches one profile's ro-crate-metadata.json + crate-o-mode.json from a
// masp-profiles-shaped repo (<owner>/<repo>/<folderName>/profile-crate/...).
export async function fetchProfile(owner, repo, ref, folderName) {
  const base = `${folderName}/profile-crate`;
  const [profileJson, modeJson] = await Promise.all([
    fetchGitHubJson(owner, repo, ref, `${base}/ro-crate-metadata.json`),
    fetchGitHubJson(owner, repo, ref, `${base}/crate-o-mode.json`),
  ]);
  return { profileJson, modeJson };
}

// Loads a fetched profile into a ready-to-query MaspValidator.
// setEditorHints(modeJson) is required, not optional — without it,
// getRootDatasetTypes() resolves to the RO-Crate metadata descriptor's own
// type (e.g. ["CreativeWork"]) rather than the subject dataset's, confirmed
// by testing against the real LDAC profile in ro-crate-masp.
export async function loadValidator(profileJson, modeJson) {
  const crate = new ROCrate(profileJson, { array: true, link: true });
  await crate.resolveContext();
  const validator = new MaspValidator(crate);
  validator.setEditorHints(modeJson || {});
  return validator;
}

// The class definition for the profile's root/subject entity — the first of
// getRootDatasetTypes() that's also one of the profile's enabled classes.
export function getRootClassDefinition(validator) {
  const rootTypes = validator.getRootDatasetTypes();
  const enabled = new Set(validator.getEnabledClasses());
  const rootType = rootTypes.find((t) => enabled.has(t));
  if (!rootType) {
    throw new Error(
      `Profile's root dataset type(s) [${rootTypes.join(", ")}] don't match any of its ` +
      `enabled classes [${[...enabled].join(", ")}] — check crate-o-mode.json's rootDataset.type.`
    );
  }
  return validator.getClassDefinition(rootType);
}

// Maps one MaspValidator "editor definition" input (see toEditorDefinition in
// ro-crate-masp) to a field-schema entry the Describe-step form builder
// consumes. Scalar types become plain inputs; a type naming another class
// (e.g. ["Person"]) becomes a text field that synthesizes a
// {"@id","@type","name"} sub-entity on submit — same pattern the old static
// Describe form already used for creator/inLanguage. A ["Value"]-typed input
// (PropertyValue-fixed) is structural, not user-editable, and is skipped.
function toDescribeField(input) {
  const types = Array.isArray(input.type) ? input.type : [input.type].filter(Boolean);

  if (types.includes("Value")) return null; // fixed/structural — nothing to render

  const base = {
    key: input.name,
    label: describeLabel(input.name),
    hint: input.help || "",
    required: !!input.required,
    multiple: !!input.multiple,
  };

  if (types.includes("Date")) return { ...base, inputKind: "date" };
  if (types.includes("URL")) return { ...base, inputKind: "url" };

  if (Array.isArray(input.values) && input.values.length > 0) {
    return { ...base, inputKind: "select", values: input.values };
  }

  const entityType = types.find((t) => !SCALAR_TYPES.has(t));
  if (entityType) return { ...base, inputKind: "entity-ref", entityType };

  return { ...base, inputKind: input.name === "description" ? "textarea" : "text" };
}

function describeLabel(propName) {
  const bare = String(propName || "").replace(/^[a-z][\w.-]*:/i, ""); // strip a prefix like "ldac:"
  const spaced = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// The full Describe-step field schema for a profile's root class.
export function toDescribeFieldSchema(classDefinition) {
  return (classDefinition.inputs || []).map(toDescribeField).filter(Boolean);
}

// Thin wrapper over validator.validateCrate() with a simpler result shape
// for the build log. Error messages from ro-crate-masp are cardinality-
// phrased ("Expected at least 1 instances of X, found 0") rather than always
// naming the specific missing field — confirmed against the real validator —
// so callers should treat these as "something in this class didn't
// conform," not a precise field-level diagnosis.
export async function validateBuiltCrate(validator, crate) {
  const results = await validator.validateCrate(crate);
  return {
    ok: results.error.length === 0,
    errors: results.error.map((e) => ({ message: e.message, entity: e.entity })),
  };
}
