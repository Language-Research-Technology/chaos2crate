# crate2tables plugin spec

## Purpose

An optional build plugin that exports a completed RO-Crate as one CSV per
entity type, using [`roctable`](https://github.com/ptsefton/roctable) —
Peter Sefton's WIP library for converting between RO-Crate and tabular
formats. A user picks which entity types they want as tables, which
properties on each, whether a reference property should be expanded into
extra columns or kept as a plain reference, and whether a property pointing
at a text file should have that file's contents pulled into the row (via an
injected file reader — see §"load_text" below, not roctable's own Node `fs`
default). Output lands back in the picked folder alongside the crate's
other build outputs.

This supersedes the earlier sketch at `docs/roctable-export-spec.md` (which
used the working name `roctable-export`): same idea, same library, but
built out with the actual config schema `roctable` ships (§3), a name that
matches what it does rather than the library it happens to use, and an
explicit two-phase plan (§6) for the selection UI, which the original sketch
left as an unspecified "optional suboptions" list.

## Placement in the repo

Same reasoning as every other build-time plugin (`SPEC.md` §4.7, §4.7a):

- lives in the sibling `c2c-plugins` checkout, at
  `c2c-plugins/src/crate2tables/index.js`
- registered in that repo's `REGISTRY`, selected via the normal `PLUGINS`
  env var (`PLUGINS=crate2tables` or the default `all`)
- not under `src/analysis-plugins/` — that's the Visualisation page's
  sidebar, a different lifecycle entirely from the crate build pipeline

## Hook and lifecycle behaviour

Additive build plugin, two taps:

| Hook | Does |
|---|---|
| `crate:built` | inspect the built crate, merge that against the existing/uploaded config, extract table data |
| `output:write` | write the (possibly just-updated) config and the extracted CSVs into the folder |

`crate:built` is the earliest point `ctx.crate` — the final graph, including
whatever `merge`/`austlang`/`xlsx-crate-input` added — exists; `output:write`
is where every other output plugin (`ro-crate-json-output`,
`ro-crate-xlsx-output`, `ro-crate-html-output`) persists into `ctx.dirHandle`,
so this does the same.

## Why `ctx.crate` can be handed to `roctable` directly

Both repos depend on the same version of the `ro-crate` package
(`^3.7.2` in both `chaos2crate/package.json` and `c2c-plugins/package.json`,
the latter pulled in transitively by `roctable` itself). `ctx.crate` is a
real `ROCrate` instance (`chaos2crate/src/crate.js:286`,
`new ROCrate({ array: true, link: true })`), with the same `.entities()` /
`.getEntity()` methods `roctable`'s own crate-walking code calls. So the
plugin reuses `roctable/lib/inspect.js` and `roctable/lib/extract.js`'s pure
functions unmodified, rather than re-implementing crate flattening.

## The actual config schema (verified against `roctable`'s source)

`roctable`'s own CLI is two commands:

```
npx roctable inspect <crate-dir> -c <config.json>   # discover types/properties
npx roctable csv <crate-dir> -c <config.json> -o <dir>  # extract + write CSV
```

`inspect` walks the crate and produces:

```jsonc
{
  "defaults": { "max_repeat": 10 },
  "tables": {},
  "potential_tables": {
    "Person": { "properties": { "name": { "include": false }, "email": { "include": false } } },
    "File":   { "properties": { "name": { "include": false }, "contentSize": { "include": false } } }
  }
}
```

Every `@type` the crate contains shows up under `potential_tables`, every
property on an entity of that type gets `{ "include": false }`. Nothing is
exported until a type is **moved** into `tables` with at least one property
set to `"include": true`:

```jsonc
{
  "tables": {
    "Person": {
      "properties": {
        "name": { "include": true },
        "email": { "include": true, "rename": "contact_email" },
        "affiliation": { "include": true, "expand": true,
          "properties": { "name": { "include": true }, "url": { "include": false } } }
      }
    }
  },
  "potential_tables": { "File": { "properties": { "name": { "include": false } } } }
}
```

