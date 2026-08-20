# resources2crate — SPEC

**What it is:** a browser tool that turns a folder on your computer into an [RO-Crate](https://www.researchobject.org/ro-crate/).

Describes `main` as of `1e3799a`.

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
- **A profile decides what the tool is, this run.** A MASP profile determines which fields you're asked for, which capabilities are available, what gets written onto each file, how the preview is laid out, and what counts as valid. Pick none and you get the bundled schema.org default: a minimal crate and a plain preview, nothing domain-specific and nothing that reaches the network.
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
   INPUT_PLUGINS   xlsx-crate-input      merge      json · xlsx · html
   (exactly one)      austlang                 (all tap output:write)
   generic │ docx     validate-crate

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

A small helper sits next to the bus: `announceAndEmit(hookBus, hookName, ctx)` calls `ctx.log` with which plugins are registered for a hook, in run order, before calling `emit` — and logs even when none are, as confirmation the hook point itself exists and fired, not just a report of what ran. Every caller below uses it instead of `emit` directly, so a build or a folder pick traces its own actual shape rather than relying on each plugin to self-report. Any `ctx` passed through it must carry a `log` function.

### 4.2 The hooks

Five fire from `runPipeline` during an actual build (§4.4); two fire earlier, from `main.js`, as a folder is picked and a profile is chosen — before Build ever runs. Same bus, same `ctx`-mutation contract, just a different caller.

**Pipeline hooks:**

| Hook | When | What's on `ctx` | Contract |
|---|---|---|---|
| `config:prepare` | before anything is built | `config` (mutable) | adjust the effective config |
| `files:analyze` | after the file list exists | `filesWithMeta` | **generic input only** — docx mode has no per-file list |
| `crate:built` | crate exists | `crate` | mutate and enrich it |
| `crate:validate` | crate is final | `crate` | report on it, **don't mutate** |
| `output:write` | last | `dirHandle` | write files |

`files:analyze` firing only in generic mode is a real asymmetry, not an oversight: the docx adapter has no flat file list to analyse. It's declared rather than implied — an input plugin with nothing to analyse exposes no `analyzeFiles`, and the pipeline skips the emission (§4.4). A plugin that taps the hook still silently does nothing in docx mode.

**Prep hooks**, fired from `main.js` (§8) rather than the pipeline:

| Hook | When | What's on `ctx` | Contract |
|---|---|---|---|
| `folder:picked` | a folder handle was just obtained | `dirHandle`, `crateJson`/`crateSourceLabel` (mutable) | offer existing crate metadata to prefill Describe from |
| `profile:selected` | a profile finished loading | `dirHandle`, `profileId`, `profileData` | react to the choice — currently untapped |

`folder:picked` decides whether the folder holds metadata worth prefilling the Describe step from, and which file — previously a direct call from `main.js` into `xlsx-crate-input`'s helpers, now that plugin's own tap (§7.2), so which sources count as "existing crate metadata" is the plugin's call rather than the app's. `profile:selected` currently has no tap; it exists so a future plugin could react to a profile choice (re-check folder content against it, adjust prefill) without `main.js` needing to know that plugin exists. It still fires, and still logs `→ profile:selected: (no plugins tap this).` (§4.1) — visible proof the extension point is live even with nothing registered against it.

### 4.3 The context object

`processFolder` in `main.js` builds `ctx` and hands it to `runPipeline`. It carries, on entry:

`dirHandle`, `files`, `options` (every Build option and Setting, flattened), `log`, `config` (root dataset assembled from the profile plus the Describe form), `configSource`, `selectedProfileData`.

The pipeline and plugins add to it as they go: `filesWithMeta` and `sourceCount` from the input plugin, `crate`, `langById` from AUSTLANG (a Map keyed by file id, not array position — it crosses a hook boundary, and nothing stops another tap reordering `filesWithMeta` in between), `entities` and `typeCounts` from the pipeline, `buildHtml` and `lastHtmlTemplate` from the HTML plugin — the last two read back out by `main.js` afterward so the Show view and Edit-save can reuse them.

Plugins are stateless. The bus is created once at module load and handlers registered once; all per-build state lives in the fresh `ctx`.

### 4.4 The pipeline

```js
await announceAndEmit(hookBus, CONFIG_PREPARE, ctx);
const inputPlugin = INPUT_PLUGINS[ctx.options.inputMode] || INPUT_PLUGINS.generic;
if (inputPlugin.analyzeFiles) {                     // only modes with a file list
  await inputPlugin.analyzeFiles(ctx);
  await announceAndEmit(hookBus, FILES_ANALYZE, ctx);
}
await inputPlugin.buildCrate(ctx);
await announceAndEmit(hookBus, CRATE_BUILT, ctx);
ctx.entities   = graph.length;                      // core: entity stats
ctx.typeCounts = collectTypeCounts(graph);
await announceAndEmit(hookBus, CRATE_VALIDATE, ctx);
await announceAndEmit(hookBus, OUTPUT_WRITE, ctx);
```

The input plugin is called directly rather than through a hook, because exactly one must run and it must produce `ctx.crate` before anything else can proceed.

**Input plugins expose two methods, and hold no bus.** `analyzeFiles(ctx)` is optional and prepares `ctx.filesWithMeta`; `buildCrate(ctx)` is required and produces `ctx.crate`. The pipeline emits `files:analyze` between them, and only when `analyzeFiles` exists — so a mode with no flat file list (docx) declares none and no emission happens, rather than firing a hook with nothing on `ctx` for taps to read. Every *build-time* emission is therefore in the block above: a build's hook order can be read off the pipeline without opening a plugin, and since no plugin receives `hookBus`, none can emit. (The two prep hooks fire earlier still, straight from `main.js`, before Build ever runs — §4.2, §8.)

### 4.5 The two registries

```js
export const PLUGINS = [           // additive — all register, all coexist
  xlsxCrateInputPlugin, austlangPlugin, caDataPrepPlugin, mergePlugin, validateCratePlugin,
  jsonOutputPlugin, xlsxOutputPlugin, htmlOutputPlugin,
];

export const INPUT_PLUGINS = {     // exclusive — one runs, keyed by inputMode
  generic: genericInputPlugin,
  docx: docxInputPlugin,
};
```

**This `src/plugins/index.js` is generated, not hand-written** (see §4.7a below) — the plugin *implementations* moved to a sibling repo, `c2c-plugins`. The shape above is still exactly what gets produced by default; only where the plugin modules themselves live, and how `PLUGINS`/`INPUT_PLUGINS` get assembled, changed.

Input plugins are deliberately kept out of `PLUGINS`: they're mutually exclusive rather than additive, so they don't go through `registerAllPlugins` or contribute to the composed schemas.

**Ordering.** Array order in `PLUGINS` *is* hook-execution order for plugins sharing a stage. Every registration defaults to priority 10 and `Array#sort` is stable, so registering in this order reproduces the original inline sequence with no explicit priority numbers: `xlsx-crate-input` first so the entities it contributes exist for the two that read the graph after it, then AUSTLANG before merge (all three tap `crate:built`), and JSON before XLSX before HTML (all tap `output:write`).

`xlsx-crate-input` is the one plugin that taps **three** stages for a single job — `folder:picked`, `config:prepare`, and `crate:built` — because its work spans from before a folder is even confirmed to hold anything build-worthy, through before the crate exists, to after. It is deliberately *not* an input plugin: the folder scan still has to run, since `generic-input` is what creates the `File` entities the spreadsheet's `isPartOf` and `image` references point at. What it does at each stage, and how it merges, is in §7.

### 4.6 Schema composition

Each plugin owns its slice of the UI:

```js
const OPTION_SCHEMA   = [...composeOptionSchema(),   ...CORE_OPTION_SCHEMA];
const SETTINGS_SCHEMA = [...CORE_SETTINGS_SCHEMA,    ...composeSettingsSchema()];
```

A plugin's `optionSchema` puts it in the Build panel (per-build choices); a `settingsSchema` puts it in the Settings modal (app preferences). A plugin with neither is always-on — JSON output and validation are both like this.

### 4.7 Writing a new plugin

Plugin implementations live in the sibling `c2c-plugins` repo now (§4.7a), not under `src/plugins/` — but the shape of a plugin is unchanged except for two things: hook names are literal strings rather than an imported `HOOKS` constant, and the plugin is exported as a `createPlugin(deps)` factory rather than a static object, so c2c-plugins carries no runtime dependency back on this repo.

```js
// c2c-plugins/src/my-thing/index.js
let doIt; // core resources2crate function this plugin needs, if any

export function createPlugin(deps) {
  ({ doIt } = deps);
  return plugin;
}

const plugin = {
  name: "my-thing",
  optionSchema: { key: "enableMyThing", label: "Do the thing", default: false },
  hooks: {
    "crate:built": async (ctx) => {
      if (!ctx.options.enableMyThing) return;      // check your own option
      const { doItHeavily } = await import("./heavy.js"); // dynamic-import heavy deps
      doItHeavily(ctx.crate, doIt);
      ctx.log("Did the thing.", "ok");
    },
  },
};
```

Then register it in c2c-plugins' own `index.js` (`REGISTRY`, keyed by the plugin's `name`), and add that same key to resources2crate's `PLUGINS` env var (or leave it unset/`all`, the default) so `scripts/select-plugins.mjs` includes it the next time `src/plugins/index.js` is regenerated — see §4.7a. Where it runs relative to others sharing its hook comes from `REGISTRY`'s own order in c2c-plugins, not from anything on the resources2crate side. For the option to be reachable, a profile must name `enableMyThing` in its `buildOptions.enabledOptionKeys`.

