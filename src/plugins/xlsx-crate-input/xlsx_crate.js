// Reading an .xlsx that is *itself* an RO-Crate, and folding it into a build.
//
// Distinct from the merge plugin (../merge/xlsx.js), which reads an arbitrary
// spreadsheet and needs a mapping config to say what each column means. Here
// the workbook already carries RO-Crate structure — ro-crate-excel's own
// sheet layout, an @context sheet, entity-per-row sheets — so there is
// nothing to map: workbookToCrate() hands back a graph directly.
//
// Two things come out of that graph: the root dataset's properties, which
// seed the Describe-step config, and every other entity, which is merged into
// the crate the folder scan produced.
import { ROCrate } from "ro-crate";

export const FOLDER_XLSX_NAME = "additional-ro-crate-metadata.xlsx";

const DESCRIPTOR_ID = "ro-crate-metadata.json";
const ROOT_ID = "./";

// Root properties that describe the crate's own structure rather than the
// collection being described. Seeding these from the workbook would fight
// with the folder scan (which owns hasPart/hasMember) or with the profile
// (which owns @type/conformsTo).
const STRUCTURAL_ROOT_PROPS = new Set([
  "@id", "@type", "hasPart", "pcdm:hasMember", "conformsTo",
]);

function asArray(v) {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

function isEmpty(v) {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmpty);
  if (typeof v === "string") return v.trim() === "";
  return false;
}

// ro-crate-excel is a heavy dependency (ExcelJS plus the whole crate
// round-tripper) — callers reach this through a dynamic import, so it stays
// out of the main bundle.
export async function readCrateFromXlsxBytes(bytes) {
  const { Workbook } = await import("ro-crate-excel");
  const workbook = new Workbook();
  await workbook.loadExcelFromBuffer(bytes);
  if (!workbook.crate) throw new Error("the spreadsheet did not parse as an RO-Crate");
  return new ROCrate(workbook.crate.toJSON(), { array: true, link: true });
}