Per-property options, straight from `roctable/lib/extract.js` and its
`README.md`/`SPEC.md`:

| Option | Effect |
|---|---|
| `include` | whether the property becomes a column at all |
| `rename` | output column name, if not the property name |
| `expand` | dereference a reference property (one hop) and flatten the target entity's own properties in as `prop_subprop` columns instead of a plain reference |
| `load_text` | read the file a property points at and put its contents in the cell, instead of the reference itself |
| `load_text` + `join: "csv"` | when the loaded file is itself a CSV (e.g. a transcript), explode the one row into one row per line of that CSV, repeating the parent's own columns and adding `_concat_<header>` columns |

Re-running `inspect` against an edited config is non-destructive:
`mergeDiscovered` only ever adds newly-seen types/properties (unselected);
it never touches an existing `include`/`expand`/`rename`/`load_text` choice.
`discoverExpandedProperties` does the equivalent for a property that already
has `expand: true` — it walks the crate for that reference's target
entities and lists their properties, defaulted to `include: true` this time
(since the user already opted into expanding, they're pruning rather than
selecting).

This plugin runs both steps on every build instead of requiring a separate
CLI pass outside the browser tool: `crate:built` always re-runs the
discovery against the current crate (picking up new types/properties as
content changes) and writes the merged config back in `output:write`; if
the merged config's `tables` section is empty, nothing is exported yet — see
§5.

## Config resolution

Same precedence pattern as `merge` (`c2c-plugins/src/merge/index.js`):

1. an uploaded config, via the option's file picker (`crate2tablesConfigUpload`) — overrides everything
2. `_config/roctable/config.json` already in the picked folder (e.g. from a previous build, or hand-edited)
3. `roctable`'s own `defaultConfig()` (empty `tables`, empty `potential_tables`) if neither exists yet

## Output contract

```js
outputPaths: [
  { path: "_config/roctable", kind: "dir" },
  { path: "_outputs/roctable", kind: "dir" },
]
```

Both paths follow chaos2crate issue #81's proposed per-plugin directory
convention (`_config/<slug>/` for standing configuration, `_outputs/<slug>/`
for disposable generated content), adopted here ahead of it becoming a
repo-wide standard — `roctable` rather than `crate2tables` as the slug,
matching the issue's own example. `_config/roctable/config.json` is what
`Config resolution` above reads/writes; CSVs go in
`_outputs/roctable/<Type>.csv`, one file per configured table.

**`_config/` and `_backup/` are excluded from "Delete plugin output before
rebuilding."** `deletePluginOutputs()` (`chaos2crate/src/main.js`) skips any
declared path whose top-level segment is `_config` or `_backup`, regardless
of which plugin declared it — both are meant to persist across builds
(standing configuration, changed-file backups), unlike `_outputs/`, which is
exactly the disposable generated content that setting exists to clear. This
generalises the same reasoning §6.1a already established for
`ro-crate-metadata.json` itself.

## UI and user flow

- Build option: **"Export RO-Crate tables"** (`enableCrate2Tables`)
- Two children: **"Configure tables…"** (an action button, see below) and
  the table-config-JSON upload override.

**First build against a folder with no config at all** (nothing at
`_config/roctable/config.json`, nothing uploaded): the build blocks on the
same tree editor described next, pre-populated from a fresh discovery pass
(every `@type` present, nothing selected, except whatever the `ldac:mainText`
default below already turned on). Confirming writes the config and the same
build continues straight into extracting and writing CSVs from that
selection — not a "seed now, rebuild later" two-step, the way Phase 1
originally worked. Dismissing the editor (rather than confirming a
selection, even an empty one) cancels the whole build.

