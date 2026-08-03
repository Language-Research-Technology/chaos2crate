# resources2crate

A browser app that turns a local folder of resources into an
[RO-Crate](https://www.researchobject.org/ro-crate/) — reading the folder and writing three
outputs back into it:

- `ro-crate-metadata.json` — the crate as JSON-LD
- `ro-crate-metadata.xlsx` — the crate as a spreadsheet (via `ro-crate-excel`)
- `ro-crate-preview.html` — a self-contained HTML preview (via `ro-crate-static-site`)

It reads and writes local files through the **File System Access API** (Chrome / Edge), so
the user's files never leave their machine. Unlike the earlier single-file version, this
one **uses the `ro-crate` library** to assemble the crate — the same approach as
[`crate-o`](https://github.com/Language-Research-Technology/crate-o) and
[`corpus-tools-dyirbal`](https://github.com/Language-Research-Technology/corpus-tools-dyirbal) —
rather than hand-building JSON-LD. Because those libraries are npm packages, the app is now
a small **Vite** project that bundles them for the browser.

## Install & run

Requires Node and npm (for the build). The end result runs in Chrome/Edge.

```bash
cd resources2crate
npm install          # pulls ro-crate, ro-crate-excel, ro-crate-static-site, exceljs, vite

npm run dev          # dev server at http://localhost:5173  → open in Chrome/Edge
# or
npm run build        # produces dist/  (a static site)
npm run preview      # serve the built dist/ at http://localhost:5000
```

The File System Access API needs a secure context (`http://localhost` or `https://`), so a
`file://` open won't work. To deploy, `npm run build` and host the `dist/` folder on any
static HTTPS host — the end-user experience is then zero-install.

> **Re-verify the crate pipeline** any time with `node test-crate.mjs` (after `npm install`):
> it builds a crate from a synthetic file list and confirms the JSON, xlsx, and html all
> generate. This is exactly how the pipeline was validated against the real libraries.

---

## The flow

The **Build** card walks through four steps:

1. **Choose folder** — pick a local corpus folder (read + write).
2. **Select profile** — choose a MASP profile (fetched from `benfoley/masp-profiles`) that
   matches this data; it determines which fields Describe asks for and which Build options
   are shown.
3. **Describe** — fill in the root-dataset fields the selected profile's schema asks for
   (name, description, license, etc.).
4. **Build** — scan the folder and generate the three RO-Crate outputs.

Separately, for a folder that already has a crate: the **Show** card displays the existing
`ro-crate-preview.html`/`ro-crate-metadata.json` (offering to build one if missing), and the
**Edit** card lets you edit entities/properties directly and save back to
`ro-crate-metadata.json`. Both have a "Build" shortcut in the context bar to rebuild in place —
it still requires a profile to be selected first (redirecting to Select profile if none is).

---

## How the crate is built

`src/crate.js` is a dependency-light, **isomorphic** module (runs in the browser *and* Node)
that assembles the crate using the `ROCrate` class (generic-folder mode; there's a separate
`src/docx_crate.js` path for Structured Word Documents mode — see Settings):

- root dataset, its `@type`/`conformsTo` and the metadata descriptor's license all come from
  the selected profile plus the Describe step (see "Configuration" below) — `pcdm:hasMember`/
  `hasPart` link it to one `RepositoryObject` per top-level folder (standalone top-level files
  get a synthetic object), or, in Collections mode, a `RepositoryCollection` with child folder
  objects and a `Files` object for direct files;
- one `File` entity per file (`@id` = relative path, `isPartOf`, `custom:possibleDuplicate`);
- always-on custom `rdf:Property` definitions for the file-level custom fields this app writes
  (`src/defaults.js`'s `CUSTOM_PROPERTIES`);
- hash `@id`s of `RepositoryObject`s rewritten to `arcp://…/<name>` on export;
- optional AUSTLANG subject-language identification (filename-based; see options).

The crate object is then serialized with `crate.getJson()` (JSON), fed to `ro-crate-excel`'s
`Workbook` (xlsx), and to `ro-crate-static-site`'s `renderSinglePage`/`renderTemplate`/
`renderMultiPage` (html, using the selected profile's own property-group layout).

### Options (Build)

| option | effect |
|--------|--------|
| Identify subject languages (AUSTLANG, by filename) | the original's `-l`; filename-based only; uses the bundled AUSTLANG data pack offline |
| …also match AUSTLANG alternate names | the original's `-a` |
| Merge metadata from a spreadsheet | upload an `.xlsx` and merge rows into crate entities by matching `@id` |
| Spreadsheet (XLSX) | the workbook used for merge; can contain multiple sheets |
| Build mapping from spreadsheet columns… | opens a mapping popup to set source → target property mappings (plus optional entity type) |
| Generate ro-crate-preview.html | write the HTML preview (on by default) |
| Template from rocss-template-repo | pick a folder from `benfoley/rocss-template-repo`; downloads and uses that folder's template config |
| Upload template files | upload a single `config.json`; template and style are resolved from values inside that config |

Which of these are actually shown depends on the selected profile's `crate-o-mode.json`
(`buildOptions.enabledOptionKeys`).

### Settings

Accessed via the ⚙ button in the Build view; these are app/session preferences rather than
per-build options, so they live outside the Build panel:

| setting | effect |
|--------|--------|
| Input type | Generic folder of files, or Structured Word documents (.docx) |
| Theme | Light or dark |
| Top-level folders are: Objects or Collections | Objects = existing behavior (`RepositoryObject`); Collections = `RepositoryCollection` with child folder objects and a `Files` object for direct files |
| Overwrite existing outputs | off = skip files that already exist |
| Enable local template upload | shows/hides the "Upload template files" Build option |
| Generate ro-crate-metadata.xlsx | write the spreadsheet output (on by default) |

Template repo fetches currently use a minimal/public access method: a plain GitHub Contents API request (with an `Accept` header) plus raw file downloads, with no `Authorization` token.
Future work: add optional token-based auth support to improve rate-limit headroom and private-repo access.
Future work: surface an explicit note/example in the merge UI for `placeLookup.providers` so users can pin lookups to a single source such as Geoscience Australia for deterministic results.

### Spreadsheet merge and mapping

- Merge applies before output generation, so JSON/xlsx/html all include merged values.
- Merge mapping config precedence: mapping popup upload → `merge-config.json` in folder → bundled `src/merge_config.json`.
- Mapping popup supports workbook sheet selection; source columns refresh for the selected sheet.
- If a mapping config includes `sheet`, that sheet is selected and its headers are used.
- When a mapping config is loaded in the popup, rows are restricted to config-defined source fields (badge: “Showing config-defined sources”).
- Prefixed mapping targets (for example `dc:format`) trigger workbook context lookup; missing contexts found in workbook are added to the crate context.
- Typed `Place` mappings now try to add a linked `Geometry` entity during merge. Geometry entities are stored with `@id`, `@type`, `.latitude`, `.longitude`, and `asWKT`, and linked from the place via `geo`.
- Merge config may include an optional `placeLookup` block with `enabled`, `providers`, `records`, `ghap`, and `geoscienceAustralia` settings, plus `placeMatchRegion` (for example `QLD`) to prefer candidates from a specific state/region when names are ambiguous. Manual `records` are checked first; by default live lookup now tries Geoscience Australia’s Composite Gazetteer ArcGIS service before GHAP/TLCMap-style endpoints.
- `placeMatchRegion` can also be set at the merge-config root level (outside `placeLookup`) for convenience; it is forwarded into place lookup settings.
- Popup shows a warning if target prefixes are unresolved against known + workbook contexts.
- During preview rendering, compact property keys are expanded using context prefixes so full-URI template columns can resolve merged values.

### Configuration

Root-dataset metadata (name, description, license, etc.) and root-level config
(`@type`, `conformsTo`, the metadata descriptor's own license) come entirely from the
selected MASP profile: `@type`/`conformsTo`/`metadataLicence` from that profile's
`crate-o-mode.json`, everything else from the values entered on the Describe step (driven
by the profile's schema). There is no built-in fallback and no folder-level `config.json`
override — a profile must be selected before Build is reachable, so this is always
fully determined. `src/defaults.js` now only holds `CUSTOM_PROPERTIES`, the always-on
`rdf:Property` definitions for the file-level custom fields (`participant`, `compiler`,
`possibleDuplicate`) and AUSTLANG-derived language fields this app always writes.

---

## Architecture / bundling notes

- **`src/crate.js` is isomorphic.** It imports only browser-safe entry points and returns
  bytes/strings; the caller does I/O. That's why it can be unit-tested in Node
  (`test-crate.mjs`) yet also run in the browser.
- **`ro-crate-excel` is imported via `ro-crate-excel/lib/workbook.js`**, *not* the package
  index. The index pulls in Node-only modules (`shelljs`, `fs-extra`, `hasha`) for OCFL/bagging;
  `lib/workbook.js` needs only `exceljs`, `ro-crate`, `lodash`, `uuid`. exceljs ships a browser
  build (`dist/exceljs.min.js`) that Vite selects automatically; we write `.xlsx` via
  `workbook.xlsx.writeBuffer()` (a Blob) instead of to disk.
- **`ro-crate-static-site` renders offline.** It uses nunjucks *precompiled* templates (no `fs`),
  and would otherwise `fetch` its default layout from GitHub at runtime (fragile + CORS). Instead
  we always pass an explicit layout — the selected profile's own `propertyGroups`, resolved
  against the built crate's context (`src/plugins/ro-crate-html-output/layout.js`). There's no
  bundled generic fallback: `crateToPreviewHtml`/`crateToMultiPageHtml` (`src/crate.js`) throw
  if no layout is supplied, rather than silently using one.
- **`vite.config.js`** adds `vite-plugin-node-polyfills` (Buffer/process/global) as a safety
  net for transitive deps, and `base: './'` so the built site works from any path.

## Not included

- PDF *content* language identification (the original uses `pdf-parse`) — only filename-based
  AUSTLANG matching is ported.
- OCFL building (`merge.js`, `-m`/`-g`).
- Formal SHACL-style RO-Crate validation — the `validate-crate` plugin runs the selected
  profile's MASP shape rules (via `ro-crate-masp`) after each build, which is narrower.
