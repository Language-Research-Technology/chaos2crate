# resources2crate — Architecture

**What it is:** a browser tool that turns a folder on your computer into an [RO-Crate](https://www.researchobject.org/ro-crate/).

Describes `main` as of `ded84c0`.

---

## 1. What resources2crate does

You point it at a local folder, pick a *profile* describing what kind of collection it is, fill in the fields that profile asks for, and it writes a standards-compliant RO-Crate back into the same folder:

| Output | What it is |
|---|---|
| `ro-crate-metadata.json` | the crate as JSON-LD — the artefact that matters |
| `ro-crate-metadata.xlsx` | the same graph as a spreadsheet, for people who'd rather work in Excel |
| `ro-crate-preview.html` | a self-contained, browsable site for the collection |

Four properties define the tool:

- **Nothing leaves the machine.** All reads and writes go through the File System Access API. No server, no upload, no account; deployment is a static site.
- **It builds on the real RO-Crate libraries** — `ro-crate` for the graph, `ro-crate-excel` for the workbook, `ro-crate-static-site` for the preview. The tool orchestrates; it doesn't hand-roll JSON-LD.
- **A profile decides what the tool is, this run.** A MASP profile determines which fields you're asked for, which capabilities are available, what gets written onto each file, how the preview is laid out, and what counts as valid. Pick none and you get the bundled schema.org default: a minimal RO-Crate, no plugins, nothing domain-specific.
- **Almost everything is a plugin.** The core builds a graph and hands it around; AUSTLANG matching, spreadsheet merge, validation, and all three output formats are plugins tapping named lifecycle hooks.

It's built for people organising research collections — language documentation corpora, digitised archives, born-digital collections — who need consistent, publishable metadata without becoming RO-Crate experts.

---

## 2. The shape of the system

```
                    ┌────────────────────────────────────┐
                    │           MASP PROFILE             │
                    │   fetched when the user picks it   │
                    │                                    │
                    │  Describe fields · buildOptions ·  │
                    │  fileProperties · propertyGroups · │
                    │  rootDataset type · validation     │
                    └─────────────────┬──────────────────┘
                                      │ configures + gates
   ┌──────────────────────────────────┼──────────────────────────────────┐
   │                          HOOK BUS (5 stages)                        │
   │                                  │                                  │
   │  config:prepare → [input plugin] → files:analyze → crate:built →    │
   │                                     crate:validate → output:write   │
   └──────┬──────────────┬─────────────────┬──────────────┬──────────────┘
          │              │                 │              │
   INPUT_PLUGINS      austlang           merge      json · xlsx · html
   (exactly one)      validate-crate            (all tap output:write)
   generic │ docx

                    ┌────────────────────────────────────┐
                    │          CORE (crate.js)           │
                    │  file metadata · graph assembly ·  │
                    │  serialisation · FSA I/O · editing │
                    └────────────────────────────────────┘
```

**The core** turns a described file list into an RO-Crate graph and serialises it. It has no opinion about where the files came from, what enriched them, or how they're presented.

**The pipeline** owns only the mandatory steps — dispatch the input mode, count entities — and the sequence of hook emissions around them.

**Plugins** are everything optional. Each one declares its own UI (an `optionSchema` or `settingsSchema` fragment, composed into the forms at startup) and taps one or more hooks. Adding a capability means adding a file and a registry line, not editing the pipeline.

**The profile** sits above all of it, deciding which plugins the user is even offered.

---

## 3. Key concepts

**RO-Crate** — a packaging standard: a folder plus a JSON-LD manifest describing its contents as a graph of typed, linked entities.

**Entity** — a node in that graph: a `File`, a `Person`, a `Place`, a `RepositoryCollection`. Identified by `@id`, typed by `@type`, linked by properties like `hasPart`, `author`, `contentLocation`.

**MASP profile** — *Machine-Actionable Schema/Profile*. Itself an RO-Crate, published in a profile repository, formally stating what entity types a conforming crate contains, which properties each may or must carry, and what values those accept. Read through the [`ro-crate-masp`](https://github.com/Language-Research-Technology/ro-crate-masp) validator.

**Hook** — a named point in the build lifecycle where plugins run. Five of them, listed below.

**Plugin** — a module exporting a `plugin` object with an optional UI schema fragment and a set of hook handlers. Two registries: additive plugins that all coexist, and input-mode plugins of which exactly one runs.

---

## 4. The build pipeline and the hook contract

This is the heart of the system. `src/plugins/hooks.js` and `src/plugins/pipeline.js` are ~80 lines between them.

### 4.1 The hook bus

One registration primitive and one invocation primitive:

```js
hookBus.on(hookName, handler, { priority = 10 })   // register
await hookBus.emit(hookName, ctx)                  // run all handlers, in order, awaited
```

Not a WordPress-style actions/filters split: a handler that only reads `ctx` behaves like an action, one that writes back to `ctx` behaves like a filter, and both are just functions. Closer to Rollup's named lifecycle hooks crossed with Koa's single mutable `ctx`.

Handlers run **sequentially and awaited**, never in parallel — they mutate a shared crate, so ordering is load-bearing.

### 4.2 The five hooks

| Hook | When | What's on `ctx` | Contract |
|---|---|---|---|
| `config:prepare` | before anything is built | `config` (mutable) | adjust the effective config |
| `files:analyze` | after the file list exists | `filesWithMeta` | **generic input only** — docx mode has no per-file list |
| `crate:built` | crate exists | `crate` | mutate and enrich it |
| `crate:validate` | crate is final | `crate` | report on it, **don't mutate** |
| `output:write` | last | `dirHandle` | write files |

`files:analyze` firing only in generic mode is a real asymmetry, not an oversight: the docx adapter has no flat file list to analyse. A plugin that taps it silently does nothing in docx mode.

### 4.3 The context object

`processFolder` in `main.js` builds `ctx` and hands it to `runPipeline`. It carries, on entry:

`dirHandle`, `files`, `options` (every Build option and Setting, flattened), `log`, `config` (root dataset assembled from the profile plus the Describe form), `configSource`, `selectedProfileData`.

The pipeline and plugins add to it as they go: `filesWithMeta` and `sourceCount` from the input plugin, `crate`, `langByIndex` from AUSTLANG, `entities` and `typeCounts` from the pipeline, `buildHtml` and `lastHtmlTemplate` from the HTML plugin — the last two read back out by `main.js` afterward so the Show view and Edit-save can reuse them.

Plugins are stateless. The bus is created once at module load and handlers registered once; all per-build state lives in the fresh `ctx`.

### 4.4 The pipeline

```js
await hookBus.emit(CONFIG_PREPARE, ctx);
const inputPlugin = INPUT_PLUGINS[ctx.options.inputMode] || INPUT_PLUGINS.generic;
await inputPlugin.buildCrate(ctx, hookBus);        // emits FILES_ANALYZE internally, if it has files
await hookBus.emit(CRATE_BUILT, ctx);
ctx.entities   = graph.length;                      // core: entity stats
ctx.typeCounts = collectTypeCounts(graph);
await hookBus.emit(CRATE_VALIDATE, ctx);
await hookBus.emit(OUTPUT_WRITE, ctx);
```

The input plugin is called directly rather than through a hook, because exactly one must run and it must produce `ctx.crate` before anything else can proceed.

### 4.5 The two registries

```js
export const PLUGINS = [           // additive — all register, all coexist
  austlangPlugin, mergePlugin, validateCratePlugin,
  jsonOutputPlugin, xlsxOutputPlugin, htmlOutputPlugin,
];

export const INPUT_PLUGINS = {     // exclusive — one runs, keyed by inputMode
  generic: genericInputPlugin,
  docx: docxInputPlugin,
};
```

Input plugins are deliberately kept out of `PLUGINS`: they're mutually exclusive rather than additive, so they don't go through `registerAllPlugins` or contribute to the composed schemas.

**Ordering.** Array order in `PLUGINS` *is* hook-execution order for plugins sharing a stage. Every registration defaults to priority 10 and `Array#sort` is stable, so registering in this order reproduces the original inline sequence with no explicit priority numbers: AUSTLANG before merge (both tap `crate:built`), JSON before XLSX before HTML (all tap `output:write`).

### 4.6 Schema composition

Each plugin owns its slice of the UI:

```js
const OPTION_SCHEMA   = [...composeOptionSchema(),   ...CORE_OPTION_SCHEMA];
const SETTINGS_SCHEMA = [...CORE_SETTINGS_SCHEMA,    ...composeSettingsSchema()];
```

A plugin's `optionSchema` puts it in the Build panel (per-build choices); a `settingsSchema` puts it in the Settings modal (app preferences). A plugin with neither is always-on — JSON output and validation are both like this.

`CORE_OPTION_SCHEMA` holds one item that belongs to no plugin: `collectionLabelsBuilder`, because `docx_crate.js` consumes it while building entity names rather than at render time, and `docx_crate.js` isn't itself a plugin.

### 4.7 Writing a new plugin

```js
// src/plugins/my-thing/index.js
import { HOOKS } from "../hooks.js";

export const plugin = {
  name: "my-thing",
  optionSchema: { key: "enableMyThing", label: "Do the thing", default: false },
  hooks: {
    [HOOKS.CRATE_BUILT]: async (ctx) => {
      if (!ctx.options.enableMyThing) return;      // check your own option
      const { doIt } = await import("./heavy.js"); // dynamic-import heavy deps
      doIt(ctx.crate);
      ctx.log("Did the thing.", "ok");
    },
  },
};
```

Then add it to `PLUGINS` in `src/plugins/index.js`, positioned where it should run relative to others sharing its hook. For the option to be reachable, a profile must name `enableMyThing` in its `buildOptions.enabledOptionKeys`.

Three conventions worth following: **guard on your own option first** (handlers run on every build); **dynamic-import anything heavy** so it stays out of the main bundle; **log through `ctx.log`** rather than `console`.

---

## 5. MASP profiles

### 5.1 A profile is always in effect

There is no un-profiled path and no ad-hoc fallback config — this is why `src/defaults.js` no longer exists. But a profile is never *demanded* of the user either: when none has been chosen, the **bundled schema.org default** applies.

The default is `profiles/schema-org` from [`ro-crate-masp`](https://github.com/Language-Research-Technology/ro-crate-masp) — its own description reads "A minimal RO-Crate profile combined with the Schema.org MASP schema crate." It gives you a valid, plain RO-Crate: schema.org vocabulary, no domain assumptions, **no plugins**.

Concretely, building under the default produces:

| | |
|---|---|
| Describe asks for | `name`, `description`, `datePublished`, `license`, `conformsTo` — five fields |
| Root dataset type | `Dataset` |
| Written onto each `File` | nothing custom — the profile declares no `fileProperties` |
| Optional plugins offered | none (§5.4) |
| Output | `ro-crate-metadata.json` only |
| Preview layout | the profile's own six property groups, if HTML is enabled by hand |

This is the "I just want an RO-Crate" path. Choosing a domain profile from the profile repository is how you opt *into* structure, vocabulary, and plugins — never how you escape a broken default.

**Why bundled rather than fetched.** A fallback that can fail to load is not a fallback. The default's two JSON files are imported from the `ro-crate-masp` dependency at build time, so it works offline, survives a GitHub rate-limit, and can't 404. The profile crate is ~1.6 MB (~261 kB gzipped), so it is dynamically imported into its own chunk — the same treatment the AUSTLANG data pack gets, and it is only downloaded when a build actually runs without a chosen profile.

### 5.2 What a profile ships

Profiles come from two places: the **profile repository** (`benfoley/masp-profiles`), fetched when the user picks one, and the **bundled default** (§5.1), compiled in from the `ro-crate-masp` dependency. Both have the same shape — a folder containing:

```
<profile-name>/profile-crate/
    ro-crate-metadata.json    the profile as an RO-Crate: classes, properties, cardinalities
    crate-o-mode.json         editor hints, plus resources2crate's own configuration
```

The first is standard MASP, shared with `crate-o`. The second is where profile-specific behaviour lives:

| `crate-o-mode.json` key | Controls |
|---|---|
| `rootDataset.type` / `.conformsTo` | the root entity's `@type` and profile conformance |
| `metadataLicence` | the metadata descriptor's own licence |
| `fileProperties` | which custom fields get blank-initialised on every `File`, with their `rdf:Property` definitions |
| `propertyGroups` | how properties are grouped in the HTML preview |
| `longTextInputs` | which Describe fields render as textareas |
| `buildOptions` | which plugins and options the user is offered |
| editor hints (`rootDataset.type`, …) | required by the validator — see §5.6 |

### 5.3 The Describe form

The profile's root class definition is introspected into a field schema and the form is rendered from it. Nothing about the form is written into the app.

| Declared type | Rendered as |
|---|---|
| `Text` | text input, or textarea if named in `longTextInputs` |
| `Date` | date input, defaulted to today |
| `URL` | url input |
| property with an enumerated value list | select |
| another class, e.g. `Person` | text input that synthesises a linked `{@id, @type, name}` entity on submit |
| `Value` (PropertyValue-fixed) | nothing — structural, not user-editable |

Multi-valued properties take comma-separated input and produce arrays of references. Textarea selection comes from the profile rather than a guess at the property's name — MASP's editor-definition shape has no multiline hint, and the tool has no business inferring one.

### 5.4 Gating plugins and options

```jsonc
"buildOptions": {
  "enabledOptionKeys": ["makeHtml", "templateRepoFolder", "merge", "mergeFile", "mergeMappingBuilder"],
  "inputMode": "docx",
  "makeHtml": true
}
```

- `enabledOptionKeys` is an **allow-list**. Build options are hidden by default; a key — top-level or nested — appears only if the profile names it. Each profile opts in to the handful its workflow needs.
- Any other key pre-fills that option's value and fires its change handler so dependent fields settle.
- `inputMode` is pre-selected **and locked**, because the Describe field set and the parsing path both depend on it. A docx profile can't be run against a generic folder by accident.
- Settings are **not** gated — they're machine and user preferences, orthogonal to the profile.

**Hidden means off.** An option the profile didn't enable is not merely hidden — it is forced to its off value, so the plugin behind it does not run. Visibility and execution are the same decision. Without this, an option whose schema default is `true` would still run while invisible, and "no plugins" would be unenforceable: the schema.org default would silently emit an HTML preview nobody asked for.

**A profile with no `buildOptions` block at all offers no optional plugins** — the absent block reads as an empty allow-list, not as "no opinion". This is what makes the bundled default minimal, and it means an upstream profile authored for `crate-o` (which knows nothing about resources2crate's options) behaves conservatively here rather than switching everything on.

Always-on plugins are unaffected: JSON output and validation have no option key, so nothing gates them.

### 5.5 Validation

After every build `validate-crate` runs the profile's validator and reports into the build log — under the bundled default just as under a chosen profile, so even the minimal path tells you whether the crate conforms. Advisory: a failing crate is still written with its issues listed, because a crate you can inspect beats a refused build.

### 5.6 `ro-crate-masp` integration notes

Three upstream quirks shape `src/masp.js`:

- The package declares a `main` entry that doesn't exist in the repo, so the validator is imported by internal path. It lazy-loads `fs` only when handed a file path; the wrapper always passes parsed objects, so it runs unmodified in the browser.
- `setEditorHints()` is **required**, not optional. Without it, `getRootDatasetTypes()` returns the metadata *descriptor's* type rather than the subject dataset's.
- The validator has no passing path for `URL`-typed properties: its reference branch demands a matching entity node (which a bare URL never has), and its scalar branch doesn't list `URL`. Errors naming a URL-typed property are annotated in the log as a known limitation rather than presented as data problems.

Top-level validator errors are cardinality-phrased ("Expected at least 1 instances of X, found 0") and don't name the field, so the wrapper also pulls the per-property detail out of `results.rules`, which does.

---

## 6. The core

### 6.1 Crate assembly — `src/crate.js`

Isomorphic: imports only browser-safe entry points, returns strings and bytes rather than writing files. The same module runs under Node for tests and in the browser for real work.

**File metadata.** `buildFileMetadata(files)` derives each file's `@id` (its relative path), folder chain, top-level group, and possible duplicates. Duplicate detection normalises filenames — lowercase, strip `copy`/`duplicate` and `(2)`-style suffixes, collapse non-alphanumerics — and cross-links collisions.

**Graph assembly.** `buildCrate(filesWithMeta, config, log, opts)` initialises an `ROCrate` with the `ldac`, `pcdm`, `custom`, and `AUSTLANG` contexts, applies the profile-derived root dataset, emits folder and file entities, and rewrites structural hash-ids (`#Dyirbal`) to `arcp://` form on export.

Top-level folders are emitted one of two ways:

| Mode | Structure |
|---|---|
| `object` | one `RepositoryObject` per top-level folder; every file beneath it in `hasPart` |
| `collection` | one `RepositoryCollection` per folder, containing a child `RepositoryObject` per subfolder, plus a synthesised `<Name>_Files` object for files sitting directly in the top level |

**Profile-declared file properties.** `config.fileProperties` pairs a compact key with the `rdf:Property` entity documenting it. Each key is blank-initialised on every `File`; the definitions are added to the graph. `custom:possibleDuplicate` is the exception — written only when duplicates were actually found, and only if the profile asked for it. Nothing is added unconditionally.

**No layout fallback.** `crateToPreviewHtml` and `crateToMultiPageHtml` *throw* if no property groups are supplied. The library would otherwise fetch a default layout from GitHub at render time — fragile and CORS-blocked — and silently falling back to a generic layout would hide a profile misconfiguration. Callers pass the profile's resolved groups or get an error.

### 6.2 Shared helpers

`src/fs_helpers.js` — File System Access wrappers: permission checks, existence checks, text and JSON reads, `writeFile`, and `writeFileAtPath` which creates intermediate directories.

`src/github.js` — fetch primitives shared by `main.js` (profile list, template dropdown) and the HTML plugin (template bundles), kept neutral to avoid a circular import. Raw fetches are cache-busted with a timestamp, because `raw.githubusercontent.com` caches per-URL for minutes and can serve a stale profile after a push. Folder listings go through the Contents API, which is rate-limited to 60 unauthenticated requests/hour, so successful listings are cached per `(owner, repo, ref, path)` for the page's lifetime — failures aren't cached, so a rate-limit blip is retried rather than remembered.

### 6.3 Entity editing

The Edit view loads an existing `ro-crate-metadata.json` into a live `ROCrate`: browse and filter entities by type or text, edit values, add and remove values, add and delete entities, rename `@id`s with reference-following, delete with reference cleanup. Structural entities — root, descriptor, `File`/`RepositoryObject`/`RepositoryCollection` — have locked identifiers, since renaming them breaks the crate's relationship to the folder.

Saving rewrites the JSON and regenerates the xlsx and HTML if those files exist, reusing `lastHtmlTemplate` from the session's last build so a styled preview isn't silently downgraded to plain.

---

## 7. Plugin catalogue

### 7.1 Input plugins — exactly one runs

#### `generic-input` — `inputMode: "generic"`

Sorts the scanned file list, builds file metadata, emits `files:analyze`, then calls core `buildCrate`. The default mode and the baseline every other plugin assumes.

#### `docx-input` — `inputMode: "docx"`

Treats a folder of Word documents as a structured corpus. Substitutes for the whole assembly step — it produces `ctx.crate` directly rather than going through `buildCrate`, which is why it's an input plugin and not a `crate:built` tap. Runs `scanDocxFolder` first as a dry run: throws with guidance if no `.docx` files are found, warns if none of the sampled files use Heading 1/2/3 styles. `docx_crate.js` pulls in `mammoth` and `cheerio`, so it's dynamically imported and lands in its own ~810 kB chunk.

**How it reads a document.** `mammoth` converts to HTML preserving heading styles; `cheerio` walks the result as a state machine. Headings open chapters; within a chapter four conventions are recognised — a line naming an image file, an actually-embedded image, a `SOUND FILE: <name>` line, and caption lines immediately following an image (later split into caption and photo-credit halves).

**Structure produced.** Root dataset → `Collection` per folder → document part per file → `bibo:Chapter` per heading → media entities wrapping `File` nodes. Heading-3 sections carrying table rows nest inside the preceding Heading-2 chapter; otherwise they're siblings.

**Media.** A per-document lookup keys the `media/` folder by filename with and without extension, case-insensitively, so `Garden.JPG` in prose finds `media/garden.jpg`. Matched files are copied into `files/<collection>/media/`; embedded images are written as `embedded-<doc>-<n>.<ext>` with the extension derived from MIME type. Unresolved references degrade to text-only properties rather than failing.

**Behaviours to preserve.** Files matching `notes?` are excluded entirely. Only a table appearing as the *very first* content under a Heading 2/3 is parsed as structured rows. The `files/` directory is deleted and rebuilt every run — media not referenced by the current build is discarded.

### 7.2 `crate:built` taps

#### `austlang` — option `enableLanguageLookups`

Identifies subject languages by matching filenames against a bundled offline copy of the AUSTLANG data pack. Two hooks: `files:analyze` runs the match, `crate:built` adds the `Language` entities and links files via `ldac:subjectLanguage`.

Whole-word, case-insensitive matching across ~1.2k records. Candidates under four characters and purely generic terms (`north`, `people`, `unknown`, …) are rejected. The sub-option `includeAlternateNames` widens matching, trading precision for recall.

The plugin owns the three `rdf:Property` definitions for the custom fields it writes (`custom:austlangCode`, `iso639-3`, `glottologCode`) and adds them **only when it actually identified a language** — not unconditionally for every build. The matcher and its ~730 kB data pack are dynamically imported only when the option is on.

Refresh the bundled data with `npm run update:austlang`.

#### `merge` — option `merge`

Attaches metadata from an Excel workbook to entities already in the crate, matching rows to entities by an `@id` column. The plugin owns the *when and how to gather options* logic; `./xlsx.js` owns the crate-mutating primitive.

Mapping config resolution: uploaded config → `merge-config.json` in the folder → bundled default. Each mapping pairs a column with a target property, optionally typed:

```jsonc
{ "sheet": "Files",
  "mapping": [
    { "source": "description", "target": "description" },
    { "source": ".author",     "target": "author",          "type": "Person" },
    { "source": ".location",   "target": "contentLocation", "type": "Place"  }
  ] }
```

An untyped mapping writes a literal; a typed one splits on commas and slashes, creates or reuses one entity per value, and links references. Prefixed targets trigger a scan of the workbook for context declarations, and missing prefixes found there are added to the crate. Any `custom:` property actually written gets a minimal `rdf:Property` generated. Unmatched files and unmatched rows are reported with samples — usually a path mismatch between folder and spreadsheet.

**Place lookup** — sub-option `doPlaceLookups`. When a mapping produces `Place` entities, attaches coordinates via a linked `Geometry`. Manual records from config first (deterministic, offline), then Geoscience Australia's Composite Gazetteer (exact, then prefix match), then GHAP. Each provider is tried against generated name variants: `Mt`↔`Mount`, `X Mountain`↔`Mount X`, plus the `lsland`/`Island` OCR fix. `placeMatchRegion` (`"QLD"`) boosts candidates from a state, letting name quality dominate while breaking ties sensibly. Every selection is logged with provider and region.

### 7.3 `crate:validate` tap

#### `validate-crate` — always on, no option

Runs the selected profile's validator and logs the result. No `optionSchema` — it runs whenever a profile is selected, which the UI guarantees. `ro-crate-masp` is heavy, so it's dynamically imported. Failures to *run* validation are caught and logged as warnings rather than failing the build.

### 7.4 `output:write` taps

All three respect the same `overwrite`-or-doesn't-exist gate and log a skip when they decline.

#### `ro-crate-json-output` — always on, no option

Writes `ro-crate-metadata.json`. A plugin like any other despite being unconditional — it has no `optionSchema`, which is how "always on" is expressed.

#### `ro-crate-xlsx-output` — setting `makeXlsx`

Writes the workbook. Declares a `settingsSchema` rather than an `optionSchema`, keeping it in the Settings modal. `ro-crate-excel` is imported as `lib/workbook.js`, not the package index — the index pulls in Node-only dependencies for OCFL and bagging, while the workbook path needs only `exceljs`, whose browser build Vite selects automatically.

#### `ro-crate-html-output` — option `makeHtml`

The largest plugin, owning the whole template-resolution cluster that used to sit inline in `main.js`.

**Layout.** The profile's `propertyGroups` are resolved against the built crate's own context — the same context the Describe step wrote properties under, so a resolved URI is guaranteed to match what's actually on the entity. Names that don't resolve are dropped rather than guessed at, and a group left with no resolvable inputs is dropped entirely. Profiles are expected to declare properly prefixed names for anything that isn't a real schema.org term; `crate.resolveTerm()` returns undefined for invented bare names.

**Template precedence:** repo folder → uploaded file → local folder.

1. **Template repository** — lists folders in `benfoley/rocss-template-repo` and fetches the chosen folder's template, config, stylesheet, and any `templates/` subfolder for multi-page rendering.
2. **Uploaded files** — a `config.json` from which template and style references are resolved: inline strings, `http(s)` URLs, sibling uploaded files, or paths inside a local folder the user grants access to once per session.
3. **Plain** — the library's single-page renderer with the profile's layout.

A template's own `config.json` `propertyGroups` still wins over the profile's — the most specific, deliberate customisation — with the profile filling in only when the template didn't set its own.

Two rendering details: the context must be resolved before layout resolution and again before rendering (idempotent, called in both places); and compact property keys are mirrored to full URIs, because templates address properties either way.

---

## 8. Interface flow

```
  Choose folder  ──►  Select profile  ──►  Describe  ──►  Build
       │                    │                  │            │
  FSA handle,         fetch + load        form from     pipeline runs,
  session reset         validator          profile      then validation
                            │
                       (skippable — falls back
                        to the bundled default)
```

Choosing a profile fetches its two JSON files, loads them into a validator, resolves the root class, and derives the Describe schema — cached for the session, cleared on folder change so a profile chosen for one collection doesn't carry over.

Selecting a profile is optional; Describe and Build are not. Skipping selection loads the bundled default instead, and from that point the flow is identical — the rest of the app only ever sees "the profile in effect", never "no profile". Every step downstream can assume a validator, a field schema, and a layout exist.

**Show** displays an existing crate in three tabs: preview, JSON, and the workbook rendered as HTML tables (capped at 200 rows and 20 columns, with a sheet switcher). Tabs fall back to whichever outputs exist.

The preview opens in a real browser tab rather than an iframe, because the generated pages rely on `:target` CSS that doesn't work in `srcdoc`. Local assets are rewritten to blob URLs first. Links between pages of a multi-page site are defanged and intercepted: an injected script posts the target path back to the opener, which materialises that page on demand with the same rewriting. Pages can't be pre-rewritten in bulk because their links are mutually cyclic.

**Settings** — input mode, theme, folder mode, overwrite, local template upload, xlsx — persist to `localStorage` and are profile-independent. Build options don't persist; they reset from the profile on every run.

---

## 9. Testing

Four Node scripts exercise the isomorphic core against the real libraries — no browser, no mocks of `ro-crate` or its siblings:

| Script | Covers |
|---|---|
| `test-crate.mjs` | build a crate from a synthetic file list; assert JSON, xlsx (PK zip magic), and HTML all generate |
| `test-edit-crate.mjs` | load, mutate (set/delete property, add/rename/delete entity), regenerate all three outputs |
| `test-place-merge.mjs` | merge a workbook with a typed `Place` mapping; assert the `Geometry` entity, its coordinates, and WKT |
| `test-top-level-folders.mjs` | object vs collection mode — entity types, `hasPart`, `pcdm:hasMember`/`memberOf`, `isPartOf` |

Because the profile now supplies what `defaults.js` used to, each script defines a minimal inline `TEST_CONFIG` — root dataset, and where relevant `fileProperties` and an explicit layout — standing in for a profile. `test-crate.mjs` and `test-edit-crate.mjs` print inspectable output; the other two use `node:assert/strict` and fail loudly.

Run them directly (`node test-crate.mjs`) or via `npm run test:place-merge` / `test:top-level-folders`.

---

## 10. Dependencies and runtime

| Package | Role |
|---|---|
| `ro-crate` | graph assembly and entity management |
| `ro-crate-excel` | xlsx output, via `lib/workbook.js` |
| `ro-crate-static-site` | HTML rendering, single and multi page |
| `ro-crate-masp` | profile loading and validation |
| `exceljs` | workbook read/write |
| `mammoth` | docx → HTML |
| `cheerio` | HTML parsing for the docx adapter |
| `@describo/data-packs` | source of the bundled AUSTLANG data (dev) |

Built with Vite. `vite-plugin-node-polyfills` supplies Buffer/process/global for transitive dependencies; `base: './'` lets the built site work from any path.

Dynamic imports keep heavy plugin code out of the main bundle — the docx adapter and the AUSTLANG data pack are separate chunks, downloaded only when a build actually uses them.

**Browser requirements.** File System Access API (Chrome/Edge), which needs a secure context — `localhost` or HTTPS, never `file://`. Also `fetch` for profiles, templates, and gazetteers; `localStorage` for settings; `postMessage` for preview navigation.

---

## 11. File layout

```
src/
  main.js                        UI, wizard, ctx assembly, schema composition
  crate.js                       CORE — assembly, serialisation (isomorphic)
  masp.js                        profile fetch, load, introspection, validation
  default_profile.js             the bundled schema.org fallback (§5.1)
  fs_helpers.js                  CORE — File System Access wrappers
  github.js                      shared fetch primitives + listing cache

  plugins/
    hooks.js                     hook bus + the five hook names
    pipeline.js                  mandatory steps + hook emission order
    index.js                     PLUGINS / INPUT_PLUGINS registries, schema composition

    generic-input/index.js       input plugin — folder scan
    docx-input/index.js          input plugin — docx corpus
    docx-input/docx_crate.js       parsing, media extraction, entity building
    austlang/index.js            crate:built — language identification
    austlang/matcher.js            matching logic (dynamically imported)
    austlang/austlang-data.json    bundled data pack
    merge/index.js               crate:built — spreadsheet merge
    merge/xlsx.js                  the merge primitive
    merge/place_lookup.js          coordinate lookup service
    merge/merge_config.json        default mapping
    validate-crate/index.js      crate:validate — profile validation
    ro-crate-json-output/index.js  output:write — JSON
    ro-crate-xlsx-output/index.js  output:write — xlsx
    ro-crate-html-output/index.js  output:write — HTML + template resolution
    ro-crate-html-output/layout.js   profile propertyGroups → resolved layout

test-crate.mjs  test-edit-crate.mjs  test-place-merge.mjs  test-top-level-folders.mjs
scripts/update-austlang-data.mjs
vite.config.js
```

---

## 12. Limitations and direction

**Not implemented.** PDF *content* language identification (filename matching only). OCFL building. SHACL-style RO-Crate validation independent of the selected profile's MASP rules.

**Known rough edges.** GitHub access is unauthenticated, so profile and template listings are rate-limited and private repositories are out of reach. The docx adapter wipes `files/` on every build rather than updating incrementally. `ro-crate-masp` mis-validates `URL`-typed properties; the tool annotates rather than works around it. The bundled default profile adds ~261 kB gzipped to the deployed site, in its own chunk, downloaded only when a build runs without a chosen profile.

**Where the architecture points.** The hook contract absorbs new capability without touching the pipeline: new input modes (archive import, OAI-PMH harvest) as `INPUT_PLUGINS` entries; new processors (content-based language ID, other gazetteers, database merge sources) as `crate:built` taps; new formats (RDF/XML, institutional XML schemas) as `output:write` taps. In each case the profile, not new UI, decides who gets them.

---

## 13. Glossary

**arcp** — URI scheme (`arcp://name,corpus/…`) for crate-internal identifiers that need to be absolute.

**CURIE** — compact URI: `ldac:subjectLanguage` expanding via the crate's context.

**Descriptor** — the entity describing `ro-crate-metadata.json` itself, pointing at the root dataset.

**Isomorphic** — runs unchanged in browser and Node; here, no file-system or DOM access, so the core is directly testable.

**LDAC** — Language Data Commons of Australia, whose profile vocabulary (`ldac:`) this tool emits.

**MASP** — Machine-Actionable Schema/Profile: a profile expressed as an RO-Crate, readable by tools.

**PCDM** — Portland Common Data Model, source of the `pcdm:hasMember`/`memberOf` collection relationships.

**Root dataset** — the entity representing the collection as a whole; everything hangs off it.

**Structural entity** — one whose `@id` encodes its place in the crate (files, folders, the root); renaming breaks the mapping to disk, so the editor locks them.