**Every later build** just uses whatever's at `_config/roctable/config.json`
directly — no prompt. **"Configure tables…"** reopens the same editor
on demand, independent of a build: it reads `ro-crate-metadata.json` from
the folder directly (via `loadCrateFromJson`, no `ctx.crate` needed — there's
no build in progress), runs the same discovery pass, and on Save writes
`_config/roctable/config.json` without extracting or writing any CSVs — the
next real build does that. If the folder has no crate yet, it warns and does
nothing ("build once first, then configure tables").

**The tree itself** (`c2c-plugins/src/crate2tables/config-tree-ui.js`): one
heading per discovered `@type`, a checkbox selecting it as a table (moving
it between the config's `tables`/`potential_tables`, live) and a disclosure
toggle unrolling its properties. Each property row is `include` / `expand` /
`load_text` / a `join` select (enabled only once `load_text` is checked). An
expanded property unrolls further to its own one-hop sub-properties
(`discoverExpandedProperties`'s nested `properties` map) — before that map
exists (a type checked `expand` for the first time, not yet round-tripped
through a discovery pass), it shows a hint instead of an empty list, since
`roctable` only populates that map from an actual crate inspection.
Cancel/dismiss resolve `null`; Save resolves the edited config as-is —
neither the tree UI nor `index.js` re-derives it from DOM state, the
checkboxes mutate a working copy of the config directly.

**`ldac:mainText` defaults to loaded, falling back to `indexableText`.**
`discover.js`'s `discoverConfig()` — the one function both the build-time
hook and "Configure tables…" call — seeds `{ include: true, load_text: true
}` on whichever of `ldac:mainText`/`mainText` (checked first) or
`ldac:indexableText`/`indexableText` (checked only if neither mainText form
is present) a type actually has, so the tree opens with a sensible default
already applied rather than every property starting unselected. This is
strictly a *first-sight* default: it checks whether that exact property was
already present in the config that existed *before* this call — not whether
it currently looks like `{include:false}`, since a person deliberately
declining it is byte-for-byte the same shape as a genuinely fresh one. Once
a property has been through one round-trip (built into a config, however
that build resolved it), it's "known" and never touched by this rule again.

**Why this is a nested `type: "action"` child, not a new top-level tile.**
Each plugin contributes exactly one `optionSchema` entry
(`composeOptionSchema()`, `src/plugins/index.js`), so "Configure tables…"
has to live *inside* the `enableCrate2Tables` group, not beside it. The
existing top-level `kind: "action"` tile (`renderOptionGroupTiles`,
`main.js`) only covered that top-level case; `renderOptions` (the nested-child
renderer) gained the equivalent as `type: "action"` — `buildActionField`,
a plain button calling `opt.run({ dirHandle, log })`, the same contract as
the top-level version. A generic addition, not a `crate2tables`-specific
hardcoding like `mappingBuilder`'s (`c2c-plugins/src/merge/index.js:28`) —
any future plugin needing an on-demand action nested under its own toggle
can use it the same way.

## `load_text` — how it works in the browser build

`roctable/lib/extract.js`'s `loadText()` no longer calls `fs` directly:
`extractTables(crate, config, { fileReader })` takes an optional
`fileReader: { readFile(relPath) }` (ptsefton/roctable#1). `bin/roctable.js`
(the CLI) doesn't pass one, so `extractTables` falls back to
`lib/io.js`'s `nodeFileReader(crateDir)` — the original `fs`-based
behaviour, now just the default rather than the only option.

This plugin passes its own `browserFileReader(dirHandle)`
(`src/crate2tables/index.js`), wrapping chaos2crate's
`readFileTextFromDirectory` (`fs_helpers.js`) — which already returns `null`
for "not found", exactly what `loadText` expects from a reader. Because
`readFile` may be an async File System Access call, `extractTables` (and
`loadText`) are `async`; this plugin already awaits it.

Net effect: a config with `"load_text": true` on a property works the same
in chaos2crate as it does from roctable's own CLI — the file is read
relative to the crate root either way, just through a different reader.

## Known limitations

- **CSV only.** `roctable`'s own roadmap includes Excel, Parquet, and
  SQLite output (see its README's second diagram); this plugin exports CSV
  only, matching `roctable`'s current actual capability (`lib/csv.js`) —
  nothing to add here until the library does.
- **No relationship/edge table.** The original sketch (§"Purpose") floated
  an optional relationship table; `roctable`'s config format has no such
  table type today — every table is one entity type. Cross-references show
  up as `_id` columns on the referencing type's own table
  (`roctable/lib/csv.js`'s `buildColumns`), not as a separate table.

## Acceptance criteria

1. Implemented as a build plugin in `c2c-plugins`, tapping `crate:built` and
   `output:write` — not an analysis-page plugin.
2. Selectable through `PLUGINS`, off unless `enableCrate2Tables` is set.
3. `roctable` installed as a dependency not yet on npm — a git dependency
   pinned to a commit (`"roctable": "github:ptsefton/roctable#<sha>"`) now
   that ptsefton/roctable#2 (the injectable file reader) has merged. Bump
   the pin deliberately when picking up a newer commit; don't drop it to an
   unpinned `github:ptsefton/roctable`.
4. A build against a folder with no existing config blocks on the tree
   editor; confirming a selection (even an empty one) writes
   `_config/roctable/config.json` and, if anything was selected, that same
   build produces `_outputs/roctable/<Type>.csv` per selected type.
   Dismissing the editor without confirming cancels the build.
5. A build against a folder with an existing config uses it directly — no
   editor, no prompt — and produces one CSV per selected type as above.
6. `outputPaths` declares `_config/roctable` and `_outputs/roctable`, so
   both are excluded from folder re-scans; only `_outputs/roctable` is
   subject to "delete plugin output before rebuild" (`_config/` is skipped
   — see "Output contract" above).
7. `load_text`, if present in a config, reads through the plugin's injected
   browser `fileReader` (§"load_text" above) rather than crashing or being
   silently disabled.
8. `ldac:mainText` (falling back to `indexableText`) defaults to
   `include: true, load_text: true` the first time a type carrying it is
   discovered, and is never re-touched once that property has been through
   one config round-trip.
9. "Configure tables…" edits the config without requiring a build — reading
   the folder's existing crate directly — and warns instead of erroring if
   no crate exists yet.
10. Toggled off, the plugin does nothing — no config write, no CSVs, no
    crate mutation, and the "Configure tables…" button itself is invisible
    (still gated the same as the main toggle).

## Implementation status

Fully implemented in `c2c-plugins/src/crate2tables/` (`index.js`,
`discover.js`, `config-tree-ui.js`), registered in `c2c-plugins/index.js`,
with the dependency table entry and file-split note in
`c2c-plugins/README.md`. The one core-side change this needed —
`renderOptions`'s nested `type: "action"` support, plus `loadCrateFromJson`
added to `buildDeps()` — lives in this repo (`src/main.js`,
`src/plugins/deps.js`).

Verified: `discoverConfig`'s `ldac:mainText`/`indexableText` seeding against
synthetic crates covering all four cases (present fresh, absent-with-fallback,
already-declined, already-customised); the tree UI's full interaction surface
(type selection moving between `tables`/`potential_tables`, property
include/expand/load_text/join, sub-property rendering, Cancel/dismiss/Save)
against a minimal fake DOM; the whole plugin end-to-end — forced-modal
cancellation, confirmed selection through to written CSV, a second build
skipping the modal, and the standalone "Configure tables…" action both with
and without an existing crate — against a real 764-entity F2F collection,
confirming `ldac:mainText` seeds correctly on real `RepositoryObject` data
and the resulting CSV contains genuinely loaded transcript text. Also
`npm test` (only the 3 pre-existing, unrelated failures) and `npm run build`
(single-plugin and all-plugins) in this repo.
