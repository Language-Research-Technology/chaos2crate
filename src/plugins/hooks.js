// Named hook registry + shared mutable context object — the extension
// mechanism build plugins tap into. Not a literal WordPress-hooks port: one
// registration primitive (on) and one invocation primitive (emit), no
// separate action/filter APIs — a handler that only reads `ctx` behaves like
// a WP action, one that writes back to `ctx` behaves like a WP filter, both
// are just functions. Closer to Rollup/webpack's named lifecycle hooks
// crossed with Koa/Express middleware's single mutable `ctx` object.

export const HOOKS = {
  CONFIG_PREPARE: "config:prepare", // ctx.config is mutable before crate build
  FILES_ANALYZE: "files:analyze",   // ctx.filesWithMeta available (generic mode only)
  CRATE_BUILT: "crate:built",       // ctx.crate exists; mutate/enrich it here
  CRATE_VALIDATE: "crate:validate", // ctx.crate is final; report on it, don't mutate
  OUTPUT_WRITE: "output:write",     // write files via ctx.dirHandle
};

export function createHookBus() {
  const registry = new Map(); // hookName -> [{ handler, priority }]
  return {
    on(hookName, handler, { priority = 10 } = {}) {
      if (!registry.has(hookName)) registry.set(hookName, []);
      registry.get(hookName).push({ handler, priority });
      registry.get(hookName).sort((a, b) => a.priority - b.priority);
    },
    async emit(hookName, ctx) {
      for (const { handler } of registry.get(hookName) || []) await handler(ctx);
    },
  };
}