Four conventions worth following: **guard on your own option first** (handlers run on every build); **dynamic-import anything heavy** so it stays out of the main bundle; **log through `ctx.log`** rather than `console`; and **write a user-facing doc** if the plugin asks anything of the *person preparing content or running a build* — an authoring convention (headings, filename patterns, magic strings like `SOUND FILE:`), an option whose effect isn't self-explanatory from its label, or an expected file/config shape it reads. That doc is for the plugin's users, not its maintainers — this section and the rest of this file are the latter. It belongs under `docs/` (see §11), linked from the README rather than folded into it, following the pattern `docs/docx-authoring.md` set for `docx-input` (§7.1). A plugin with no user-visible behaviour beyond a self-explanatory option toggle doesn't need one.

Registering it in c2c-plugins' `REGISTRY` (above) is the path for a plugin that's joining that repo. It doesn't have to — §4.7a covers pulling a plugin in from somewhere else entirely: another repo built the same way (`PLUGINS=name=some-package`), or a one-off local file you're testing without touching any repo's registry at all (`PLUGINS=name=./path.js`).

### 4.7a The c2c-plugins repo split

Every plugin under §7's catalogue — both the additive kind and the two input modes — lives in `c2c-plugins`, a sibling checkout (`../c2c-plugins` next to this repo), not under `src/plugins/`. What stayed here is the plugin *engine*: `src/plugins/hooks.js` (the hook bus and `HOOKS` constants) and `src/plugins/pipeline.js` (orchestration), plus the isomorphic core every plugin reaches into — `src/crate.js`, `src/fs_helpers.js`, `src/github.js`, `src/masp.js`.

