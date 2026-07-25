# resources2crate

A browser app that turns a local folder of resources into an
[RO-Crate](https://www.researchobject.org/ro-crate/) — reading the folder and writing three
outputs back into it:

- `ro-crate-metadata.json` — the crate as JSON-LD
- `ro-crate-metadata.xlsx` — the crate as a spreadsheet (via `ro-crate-excel`)
- `ro-crate-preview.html` — a self-contained HTML preview (via `ro-crate-html-lite`)

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
npm install          # pulls ro-crate, ro-crate-excel, ro-crate-html-lite, exceljs, vite

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

1. **Select folder** — pick a local corpus folder (read + write).
2. **Build or Show:**
   - **Build** — scan the folder and generate the three RO-Crate outputs.
   - **Show** — display the existing `ro-crate-metadata.json` (offers to build one if missing).

---

## How the crate is built

`src/crate.js` is a dependency-light, **isomorphic** module (runs in the browser *and* Node)
that reproduces `corpus-tools-dyirbal`'s crate structure using the `ROCrate` class:

- root dataset (`RepositoryCollection`) with `pcdm:hasMember` → one `RepositoryObject` per
  top-level folder (standalone top-level files get a synthetic object);
- one `RepositoryObject` per top-level folder, `hasPart` listing every file beneath it;
- one `File` entity per file (`@id` = relative path, `isPartOf`, `custom:possibleDuplicate`);
- optional sample entities from `sample-data.json` (or built-in defaults), including
  custom `rdf:Property` definitions and sample people/places/localities;
- hash `@id`s of `RepositoryObject`s rewritten to `arcp://…/<name>` on export;
- optional AUSTLANG subject-language identification (filename-based; see options).

The crate object is then serialized with `crate.getJson()` (JSON), fed to `ro-crate-excel`'s
`Workbook` (xlsx), and to `ro-crate-html-lite`'s `renderSinglePage` (html).

### Options (Build)

| option | effect |
|--------|--------|
| Generate ro-crate-metadata.xlsx | write the spreadsheet output (on by default) |
| Include sample data entities | include entities from `sample-data.json` (or built-in defaults), including custom property definitions |
| Top-level folders are: Objects or Collections | Objects = existing behavior (`RepositoryObject`); Collections = `RepositoryCollection` with child folder objects and a `Files` object for direct files |
| Generate ro-crate-preview.html | write the HTML preview (on by default) |
| Template from rocss-template-repo | pick a folder from `benfoley/rocss-template-repo`; downloads and uses that folder's template config |
| Upload template files | upload a single `config.json`; template and style are resolved from values inside that config |
| Identify subject languages (AUSTLANG, by filename) | the original's `-l`; filename-based only; uses the bundled AUSTLANG data pack offline |
| …also match AUSTLANG alternate names | the original's `-a` |
| Merge metadata from a spreadsheet | upload an `.xlsx` and merge rows into crate entities by matching `@id` |
| Spreadsheet (XLSX) | the workbook used for merge; can contain multiple sheets |
| Build mapping from spreadsheet columns… | opens a mapping popup to set source → target property mappings (plus optional entity type) |
| Overwrite existing outputs | off = skip files that already exist |

### Spreadsheet merge and mapping

- Merge applies before output generation, so JSON/xlsx/html all include merged values.
- Merge mapping config precedence: mapping popup upload → `merge-config.json` in folder → bundled `src/merge_config.json`.
- Mapping popup supports workbook sheet selection; source columns refresh for the selected sheet.
- If a mapping config includes `sheet`, that sheet is selected and its headers are used.
- When a mapping config is loaded in the popup, rows are restricted to config-defined source fields (badge: “Showing config-defined sources”).
- Prefixed mapping targets (for example `dc:format`) trigger workbook context lookup; missing contexts found in workbook are added to the crate context.
- Popup shows a warning if target prefixes are unresolved against known + workbook contexts.
- During preview rendering, compact property keys are expanded using context prefixes so full-URI template columns can resolve merged values.

### Configuration

Root-dataset metadata and sample data come from built-in defaults (`src/defaults.js`,
the Dyirbal workshop config). Drop `config.json` and/or `sample-data.json` into the folder to
override them per-folder (same shapes as `corpus-tools-dyirbal`). `config.dataDir` is ignored
— the chosen folder is the data dir. If “Include sample data entities” is off, `sample-data.json`
and built-in sample entities (including custom property definitions) are not added to the crate.
Generated outputs and these two control files are skipped during the scan.

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
- **`ro-crate-html-lite` renders offline.** It uses nunjucks *precompiled* templates (no `fs`),
  and would otherwise `fetch` its default layout from GitHub at runtime (fragile + CORS). We
  bundle that layout (`src/default_layout.js`, vendored from the package) and pass it in, so no
  network call is needed.
- **`vite.config.js`** adds `vite-plugin-node-polyfills` (Buffer/process/global) as a safety
  net for transitive deps, and `base: './'` so the built site works from any path.

## Not included

- PDF *content* language identification (the original uses `pdf-parse`) — only filename-based
  AUSTLANG matching is ported.
- OCFL building (`merge.js`, `-m`/`-g`).
- Formal `ro-crate` validation.
