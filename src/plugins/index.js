// Plugin registry. Order here doubles as hook-execution order for plugins
// sharing a hook stage (createHookBus's priority defaults to 10 for every
// registration, and Array#sort is stable, so registering in this order is
// enough to reproduce the original processFolder sequence — no explicit
// priority numbers needed): language identification before merge (both tap
// crate:built), then JSON before XLSX before HTML (all tap output:write).
import { plugin as austlangPlugin } from "./austlang/index.js";
import { plugin as mergePlugin } from "./merge/index.js";
import { plugin as validateCratePlugin } from "./validate-crate/index.js";
import { plugin as jsonOutputPlugin } from "./ro-crate-json-output/index.js";
import { plugin as xlsxOutputPlugin } from "./ro-crate-xlsx-output/index.js";
import { plugin as htmlOutputPlugin } from "./ro-crate-html-output/index.js";

export const PLUGINS = [
  austlangPlugin,
  mergePlugin,
  validateCratePlugin,
  jsonOutputPlugin,
  xlsxOutputPlugin,
  htmlOutputPlugin,
];

export function registerAllPlugins(hookBus, plugins = PLUGINS) {
  for (const plugin of plugins) {
    for (const [hookName, handler] of Object.entries(plugin.hooks || {})) {
      hookBus.on(hookName, handler);
    }
  }
}

export function composeOptionSchema(plugins = PLUGINS) {
  return plugins.map((p) => p.optionSchema).filter(Boolean);
}

export function composeSettingsSchema(plugins = PLUGINS) {
  return plugins.map((p) => p.settingsSchema).filter(Boolean);
}