// The collection-level properties worth carrying into the build, as a plain
// object shaped like config.rootDataset. Reference values are flattened back
// to {"@id": …} — the linked entity itself arrives separately via
// mergeCrateEntities, and leaving the resolved object here would nest a copy
// of the whole entity inside the root.
export function rootPropertiesFromCrate(crate) {
  const root = crate.rootDataset;
  if (!root) return {};
  const out = {};
  for (const [key, rawValue] of Object.entries(root)) {
    if (STRUCTURAL_ROOT_PROPS.has(key)) continue;
    const values = asArray(rawValue).map((v) =>
      v && typeof v === "object" && v["@id"] ? { "@id": v["@id"] } : v
    );
    if (isEmpty(values)) continue;
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

// Fill gaps in `target` from `source`, leaving anything the user already
// supplied alone. Returns the keys actually taken, for the build log: a
// workbook silently overwriting typed-in Describe values would be the worst
// possible behaviour here.
export function seedRootDataset(target, source) {
  const taken = [];
  for (const [key, value] of Object.entries(source)) {
    if (!isEmpty(target[key])) continue;
    target[key] = value;
    taken.push(key);
  }
  return taken;
}

// Copy every non-root, non-descriptor entity from `source` into `target`.
// Existing entities are filled in rather than replaced, on the same
// "don't clobber what's already there" principle as seedRootDataset — the
// folder scan knows a File's real size and encodingFormat, the workbook
// knows what it's about.
export function mergeCrateEntities(target, source, log = () => {}) {
  let added = 0;
  let enriched = 0;

  for (const entity of source.entities()) {
    const id = entity["@id"];
    if (!id || id === DESCRIPTOR_ID || id === ROOT_ID) continue;
    if (id === source.rootDataset?.["@id"]) continue;

    const flat = {};
    for (const [key, rawValue] of Object.entries(entity)) {
      if (key === "@id") continue;
      const values = asArray(rawValue).map((v) =>
        v && typeof v === "object" && v["@id"] ? { "@id": v["@id"] } : v
      );
      if (!isEmpty(values)) flat[key] = values.length === 1 ? values[0] : values;
    }

    const existing = target.getEntity(id);
    if (!existing) {
      target.addEntity({ "@id": id, ...flat });
      added++;
      continue;
    }
    let changed = false;
    for (const [key, value] of Object.entries(flat)) {
      if (key === "@type") continue; // the folder scan's typing wins
      if (!isEmpty(existing[key])) continue;
      existing[key] = value;
      changed = true;
    }
    if (changed) enriched++;
  }

  log(`Spreadsheet crate: added ${added} entit(ies), enriched ${enriched}.`, "muted");
  return { added, enriched };
}

// Properties whose values are external identifiers by convention — a licence
// URL, a profile or spec URI, a media type. RO-Crate says referenced entities
// should be described, but nobody writes a contextual entity for
// creativecommons.org/licenses/by/4.0 or w3id.org/ro/crate/1.2, so warning
// about them buries the references that do matter (an #LDaCA author, a ROR
// publisher) under noise nobody will act on.
const EXTERNAL_REF_PROPS = new Set([
  "conformsTo", "license", "encodingFormat", "url", "sameAs", "identifier",
  "isBasedOn", "citation",
]);

// Entities that define the crate's vocabulary rather than describe its
// subject: the rdf:Property definitions a custom: namespace needs, term sets,
// and the like. A profile describes the data, not the scaffolding, so
// checking their properties against it produces only noise.
const VOCABULARY_TYPES = new Set([
  "rdf:Property", "rdfs:Class", "DefinedTerm", "DefinedTermSet", "ItemList",
  "PropertyValue",
]);

// Structural problems a MASP profile can't express, reported as warnings
// rather than errors (profile-rule failures are what count as errors — see
// validateBuiltCrate in ../../masp.js).
//
//  - a reference to an @id with no entity behind it. RO-Crate says
//    referenced entities should be described; the birds profile deliberately
//    leaves author/publisher unconstrained so this surfaces here instead of
//    failing the crate.
//  - a property no rule in the profile mentions. Not wrong — profiles are
//    not closed-world — but worth seeing, since it's usually a typo or a
//    property that belongs in the profile and isn't there yet.
export function collectWarnings(crate, validator = null) {
  const warnings = [];
  const known = knownPropertyNames(validator);
  const ids = new Set();
  for (const entity of crate.entities()) ids.add(entity["@id"]);

  for (const entity of crate.entities()) {
    const entityId = entity["@id"];
    const types = asArray(entity["@type"]).map(String);
    const isVocabulary = types.some((t) => VOCABULARY_TYPES.has(t));
    // The metadata descriptor is crate housekeeping written by the tooling,
    // not something the author controls — don't grade it against the profile.
    const isDescriptor = entityId === DESCRIPTOR_ID;

    for (const [key, rawValue] of Object.entries(entity)) {
      if (key === "@id" || key === "@type") continue;

      for (const value of asArray(rawValue)) {
        if (EXTERNAL_REF_PROPS.has(key)) break;
        const ref = value && typeof value === "object" ? value["@id"] : null;
        if (ref && !ids.has(ref)) {
          warnings.push({
            entity: entityId,
            property: key,
            message: `${entityId} · ${key} references "${ref}", which has no entity in the spreadsheet — it should be described, not just pointed at.`,
          });
        }
      }

      if (known.size && !known.has(key) && !isVocabulary && !isDescriptor && !/^rdfs?:/.test(key)) {
        warnings.push({
          entity: entityId,
          property: key,
          message: `${entityId} · ${key} is not a property the profile describes — check the spelling, or add it to the profile.`,
        });
      }
    }
  }
  return warnings;
}

// Every property name any rule in the profile mentions, across all classes.
// Empty set when the validator can't be introspected, which switches the
// unknown-property warning off rather than flooding the report.
function knownPropertyNames(validator) {
  const names = new Set();
  if (!validator) return names;
  try {
    validator.ensureParsed();
    for (const rule of Object.values(validator.rules?.properties || {})) {
      if (rule.propertyName) names.add(rule.propertyName);
    }
  } catch {
    return new Set();
  }
  return names;
}
