// Multipage template resolution for the HTML preview.
//
// The pageTemplates map renderMultiPage consumes is keyed by the exact string
// the config wrote, and until this was fixed only the template repo could
// produce one — so a multipage template couldn't be developed locally at all.
// The build didn't fail either: it fell through to a single page whose entity
// links pointed at pages it never wrote.
import assert from "node:assert/strict";
import { multipageTemplateRefs, collectPageTemplates } from "../src/plugins/ro-crate-html-output/index.js";

const BIRDS_CONFIG = {
  types: {
    RepositoryObject: { template: "templates/subobject-template.html" },
    Person: { template: "templates/person-template.html" },
    AboutPage: { template: "templates/about-template.html" },
  },
  root: { template: "templates/root-template.html" },
  domain: "http://example.com/birds",
};

// The same config as it looks copied out of a CLI checkout, where the paths
// are relative to that repo's root rather than to the config's own folder.
const CLI_STYLE_CONFIG = JSON.parse(JSON.stringify(BIRDS_CONFIG).replaceAll("templates/", "test_data/birds/templates/"));

const uploadFor = (names, prefix = "templates/") => {
  const files = new Map();
  for (const name of names) {
    const file = { text: async () => `<html>${name}</html>` };
    files.set(prefix + name, file);   // as buildFileField keys a relative path
    files.set(name, file);            // …and its basename
  }
  return files;
};

const TEMPLATE_NAMES = ["root-template.html", "subobject-template.html", "person-template.html", "about-template.html"];

/* ---------- which refs a config declares ---------- */

assert.deepEqual(
  multipageTemplateRefs(BIRDS_CONFIG).sort(),
  [
    "templates/about-template.html",
    "templates/person-template.html",
    "templates/root-template.html",
    "templates/subobject-template.html",
  ],
  "every per-type template counts, not just the root's"
);

assert.deepEqual(multipageTemplateRefs({ ...BIRDS_CONFIG, multipage: false }), [], "multipage:false declares nothing");
assert.deepEqual(multipageTemplateRefs({ root: { template: "template.html" } }), ["template.html"], "a root-only config still declares its root");
assert.deepEqual(multipageTemplateRefs(null), [], "no config declares nothing");
assert.deepEqual(multipageTemplateRefs({ style: "style.css" }), [], "a config with no template refs declares nothing");

{
  // The same file named by two types shouldn't be fetched twice.
  const shared = { types: { A: { template: "t.html" }, B: { template: "t.html" } }, root: { template: "t.html" } };
  assert.deepEqual(multipageTemplateRefs(shared), ["t.html"], "refs are de-duplicated");
}

/* ---------- resolving them from uploaded files ---------- */

{
  const pageTemplates = await collectPageTemplates(BIRDS_CONFIG, { uploadedFiles: uploadFor(TEMPLATE_NAMES) });
  assert.deepEqual(
    Object.keys(pageTemplates).sort(),
    multipageTemplateRefs(BIRDS_CONFIG).sort(),
    "the map must be keyed by the config's own strings — that's what renderMultiPage looks up"
  );
  assert.match(pageTemplates["templates/root-template.html"], /root-template\.html/, "each key should hold that template's text");
}

{
  // Keying by the ref rather than by where the file was found is what makes a
  // copied CLI config work: the upload has templates/x.html, the config asks
  // for test_data/birds/templates/x.html, and the basename match bridges them.
  const pageTemplates = await collectPageTemplates(CLI_STYLE_CONFIG, { uploadedFiles: uploadFor(TEMPLATE_NAMES) });
  assert.ok(
    "test_data/birds/templates/root-template.html" in pageTemplates,
    "a config path with the wrong prefix should still resolve, under the key it used"
  );
  assert.equal(Object.keys(pageTemplates).length, 4);
}

/* ---------- resolving them from a picked folder ---------- */

{
  // Stands in for a granted FileSystemDirectoryHandle: readFileTextFromDirectory
  // walks path segments, so only getDirectoryHandle/getFileHandle are needed.
  const notFound = () => { const e = new Error("nope"); e.name = "NotFoundError"; throw e; };
  const folder = {
    async getDirectoryHandle(name) {
      if (name !== "templates") notFound();
      return {
        async getFileHandle(file) {
          if (!TEMPLATE_NAMES.includes(file)) notFound();
          return { async getFile() { return { async text() { return `<html>${file}</html>`; } }; } };
        },
      };
    },
    async getFileHandle() { notFound(); },
  };

  const pageTemplates = await collectPageTemplates(BIRDS_CONFIG, { dirHandle: folder });
  assert.equal(Object.keys(pageTemplates).length, 4, "a picked folder should satisfy a whole multipage bundle");

  // The tail fallback: same folder, but the config's paths carry a prefix
  // that doesn't exist there.
  const fromCliConfig = await collectPageTemplates(CLI_STYLE_CONFIG, { dirHandle: folder });
  assert.equal(
    Object.keys(fromCliConfig).length, 4,
    "a path relative to somewhere further up should fall back to its tail rather than failing"
  );
}

/* ---------- failure is explicit, not a silent single page ---------- */

{
  await assert.rejects(
    () => collectPageTemplates(BIRDS_CONFIG, { uploadedFiles: uploadFor(["root-template.html"]) }),
    /Could not resolve/,
    "a bundle missing one of its type templates must say so — falling through to a single page writes dead entity links"
  );
}

assert.equal(await collectPageTemplates({ multipage: false, root: { template: "t.html" } }, {}), null,
  "an explicitly single-page config yields null, distinct from an empty map");

console.log(`test-page-templates: all tests passed (${TEMPLATE_NAMES.length} templates, uploads + picked folder + tail fallback)`);