**c2c-plugins has no runtime dependency on this repo.** Two conventions make that possible, both covered in c2c-plugins' own README:

- Hook names are literal strings (`"crate:built"`, `"output:write"`, …) rather than an imported `HOOKS.CRATE_BUILT` — a stable contract owned by `src/plugins/hooks.js`, just not one c2c-plugins imports to use.
- Every plugin module exports `createPlugin(deps)` instead of a static `plugin` object. `deps` is resources2crate's core functions, built once by `src/plugins/deps.js`'s `buildDeps()` (the same full object handed to every plugin — an unused key is simply never read) and passed to each selected plugin's factory.

resources2crate depends on c2c-plugins as `"c2c-plugins": "file:../c2c-plugins"` — a local, symlinked dependency; not published to npm.

**Build-time plugin selection.** Not every deployment needs every plugin (`ca-data-prep` is specific to one dataset, for instance), so `src/plugins/index.js` is generated rather than hand-written: `node scripts/select-plugins.mjs` reads a `PLUGINS` env var (comma-separated plugin names; unset or `all` means everything) and writes `src/plugins/index.js` with static imports for only the selected plugins, pulled from c2c-plugins' `REGISTRY`. A runtime filter over an already-imported registry wouldn't achieve real bundle-size exclusion — Rollup can't tree-shake based on which object keys get read at runtime — so exclusion has to happen by simply never writing the `import` statement for a plugin that wasn't selected. Input-mode plugins (`generic`/`docx`) are always both included regardless of `PLUGINS`, since they're small and needed for the UI's input-mode switch.

```bash
npm run build                                            # every plugin (default)
PLUGINS=merge,validate-crate,ro-crate-json-output npm run build   # only these
```

