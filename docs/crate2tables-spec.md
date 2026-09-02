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
2. `crate2tables-config.json` already in the picked folder (e.g. hand-edited from a previous build's output)
3. `roctable`'s own `defaultConfig()` (empty `tables`, empty `potential_tables`) if neither exists yet

## Output contract

```js
outputPaths: [
  { path: "crate2tables-config.json", kind: "file" },
  { path: "crate2tables-output", kind: "dir" },
]
```

`crate2tables-config.json` sits at the folder root, next to
`ro-crate-metadata.json`, so it's visible and editable the same way. CSVs go
in `crate2tables-output/<Type>.csv`, one file per configured table, so they
don't collide with `merge`'s spreadsheet input or the crate's own metadata
files.

## UI and user flow

### Phase 1 — this implementation

- Build option: **"Export RO-Crate tables"** (`enableCrate2Tables`)
- Suboption: upload a table config JSON, to override the folder's own
- No in-app editor for the config yet — a person edits
  `crate2tables-config.json` directly (a text file, or in a spreadsheet tool
  after opening it as JSON — most people will just use an editor) between
  builds. First build against a fresh folder produces no CSV, only a
  freshly-discovered config to start editing.

This matches what the user asked to ship now: the plugin framework and the
config-file-driven mechanism, with the interactive picker explicitly a
later addition (§6.2) once its own UI shape is settled.

### Phase 2 — planned, not built here

An in-app config editor, replacing "open the JSON in a text editor" with a
guided flow inside the Build panel:

1. **Type picker** — list every `@type` under `potential_tables` (with a
   count of matching entities) plus every type already under `tables`, let
   the user tick which ones become tables.
2. **Field picker per type** — for a ticked type, list its discovered
   properties; tick which become columns (`include`), optionally rename,
   optionally mark `expand` (with the same picker recursing one level into
   the expanded properties) or `load_text`.
3. Write the result back into the same `tables`/`potential_tables` config
   shape `roctable` already reads — the UI is a front end for the existing
   config file, not a second source of truth.

There is no generic mechanism today for a plugin to register an arbitrary
custom form widget — `main.js` special-cases known `optionSchema.children[].type`
values (`file`, `mappingBuilder`, …), the closest precedent being `merge`'s
`mappingBuilder` (`c2c-plugins/src/merge/index.js:28`), which opens a
purpose-built modal via the shared `openModal` helper
(`chaos2crate/src/plugins/deps.js:33`) rather than a declarative field type.
A `crate2tables` picker would most likely follow that same pattern: a new
`type: "tableSelector"` (or similar) recognised by `main.js`, opening a modal
built the same "no host markup" way, reading `ctx.crate`'s discovered types
— which means Phase 2 needs a small `main.js`-side change alongside the
plugin, the same trade-off `merge`'s mapping builder already accepted.

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
4. A build against a folder with no existing config produces
   `crate2tables-config.json` (fully discovered, nothing selected) and no
   CSVs, with a log message explaining why.
5. A build against a folder with a config that has at least one type under
   `tables` with at least one `include: true` property produces one CSV per
   such type in `crate2tables-output/`.
6. `outputPaths` declares both, so they're excluded from folder re-scans and
   covered by "delete plugin output before rebuild".
7. `load_text`, if present in a config, reads through the plugin's injected
   browser `fileReader` (§"load_text" above) rather than crashing or being
   silently disabled.
8. Toggled off, the plugin does nothing — no config write, no CSVs, no
   crate mutation.

## Implementation status

Phase 1 (this document's §5, `PLUGINS=crate2tables`, including working
`load_text`) is implemented in `c2c-plugins/src/crate2tables/index.js`,
registered in `c2c-plugins/index.js`, with the dependency table entry in
`c2c-plugins/README.md`. Verified with a real local `roctable` checkout
(`ptsefton/roctable#1`'s `feature/injectable-file-reader` branch), a
`PLUGINS=crate2tables npm run build` and a `PLUGINS=all npm run build` in
this repo, and an end-to-end run of both hooks against an in-memory crate
with a real `load_text` property.

Phase 2 (§6.2 — the in-app type/field/expand/load_text picker) is not
started. It needs a `main.js`-side UI addition (a new `optionSchema.children[].type`,
following `merge`'s `mappingBuilder` precedent) before it can be built as a
plugin-only change.
