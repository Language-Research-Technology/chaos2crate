// The bundled schema.org default profile (src/default_profile.js) is what a
// build uses when the user picks no profile. This test drives that fallback
// end to end: load the profile, derive the Describe fields from it, build a
// crate the way processFolder would, and render the preview with the
// profile's own layout — asserting the result is a *minimal* crate.
import assert from "node:assert/strict";
import fs from "node:fs";

import { getDefaultProfile, DEFAULT_PROFILE_LABEL } from "../src/default_profile.js";
import { loadValidator, getRootClassDefinition, toDescribeFieldSchema, validateBuiltCrate } from "../src/masp.js";
import { buildFileMetadata, buildCrate, crateToJsonString, crateToPreviewHtml } from "../src/crate.js";
import { resolveProfileGroups } from "c2c-plugins/src/ro-crate-html-output/layout.js";
import { createPlugin } from "c2c-plugins/src/validate-crate/index.js";

function typesOf(entity) {
  return [].concat(entity?.["@type"] ?? []);
}

const { profileJson, modeJson } = getDefaultProfile();

/* ---------- the profile loads and describes itself ---------- */

const validator = await loadValidator(profileJson, modeJson);
const rootClassDefinition = getRootClassDefinition(validator);

assert.deepEqual(
  modeJson.rootDataset.type,
  ["Dataset"],
  "the default profile should build a plain Dataset, not a domain-specific root type"
);
assert.equal(
  modeJson.fileProperties,
  undefined,
  "the default profile should declare no fileProperties — nothing custom belongs on a minimal crate's files"
);

/* ---------- the default enables a plain preview, and nothing else ---------- */

const buildOptions = modeJson.tools?.chaos2crate?.buildOptions;
assert.deepEqual(
  buildOptions.enabledOptionKeys,
  ["makeHtml"],
  "the default profile should enable HTML output and no other Build option"
);
assert.equal(
  buildOptions.makeHtml,
  true,
  "HTML output should be on by default, not merely available"
);

for (const networked of ["templateRepoFolder", "styledPreview"]) {
  assert.ok(
    !buildOptions.enabledOptionKeys.includes(networked),
    `"${networked}" should stay disabled — the default preview must render offline, with no template fetch`
  );
}

// The overlay lives in default_profile.js, not in the vendored file, so the
// dependency's own copy has to stay untouched by it.
const vendoredMode = JSON.parse(
  fs.readFileSync(
    new URL("../node_modules/ro-crate-masp/profiles/schema-org/profile-crate/crate-o-mode.json", import.meta.url),
    "utf8"
  )
);
assert.equal(
  vendoredMode.tools,
  undefined,
  "tools.chaos2crate.buildOptions is a chaos2crate extension — the upstream profile file should not be patched in place"
);

/* ---------- the Describe step asks for a handful of schema.org fields ---------- */

const fieldSchema = toDescribeFieldSchema(rootClassDefinition, modeJson.longTextInputs || []);
const fieldKeys = fieldSchema.map((f) => f.key);

assert.deepEqual(
  [...fieldKeys].sort(),
  ["conformsTo", "datePublished", "description", "license", "name"],
  "Describe should ask for exactly the five minimal schema.org root fields"
);
assert.ok(
  fieldSchema.every((f) => !f.key.startsWith("ldac:") && !f.key.startsWith("custom:")),
  "no domain-vocabulary fields should appear under the default profile"
);

/* ---------- structural properties never become form fields ---------- */
// A profile declaring pcdm:hasMember with a class range would otherwise render
// an entity-ref text box, and typing a name there mints an empty entity that
// competes with the real one in the preview. Membership and part-hood come
// from the folder scan and supplied metadata, never from typing.
{
  const withStructure = {
    name: "Collection",
    inputs: [
      { name: "name", type: ["Text"], required: true },
      { name: "pcdm:hasMember", type: ["RepositoryObject"], required: true },
      { name: "pcdm:memberOf", type: ["RepositoryCollection"] },
      { name: "hasPart", type: ["File"] },
      { name: "isPartOf", type: ["RepositoryObject"] },
    ],
  };
  assert.deepEqual(
    toDescribeFieldSchema(withStructure, []).map((f) => f.key),
    ["name"],
    "hasMember/memberOf/hasPart/isPartOf are derived — the form should offer none of them"
  );
}

/* ---------- a build under the default produces a minimal crate ---------- */

const config = {
  rootDataset: {
    "@id": "arcp://name,default-profile-test",
    "@type": modeJson.rootDataset.type,
    name: "Default Profile Test",
    description: "A crate built with no profile selected.",
    datePublished: "2026-01-01",
  },
  // No fileProperties: the default profile declares none, and processFolder
  // only forwards what the profile gave it.
};

const files = [
  { fileName: "notes.txt", relativePath: "Docs/notes.txt" },
  { fileName: "data.csv", relativePath: "Docs/tables/data.csv" },
];
const crate = buildCrate(buildFileMetadata(files), config, () => {});
const graph = JSON.parse(crateToJsonString(crate))["@graph"];

const fileEntities = graph.filter((e) => typesOf(e).includes("File"));
assert.equal(fileEntities.length, 2, "both scanned files should become File entities");

for (const file of fileEntities) {
  const customKeys = Object.keys(file).filter((k) => k.startsWith("custom:"));
  assert.deepEqual(
    customKeys,
    [],
    `File "${file["@id"]}" should carry no custom: properties under the default profile`
  );
}

assert.equal(
  graph.filter((e) => typesOf(e).includes("rdf:Property")).length,
  0,
  "no rdf:Property definitions should be added when the profile declares no file properties"
);

const rootDataset = graph.find((e) => e["@id"] === config.rootDataset["@id"]);
assert.ok(rootDataset, "the root dataset should be in the graph under its arcp @id");
assert.ok(
  typesOf(rootDataset).includes("Dataset"),
  "the root dataset should be typed Dataset, as the profile declares"
);

/* ---------- the enabled preview renders from the profile's own layout ---------- */

await crate.resolveContext();
const layout = resolveProfileGroups(crate, modeJson.propertyGroups);

assert.equal(
  layout.length,
  modeJson.propertyGroups.length,
  "every one of the default profile's property groups should survive term resolution"
);
assert.ok(
  layout.every((group) => group.inputs.length > 0),
  "no resolved property group should be left empty"
);

const html = await crateToPreviewHtml(crate, { layouts: { default: layout } });
assert.match(html, /<html|<!doctype/i, "the preview should be an HTML document");
assert.ok(
  html.includes("Default Profile Test"),
  "the preview should show the crate name entered at the Describe step"
);

/* ---------- validation runs against the default, same as any profile ---------- */

const result = await validateBuiltCrate(validator, crate);
assert.ok(
  typeof result.ok === "boolean" && Array.isArray(result.errors),
  "profile validation should return a usable result for the default profile, not throw"
);

const validatePlugin = createPlugin({ loadMasp: async () => ({ validateBuiltCrate }) });
const seen = [];
await validatePlugin.hooks["crate:validate"]({
  crate,
  selectedProfileData: { validator },
  log: (msg, cls) => seen.push({ msg, cls }),
});
assert.ok(
  seen.some((entry) => /Validating crate against profile \(\d+ entities\)/i.test(entry.msg)),
  "validation should log its start with the crate entity count so the UI can label the secondary progress bar"
);

console.log(`test-default-profile: all tests passed (${DEFAULT_PROFILE_LABEL}, ${fieldSchema.length} Describe fields, ${layout.length} property groups)`);
