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
// longTextInputs is the exact set of property names (matching input.name,
// including any prefix) the profile's own crate-o-mode.json declares as
// multiline — MASP's own editor-definition shape has no such hint, and
// chaos2crate has no business guessing from the property's name.
// Properties that say how the crate is put together rather than what it's
// about. A profile legitimately declares them — a collection really must have
// members — but they're derived from the folder scan and whatever metadata was
// supplied, never typed into a form. Rendering them does active harm: a
// profile giving pcdm:hasMember a class range makes it an entity-ref field, so
// typing "magpie" mints an empty RepositoryObject entity that then shows up in
// the preview alongside the real one.
const STRUCTURAL_PROPERTIES = new Set([
  "pcdm:hasMember", "pcdm:memberOf", "hasPart", "isPartOf",
]);

function toDescribeField(input, longTextInputs) {
  const types = Array.isArray(input.type) ? input.type : [input.type].filter(Boolean);

  if (types.includes("Value")) return null; // fixed/structural — nothing to render
  if (STRUCTURAL_PROPERTIES.has(input.name)) return null; // derived, not authored

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

  return { ...base, inputKind: longTextInputs.has(input.name) ? "textarea" : "text" };
}

function describeLabel(propName) {
  const bare = String(propName || "").replace(/^[a-z][\w.-]*:/i, ""); // strip a prefix like "ldac:"
  const spaced = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// The full Describe-step field schema for a profile's root class.
// longTextInputNames: modeJson.longTextInputs (crate-o-mode.json) — property
// names the profile wants rendered as a textarea instead of a single-line
// input. Defaults to none, not a guess.
export function toDescribeFieldSchema(classDefinition, longTextInputNames = []) {
  const longTextInputs = new Set(longTextInputNames);
  return (classDefinition.inputs || []).map((input) => toDescribeField(input, longTextInputs)).filter(Boolean);
}

// Property names (root class only) whose declared type is the primitive
// URL. ro-crate-masp's validatePropertyValue() (lib/masp-validator.js) has
// no valid-value path for this type: its object/reference branch requires
// a matching entity node in the target crate (which a bare URL reference,
// the normal way to represent one, never has), and its primitive-scalar
// branch only checks Text/Integer/Number/Boolean/Date/DateTime — never
// URL. Confirmed by testing both value shapes directly against the real
// validator (commit af4962d7, current HEAD of Language-Research-Technology
// /ro-crate-masp) — neither passes, regardless of the URL's validity. So a
// property-error naming one of these is a known validator limitation, not
// necessarily a real problem with the crate.
function urlTypedPropertyNames(validator) {
  const names = new Set();
  try {
    const rootDef = getRootClassDefinition(validator);
    for (const input of rootDef.inputs || []) {
      const types = Array.isArray(input.type) ? input.type : [input.type].filter(Boolean);
      if (types.includes("URL")) names.add(input.name);
    }
  } catch { /* best-effort only — validation still runs without this */ }
  return names;
}

// Thin wrapper over validator.validateCrate() with a simpler result shape
// for the build log. Top-level errors from ro-crate-masp are cardinality-
// phrased ("Expected at least 1 instances of X, found 0") rather than
// naming the specific missing field, so this also pulls in the per-property
// detail buried in results.rules (which does name the field) and flags any
// that concern a URL-typed property with the known-limitation note above.
export async function validateBuiltCrate(validator, crate) {
  const results = await validator.validateCrate(crate);
  const urlProps = urlTypedPropertyNames(validator);

  const errors = results.error.map((e) => ({ message: e.message, entity: e.entity }));
  for (const byEntity of Object.values(results.rules || {})) {
    for (const detail of Object.values(byEntity)) {
      for (const propError of (detail && detail["property-errors"]) || []) {
        const match = /^Property "([^"]+)" validation failed/.exec(propError.message || "");
        const isUrlProp = match && urlProps.has(match[1]);
        errors.push({
          message: isUrlProp
            ? `${propError.message} (known limitation: ro-crate-masp doesn't correctly validate URL-typed properties — this may be a false positive, not necessarily a problem with your data)`
            : propError.message,
          entity: null,
        });
      }
    }
  }

  return { ok: results.error.length === 0, errors };
}
