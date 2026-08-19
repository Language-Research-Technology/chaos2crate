// Named hook registry + shared mutable context object — the extension
// mechanism build plugins tap into. Not a literal WordPress-hooks port: one
// registration primitive (on) and one invocation primitive (emit), no
// separate action/filter APIs — a handler that only reads `ctx` behaves like
// a WP action, one that writes back to `ctx` behaves like a WP filter, both
// are just functions. Closer to Rollup/webpack's named lifecycle hooks
// crossed with Koa/Express middleware's single mutable `ctx` object.

export const HOOKS = {
  FOLDER_PICKED: "folder:picked",   // a folder was just chosen; ctx.crateJson/crateSourceLabel are mutable
  PROFILE_SELECTED: "profile:selected", // ctx.profileId/profileData describe the chosen profile
  CONFIG_PREPARE: "config:prepare", // ctx.config is mutable before crate build
  FILES_ANALYZE: "files:analyze",   // ctx.filesWithMeta available (generic mode only)
  CRATE_BUILT: "crate:built",       // ctx.crate exists; mutate/enrich it here
  CRATE_VALIDATE: "crate:validate", // ctx.crate is final; report on it, don't mutate
  OUTPUT_WRITE: "output:write",     // write files via ctx.dirHandle
};

export function createHookBus() {
  const registry = new Map(); // hookName -> [{ handler, priority, pluginName }]
  return {
    on(hookName, handler, { priority = 10, pluginName } = {}) {
      if (!registry.has(hookName)) registry.set(hookName, []);
      registry.get(hookName).push({ handler, priority, pluginName });
      registry.get(hookName).sort((a, b) => a.priority - b.priority);
    },
    async emit(hookName, ctx) {
      for (const { handler } of registry.get(hookName) || []) await handler(ctx);
    },
    // Names of the plugins tapping a hook, in the order they'll run — lets
    // callers log which plugins are about to fire for a stage without every
    // plugin having to announce itself individually.
    pluginNamesFor(hookName) {
      return (registry.get(hookName) || []).map((r) => r.pluginName).filter(Boolean);
    },
  };
}

// Announces a hook stage before firing it — which plugins are tapping it, in
// run order, or that none are — via ctx.log, so a caller's log traces the
// pipeline's actual shape instead of only whatever each plugin chooses to
// self-report. Always logs, even for a stage nothing taps: that's still
// confirmation the hook point itself exists and fired, which matters most
// for a hook like profile:selected that's a pure extension point today.
// Shared by the build pipeline (src/plugins/pipeline.js) and main.js's
// folder-pick/profile-select steps, so both trace hooks the same way.
export async function announceAndEmit(hookBus, hookName, ctx) {
  const names = hookBus.pluginNamesFor(hookName);
  ctx.log(`→ ${hookName}: ${names.length ? names.join(", ") : "(no plugins tap this)"}.`, "muted");
  await hookBus.emit(hookName, ctx);
}
