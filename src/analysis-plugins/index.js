// Registry of analysis plugins shown on the Visualisation page's left-hand
// sidebar. Unlike the build plugins in c2c-plugins (codegen'd via
// scripts/select-plugins.mjs for tree-shaking), analysis plugins are few
// enough to list by hand: each is `{ id, name, description, render(container, ctx) }`,
// called with a DOM element to render into and `{ documents }` — the flat
// list of parsed text loaded by src/analysis-plugins/data-source.js.
import { concordancePlugin } from "./concordance.js";
import { ngramsPlugin } from "./ngrams.js";

export const ANALYSIS_PLUGINS = [concordancePlugin, ngramsPlugin];