The generator runs automatically before `dev`/`build`/`test` (package.json's `predev`/`prebuild`/`pretest` scripts call `select-plugins`), so `src/plugins/index.js` is always freshly regenerated before use — it's still committed so the file isn't missing for anyone who reads the repo without running a script first, but treat its content as disposable; don't hand-edit it.

**A `PLUGINS` entry doesn't have to come from c2c-plugins.** Each entry is either a bare name (c2c-plugins' `REGISTRY`, validated, ordered by `REGISTRY`'s own hook-execution order — the default and the common case), or `name=source`:

- `name=some-package` — `some-package`'s own `src/<name>/index.js`, the same layout convention c2c-plugins itself follows. For a plugin repo meant to stick around, wire it into `package.json` as its own dependency first — `"other-plugins": "file:../other-plugins"` for another local checkout (same pattern as c2c-plugins itself), or `"other-plugins": "github:org/other-plugins"` for one pulled from elsewhere online — then `npm install`, then reference it this way. There's no runtime remote-loading mechanism here; "online repo" still means "installed as a real dependency before the build runs," same as c2c-plugins.
- `name=./relative/path.js` or `name=/absolute/path.js` — an exact filesystem path (resolved against this repo's own root for a relative path), for a one-off local plugin you're testing without editing `package.json` at all.

Either form just needs to export `createPlugin(deps)`, the same contract as every plugin in c2c-plugins — `deps` is the identical object `buildDeps()` produces, so an external or local plugin can read whatever core functions it needs the same way. `select-plugins.mjs` dynamically imports every custom entry at generation time (before writing anything) specifically to catch a bad path or a missing `createPlugin` export immediately, with a clear message, rather than failing obscurely inside Vite later. Ordering: c2c-plugins' `REGISTRY` names keep their documented order; custom entries are appended after, in the order given in `PLUGINS` — there's no ordering information available for a plugin outside c2c-plugins' own registry, so place custom entries accordingly if they share a hook stage with something order-sensitive.

```bash
# a plugin from another repo built like c2c-plugins
PLUGINS=merge,special=other-plugins npm run build

# a plugin file you're testing locally, not wired into package.json at all
PLUGINS=merge,scratch=../scratch-plugin/index.js npm run build
```

### 4.7b Quick start: writing your own plugin

The full contract is §4.7/§4.7a above; this is the short version.

1. **Create a file** exporting `createPlugin(deps)`, which returns a plugin object:
   ```js
   // e.g. ../my-plugin/index.js
   export function createPlugin(deps) {
     return {
       name: "my-plugin",
       hooks: {
         "crate:built": (ctx) => {
           ctx.log("my-plugin ran!", "ok");
           // do something with ctx.crate
         },
       },
     };
   }
   ```
2. **Pick a hook** to tap — the seven stages are `folder:picked`, `profile:selected`, `config:prepare`, `files:analyze`, `crate:built`, `crate:validate`, `output:write` (§4.2–§4.4 cover what's on `ctx` at each one).
3. **Use `deps` for anything you need from resources2crate's core** (`crate.js`/`fs_helpers.js`/`github.js` functions) instead of importing them — e.g. `({ writeFileAtPath } = deps)` at the top of the file. This is what keeps a plugin decoupled and portable (§4.7a).
4. **Point `PLUGINS` at it** — no `package.json` changes needed for a quick local file:
   ```bash
   PLUGINS=merge,austlang,my-thing=../my-plugin/index.js npm run dev
   ```
5. **If it's meant to stick around**, turn it into its own small repo built like c2c-plugins (`src/<name>/index.js`), wire it into `package.json` (`"my-plugins": "file:../my-plugins"` or a `github:` URL), `npm install`, then reference it as `name=my-plugins` instead of a raw path.
6. **Add an `optionSchema`** if it should be toggleable in the Build panel, and make sure the active profile's `buildOptions.enabledOptionKeys` names your option key — otherwise it's off by default (§5.4).

**Known trade-off:** two of this repo's own files reach directly into a specific c2c-plugins plugin, bypassing the hook/pipeline system entirely — `main.js`'s merge-mapping-builder UI imports `readXlsxHeaders`/`readXlsxContextPrefixes` from `c2c-plugins/src/merge/xlsx.js`, and its uploaded-template-folder cache reset imports `resetUploadedConfigDirHandle` from `c2c-plugins/src/ro-crate-html-output/index.js`. Both predate the repo split (they were already direct imports, just from a local path) and are pure UI-support helpers `main.js`'s forms need regardless of build options — but because they're static imports, `merge` and `ro-crate-html-output` end up always bundled even if `PLUGINS` excludes them. Not addressed by the split; flagged here for whoever tackles it next.

---

## 5. MASP profiles

### 5.1 A profile is always in effect

There is no un-profiled path and no ad-hoc fallback config — this is why `src/defaults.js` no longer exists. But a profile is never *demanded* of the user either: when none has been chosen, the **bundled schema.org default** applies.

The default is `profiles/schema-org` from [`ro-crate-masp`](https://github.com/Language-Research-Technology/ro-crate-masp) — its own description reads "A minimal RO-Crate profile combined with the Schema.org MASP schema crate." It gives you a valid, plain RO-Crate: schema.org vocabulary, no domain assumptions, and a preview you can open.

Concretely, building under the default produces:

| | |
|---|---|
| Describe asks for | `name`, `description`, `datePublished`, `license`, `conformsTo` — five fields |
| Root dataset type | `Dataset` |
| Written onto each `File` | nothing custom — the profile declares no `fileProperties` |
| Output | `ro-crate-metadata.json` and `ro-crate-preview.html` |
| Preview | the library's built-in template, laid out by the profile's own six property groups — self-contained, no template fetch |
| Optional processing offered | none — no merge, no language lookups, no template sources (§5.4) |

This is the "I just want an RO-Crate" path: something valid to publish and something you can look at, with nothing invented about your data and no network call in the build. Choosing a domain profile from the profile repository is how you opt *into* structure, vocabulary, and plugins — never how you escape a broken default.

**The default's `buildOptions` are ours, not upstream's.** `buildOptions` is a resources2crate extension; the vendored profile has no such block, and upstream has no reason to carry a key only this app reads. So `src/default_profile.js` overlays one — enabling `makeHtml` and nothing else — onto an otherwise unmodified copy of the dependency's file. Pushing it upstream would put our concern in their repo and tie us to their release cycle; forking the profile into `masp-profiles` would cost the offline guarantee that bundling exists for.

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

**Structural properties are never rendered.** `pcdm:hasMember`, `pcdm:memberOf`, `hasPart` and `isPartOf` are dropped from the field schema even when a profile declares them. A profile is right to require that a collection have members; that requirement is satisfied by the folder scan or by supplied metadata, never by typing. Rendering them does active harm: given a class range they become entity-ref fields, so typing "magpie" mints an empty `RepositoryObject` that then appears in the preview beside the real one.

**Prefilling from the folder.** A folder may already hold the crate's metadata in more than one form: the spreadsheet the collection is authored in, and the `ro-crate-metadata.json` a previous build (or a `rocxl` sync) wrote. `pickNewestCrateSource()` in c2c-plugins' `src/xlsx-crate-input/xlsx_crate.js` picks between them by `lastModified` — whichever the author touched last is the one they've been working in, so that's what the form reflects. Candidates, in tie-break order:

1. `additional-ro-crate-metadata.xlsx`
2. `ro-crate-metadata.xlsx`
3. `ro-crate-metadata.json`

Ties go to the earlier entry, so a build that writes its outputs in the same second doesn't flip the answer away from the hand-authored spreadsheet. The chosen file is named above the form, because with several possible sources "where did these values come from?" deserves an answer that doesn't require opening any of them.

This is a **read of the root entity only** — it fills form fields, nothing more. Folding a spreadsheet's other entities into the build is the separate, opt-in job of the `xlsx-crate-input` plugin's hooks, and stays tied to the explicit `additional-ro-crate-metadata.xlsx`: merging a previous build's whole graph back in would resurrect entities for files since deleted from the folder.

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

**Hidden means off.** An option the profile didn't enable is not merely hidden — it is forced to its off value, so the plugin behind it does not run. Visibility and execution are the same decision, which makes `enabledOptionKeys` the single source of truth for what a build does: what a profile declares is exactly what happens. Without it the two drift, because plugins read `ctx.options` whether or not a field is on screen — any option whose schema default is `true` would keep running invisibly, and a profile could neither guarantee a capability runs nor guarantee it doesn't.

That guarantee is what lets the bundled default be described precisely: it names `makeHtml`, so it emits JSON and a preview and nothing else — no merge, no language lookups, no template fetch.

**A profile with no `buildOptions` block at all offers no optional processing** — the absent block reads as an empty allow-list, not as "no opinion". That keeps an upstream profile authored for `crate-o` (which knows nothing about resources2crate's options) conservative here rather than switching everything on. The bundled default gets its block from an overlay in `src/default_profile.js` (§5.1), precisely because the vendored file has none.

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

### 7.0 Every option key, and who owns it

A profile's `enabledOptionKeys` (§5.4) names keys from this table. Child keys are **listed separately, not implied by their parent** — a profile enabling `merge` without `mergeFile` gets the toggle and no file picker.

| Key | Plugin | Surface | Notes |
|---|---|---|---|
| `xlsxCrate` | `xlsx-crate-input` | Build panel | use metadata from an RO-Crate spreadsheet |
| ↳ `xlsxCrateFile` | `xlsx-crate-input` | Build panel | file picker; overrides the folder's `additional-ro-crate-metadata.xlsx` |
| `enableLanguageLookups` | `austlang` | Build panel | AUSTLANG matching |
| ↳ `includeAlternateNames` | `austlang` | Build panel | widens matching, trades precision for recall |
| `merge` | `merge` | Build panel | merge a spreadsheet's columns by `@id` |
| ↳ `mergeFile` | `merge` | Build panel | file picker |
| ↳ `mergeMappingBuilder` | `merge` | Build panel | column → property mapping dialog |
| ↳ `doPlaceLookups` | `merge` | Build panel | coordinate lookup for merged `Place` entities |
| `makeHtml` | `ro-crate-html-output` | Build panel | write `ro-crate-preview.html` |
| ↳ `collectionLabelsBuilder` | `ro-crate-html-output` | Build panel | menu names/order for Structured Word documents mode — applied to the generated HTML only; `docx_crate.js` always uses each folder's own name/order for the crate itself |
| ↳ `templateRepoFolder` | `ro-crate-html-output` | Build panel | folder in `rocss-templates` |
| ↳ `styledPreview` | `ro-crate-html-output` | Build panel | upload template files instead |
| ↳ ↳ `configFile` | `ro-crate-html-output` | Build panel | the uploaded `config.json` and its siblings |
| `makeXlsx` | `ro-crate-xlsx-output` | Settings modal | write `ro-crate-metadata.xlsx` |

Two kinds of key are deliberately absent from it:

- **`inputMode`, `overwrite`, `themeMode`, `topLevelFolderType`** — core settings. Ungated, except `inputMode`, which a profile pins and locks.
- **`ro-crate-json-output` and `validate-crate`** — no schema at all, which is how "always on, ungateable" is expressed.

The table is generated from the registry, so it can be regenerated rather than audited by eye:

```bash
node --input-type=module -e "
import { PLUGINS } from './src/plugins/index.js';
const walk = (n, p, kind, d = 0) => { if (!n) return;
  console.log('  '.repeat(d) + n.key.padEnd(24 - d * 2) + p.padEnd(24) + kind);
  for (const c of n.children || []) walk(c, p, kind, d + 1); };
for (const p of PLUGINS) { walk(p.optionSchema, p.name, 'Build panel'); walk(p.settingsSchema, p.name, 'Settings modal'); }
"
```

### 7.1 Input plugins — exactly one runs

#### `generic-input` — `inputMode: "generic"`

`analyzeFiles` sorts the scanned file list and builds file metadata; `buildCrate` turns the result into entities. The pipeline emits `files:analyze` between the two. The default mode and the baseline every other plugin assumes — and the only one with a flat file list, so the only one whose builds emit that hook at all.

**It stands down from inventing structure when something else describes it.** `buildCrate` takes `structureFromMetadata`, set when `xlsx-crate-input` has read a spreadsheet. With it, `addFolderEntities` creates no object-per-top-level-folder and `addFileEntities` writes no `isPartOf`, leaving both to the metadata. Without it the scan's guesses compete with the described entries — surfacing as extra cards in a preview that draws one per `RepositoryObject`, and claiming every file before the described parent could be applied.

Two names in `GENERATED_FILENAMES` are worth knowing about, since `walkDirectory` tests it against directory entries as well as files: `ro-crate-preview_html` (this tool's own multipage output — without it every rebuild folds the previous build's pages in as collection content) and `additional-ro-crate-metadata.xlsx` (metadata about the crate rather than content).

#### `docx-input` — `inputMode: "docx"`

Treats a folder of Word documents as a structured corpus. Substitutes for the whole assembly step — it produces `ctx.crate` directly rather than going through `buildCrate`, which is why it's an input plugin and not a `crate:built` tap. Runs `scanDocxFolder` first as a dry run: throws with guidance if no `.docx` files are found, warns if none of the sampled files use Heading 1/2/3 styles. `docx_crate.js` pulls in `mammoth` and `cheerio`, so it's dynamically imported and lands in its own ~810 kB chunk.

**How it reads a document.** `mammoth` converts to HTML preserving heading styles; `cheerio` walks the result as a state machine. Headings open chapters; within a chapter four conventions are recognised — a line naming an image file, an actually-embedded image, a `SOUND FILE: <name>` line, and caption lines immediately following an image (later split into caption and photo-credit halves).

**Structure produced.** Root dataset → `Collection` per folder → document part per file → `bibo:Chapter` per heading → media entities wrapping `File` nodes. Heading-3 sections carrying table rows nest inside the preceding Heading-2 chapter; otherwise they're siblings.

**Media.** A per-document lookup keys the `media/` folder by filename with and without extension, case-insensitively, so `Garden.JPG` in prose finds `media/garden.jpg`. Matched files are copied into `files/<collection>/media/`; embedded images are written as `embedded-<doc>-<n>.<ext>` with the extension derived from MIME type. Unresolved references degrade to text-only properties rather than failing.

**Behaviours to preserve.** Files matching `notes?` are excluded entirely. Only a table appearing as the *very first* content under a Heading 2/3 is parsed as structured rows. The `files/` directory is deleted and rebuilt every run — media not referenced by the current build is discarded.

### 7.2 `crate:built` taps

#### `xlsx-crate-input` — option `xlsxCrate`

Takes a build's metadata from an `.xlsx` that is *itself* an RO-Crate: `additional-ro-crate-metadata.xlsx` in the picked folder, or one uploaded through the option's file picker, which overrides it. Distinct from `merge`, which reads an arbitrary spreadsheet and needs a mapping config to say what the columns mean — here the workbook already carries RO-Crate structure, so `ro-crate-excel`'s `workbookToCrate()` returns a graph directly.

The only plugin that taps **three** stages for one job, since part of it runs before a folder is even confirmed to hold anything build-worthy, and the crate doesn't exist yet when the next part is needed:

| Hook | Does |
|---|---|
| `folder:picked` | pick the newest of the folder's candidate metadata sources (spreadsheet or plain JSON) and hand its parsed JSON back on `ctx.crateJson` for the Describe step to prefill from — a separate read from the two below, purely for the wizard, not the build |
| `config:prepare` | resolve the source, read it, validate it against the profile, seed `ctx.config.rootDataset` |
| `crate:built` | merge its entities in, then apply its collection membership |

The parsed crate is passed between them on `ctx.xlsxCrate` rather than being read twice — the same pattern `ro-crate-html-output` uses for `ctx.buildHtml`. That handle is also the signal `generic-input` reads for `structureFromMetadata` (§7.1).

Three merge decisions, each with a reason worth keeping:

- **Root properties fill gaps only.** A workbook must not overwrite what someone typed into Describe.
- **Entity properties are overwritten.** The spreadsheet wins on every property it states; properties it doesn't mention survive. Gap-filling let the folder scan win simply by writing first, which is how media files ended up belonging to a folder object rather than to the entry the spreadsheet named. This mirrors how `ro-crate-excel` merges a workbook's `RootDataset` sheet into an existing crate. It is deliberately *not* ro-crate's `addEntity({replace: true})` — the call Crate-O uses for the same job — because that drops every property the incoming entity omits, discarding the `encodingFormat` and `contentSize` only the folder scan knows. Crate-O has no scan behind it and so loses nothing.
- **Collection membership is replaced, not unioned.** The scan's folder objects aren't additional members; they're its guess at the same thing. Members the crate has no entity for are dropped with a warning rather than becoming references to nothing, and a workbook with no usable membership leaves the scan's answer alone.

Profile-rule failures are reported as errors, straight from `MaspValidator`. Structural problems a profile can't express are warnings the plugin computes: a reference to an `@id` nothing describes, and a property no rule mentions. Both need filtering to stay useful — `license`/`conformsTo`/`encodingFormat` point at external identifiers nobody writes entities for, and a crate's own `rdf:Property` definitions aren't data the profile grades. On a real birds workbook that's the difference between 2 actionable warnings and 17.

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

1. **Template repository** — lists folders in `Language-Research-Technology/rocss-templates` and fetches the chosen folder's template, config, stylesheet, and any `templates/` subfolder for multi-page rendering.
2. **Uploaded files** — a `config.json` from which template and style references are resolved: inline strings, `http(s)` URLs, sibling uploaded files, or paths inside a local folder the user grants access to once per session.
3. **Plain** — the library's single-page renderer with the profile's layout.

A template's own `config.json` `propertyGroups` still wins over the profile's — the most specific, deliberate customisation — with the profile filling in only when the template didn't set its own.

**Multipage.** A config with `root.template` and per-type `types.*.template` entries renders one page per entity plus a root, via `renderMultiPage`. That call looks its templates up in a `pageTemplates` map **keyed by the exact string the config wrote**, and misses throw rather than degrade.

`collectPageTemplates()` builds that map from whichever source the config came with — the repo folder's `templates/` subdirectory, sibling uploaded files, or a granted local folder — keying each entry by the ref rather than by where the file was found. That's what lets a config keep working whatever path style it uses: a bundle's `templates/root-template.html`, or the repo-root-relative `test_data/birds/templates/root-template.html` that a config copied out of a CLI checkout still carries. For a local folder there's a tail fallback for the same reason — the exact relative path first, then successively shorter tails.

The one pairing that's refused is an uploaded config with the *repo's* templates: those were keyed to the repo folder's own config, so combining them is how you get a template-not-found error. That case logs why and falls back to a single page. Every other failure is explicit — a bundle missing one of its type templates errors by name, because falling through to a single page writes a root whose entity links point at pages that were never generated.

Two rendering details: the context must be resolved before layout resolution and again before rendering (idempotent, called in both places); and compact property keys are mirrored to full URIs, because templates address properties either way.

---

## 8. Interface flow

```
  Choose folder  ──►  Select profile  ──►  Describe  ──►  Build
       │                    │                  │            │
  FSA handle,         fetch + load        form from     pipeline runs,
  session reset,        validator           profile      then validation
  folder:picked        profile:selected
                            │
                       (skippable — falls back
                        to the bundled default)
```

Choosing a folder fires `folder:picked` (§4.2) before anything else — currently only `xlsx-crate-input` taps it, offering existing crate metadata in the folder to prefill Describe from. Choosing a profile fetches its two JSON files, loads them into a validator, resolves the root class, derives the Describe schema, and fires `profile:selected` — cached for the session, cleared on folder change so a profile chosen for one collection doesn't carry over.

Selecting a profile is optional; Describe and Build are not. Skipping selection loads the bundled default instead, and from that point the flow is identical — the rest of the app only ever sees "the profile in effect", never "no profile". Every step downstream can assume a validator, a field schema, and a layout exist.

**Show** displays an existing crate in three tabs: preview, JSON, and the workbook rendered as HTML tables (capped at 200 rows and 20 columns, with a sheet switcher). Tabs fall back to whichever outputs exist.

The preview opens in a real browser tab rather than an iframe, because the generated pages rely on `:target` CSS that doesn't work in `srcdoc`. Local assets are rewritten to blob URLs first — in `src` and `href` attributes, **and in CSS `url()`**, both inline `style` attributes and `<style>` blocks. The CSS half is not an edge case: the birds root template gives each card its picture with `style="background-image: url('files/images/magpie.jpg')"`, which carries no `src` or `href`, so an attributes-only rewrite left every card blank. That failure is easy to miss because the written file, opened from disk, resolves those paths perfectly well — only the blob-served preview has no folder to resolve against. Links between pages of a multi-page site are defanged and intercepted: an injected script posts the target path back to the opener, which materialises that page on demand with the same rewriting. Pages can't be pre-rewritten in bulk because their links are mutually cyclic.

**Settings** — input mode, theme, folder mode, overwrite, local template upload, xlsx — persist to `localStorage` and are profile-independent. Build options don't persist; they reset from the profile on every run.

---

## 9. Testing

### 9.1 What is testable, and where the line falls

The isomorphic core — `crate.js`, `masp.js`, `default_profile.js`, and the plugin logic that doesn't touch the filesystem — runs unmodified under Node. That is the whole reason it's isomorphic, and it's what the suite exercises: real `ro-crate`, real `ro-crate-excel`, real `ro-crate-static-site`, real `ro-crate-masp`. **Nothing is mocked.** A test that passes against a stub of `ro-crate` would prove nothing about a tool whose entire job is driving `ro-crate` correctly.

Below the line sits everything requiring a browser: `main.js`, the File System Access wrappers, and the DOM. `showDirectoryPicker` needs a native dialog, so the wizard's click-through cannot be automated here. That's a real limit, not an oversight — the mitigation is keeping logic *out* of `main.js` and in modules that can be reached from Node, which is why plugins own their behaviour and `main.js` mostly assembles `ctx`.

### 9.2 Requirements

**A test must be able to fail.** This is the one non-negotiable. A script that catches an exception, logs it, and exits 0 is not a test — it is a demo that cannot report bad news. Every check goes through `node:assert/strict`; a `try`/`catch` around an operation under test is only acceptable if the catch re-throws or asserts.

**Every assertion carries a message stating the expected behaviour.** Not a restatement of the expression — the *rule* being enforced, in prose a reader can check against the spec. The message is the test's real documentation; the expression is just how it's checked.

**Tests read as scenarios.** Group assertions under a comment naming the situation, in the order the pipeline would encounter it. A reader should be able to follow what the tool is supposed to do without reconstructing it from expressions.

**Each seam gets a test that could plausibly break.** The architecture's seams are the natural units: core graph assembly, each plugin's hook behaviour, and the profile contract. Prefer one test per seam over one test per file.

**Success output says what was verified.** A bare "passed" tells you a file ran. `test-default-profile: all tests passed (schema.org (default), 5 Describe fields, 6 property groups)` tells you *what* held.

**Non-goal: a test framework.** Plain scripts plus `node:assert/strict` need no runner, no config, and no dependency, and they double as executable examples of the API. Adopting `node:test` would buy parallelism and reporting the suite is far too small to need. Revisit if the suite outgrows a handful of files.

### 9.3 The style, concretely

```js
/* ---------- collection mode nests child folders under the collection ---------- */

assert.deepEqual(
  subObj["pcdm:memberOf"],
  { "@id": top["@id"] },
  "Nested folder object should be linked back to top-level collection via pcdm:memberOf"
);
```

Versus the same check written unreadably — correct, and silent about intent:

```js
assert.deepEqual(subObj["pcdm:memberOf"], { "@id": top["@id"] });
```

When it fails, the first names the broken rule; the second makes you open the source and infer it.

Because a profile now supplies what `defaults.js` used to, each script defines a minimal inline `TEST_CONFIG` — root dataset, plus `fileProperties` and an explicit layout where relevant — standing in for a profile.

### 9.4 Coverage

Six suites, run by `npm test`. Every one exits non-zero when the behaviour it covers breaks.

| Seam | Test | State |
|---|---|---|
| Hook bus — order, priority, stable sort, sequential await, `ctx` isolation | `test-hooks.mjs` | ✅ |
| Registry — documented per-hook order, input dispatch, schema composition | `test-hooks.mjs` | ✅ |
| Graph assembly — object vs collection mode | `test-top-level-folders.mjs` | ✅ |
| Graph assembly — file entities, arcp id rewriting, profile-declared file properties | `test-crate.mjs` | ✅ |
| Duplicate detection | `test-crate.mjs` | ✅ |
| All three outputs generate from a built crate | `test-crate.mjs` | ✅ |
| Entity editing — set/delete property, add/rename/delete entity, reference cleanup | `test-edit-crate.mjs` | ✅ |
| Edited crate regenerates all three outputs | `test-edit-crate.mjs` | ✅ |
| Profile load, Describe derivation, validation | `test-default-profile.mjs` | ✅ |
| Default profile — overlay, minimality, layout resolution | `test-default-profile.mjs` | ✅ |
| Multipage templates — ref collection, upload/folder resolution, tail fallback, explicit failure | `test-page-templates.mjs` | ✅ |
| Preview asset URLs — path normalisation, attribute and CSS `url()` rewriting | `test-preview-assets.mjs` | ✅ |
| Spreadsheet crate — round trip, prefill source choice, seeding, entity merge, warnings | `test-xlsx-crate.mjs` | ✅ |
| Merge — typed `Place` → linked `Geometry` | `test-place-merge.mjs` | ✅ |
| Place lookup — manual records | `test-place-merge.mjs` | ✅ |
| Merge — untyped mappings, other entity types, workbook contexts, unmatched rows | — | ❌ |
| Place lookup — providers, name variants, region preference | — | ❌ |
| AUSTLANG handoff — id-keyed, survives reorder/filter/append; geometry; counting | `test-language-entities.mjs` | ✅ |
| AUSTLANG matching itself (the matcher and its data pack) | — | ❌ |
| DOCX parsing, media resolution, the business rules in §7.1 | — | ❌ |
| Output plugins — the overwrite gate itself | — | ⚠️ order only, via `test-hooks.mjs` |
| Browser layer — `main.js`, FSA, the wizard | — | out of scope (§9.1) |

`scripts/run-tests.mjs` discovers `test-*.mjs` rather than listing them, so a new suite is picked up without also being registered — the drift that previously left two suites unwired.

### 9.5 Remaining gaps

Four plugin seams have no coverage at all: **AUSTLANG matching**, **DOCX parsing and its business rules**, **place-lookup providers** (only the manual-records path is exercised), and **merge beyond the typed-`Place` case** — untyped mappings, other entity types, workbook context discovery, unmatched rows and files. Each is reachable from Node and none needs a filesystem except DOCX, which would need fixture `.docx` files.

The **output plugins' overwrite gate** is exercised only incidentally, as the mechanism that lets `test-hooks.mjs` run real handlers safely. Its skip-vs-write branch deserves a test of its own.

The **browser layer stays untestable here** (§9.1). The mitigation is architectural, not test-shaped: keep logic in modules Node can reach. The dead-button regression that shipped in `bb9aed1` — enabled buttons whose click handlers still returned early — is precisely the class of bug this leaves uncaught, and the argument for keeping `main.js` thin.

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
  preview_assets.js              path + url() rewriting for the blob-served preview

  plugins/
    hooks.js                     hook bus + the seven hook names + announceAndEmit
    pipeline.js                  mandatory steps + build-hook emission order
    index.js                     PLUGINS / INPUT_PLUGINS registries, schema composition

    generic-input/index.js       input plugin — folder scan
    docx-input/index.js          input plugin — docx corpus
    xlsx-crate-input/index.js    folder:picked + config:prepare + crate:built — spreadsheet as crate
    xlsx-crate-input/xlsx_crate.js  reading, seeding, merging, membership, warnings
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

test-hooks.mjs             test-crate.mjs          test-edit-crate.mjs
test-default-profile.mjs   test-place-merge.mjs    test-top-level-folders.mjs

scripts/run-tests.mjs              discovers and runs every test-*.mjs (npm test)
scripts/update-austlang-data.mjs
vite.config.js

docs/
  docx-authoring.md            author-facing .docx conventions for docx-input (§7.1) — not this file's audience
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
