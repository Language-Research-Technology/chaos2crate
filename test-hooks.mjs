// The hook bus and the plugin registry — the contract every build depends on
// and nothing else covers. ARCHITECTURE §4.5 promises that array order in
// PLUGINS *is* hook-execution order, resting on a stable sort over a uniform
// default priority. A silent reordering would change what every build does
// (AUSTLANG must enrich before merge reads the graph; JSON must be written
// before HTML reads the finished crate), so the promise is asserted here.
import assert from "node:assert/strict";

import { HOOKS, createHookBus } from "./src/plugins/hooks.js";
import { PLUGINS, INPUT_PLUGINS, registerAllPlugins, composeOptionSchema, composeSettingsSchema } from "./src/plugins/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------- handlers run in registration order within a hook ---------- */

{
  const bus = createHookBus();
  const ran = [];
  bus.on(HOOKS.CRATE_BUILT, () => { ran.push("first"); });
  bus.on(HOOKS.CRATE_BUILT, () => { ran.push("second"); });
  bus.on(HOOKS.CRATE_BUILT, () => { ran.push("third"); });
  await bus.emit(HOOKS.CRATE_BUILT, {});

  assert.deepEqual(
    ran,
    ["first", "second", "third"],
    "handlers sharing a hook should run in the order they were registered"
  );
}

/* ---------- an explicit priority overrides registration order ---------- */

{
  const bus = createHookBus();
  const ran = [];
  bus.on(HOOKS.OUTPUT_WRITE, () => { ran.push("default-priority"); });
  bus.on(HOOKS.OUTPUT_WRITE, () => { ran.push("runs-first"); }, { priority: 1 });
  bus.on(HOOKS.OUTPUT_WRITE, () => { ran.push("runs-last"); }, { priority: 99 });
  await bus.emit(HOOKS.OUTPUT_WRITE, {});

  assert.deepEqual(
    ran,
    ["runs-first", "default-priority", "runs-last"],
    "a lower priority number should run earlier, regardless of when it was registered"
  );
}

/* ---------- equal priorities keep registration order (stable sort) ---------- */

{
  const bus = createHookBus();
  const ran = [];
  for (const name of ["a", "b", "c", "d", "e"]) bus.on(HOOKS.CRATE_BUILT, () => { ran.push(name); }, { priority: 10 });
  await bus.emit(HOOKS.CRATE_BUILT, {});

  assert.deepEqual(
    ran,
    ["a", "b", "c", "d", "e"],
    "handlers with equal priority must keep registration order — the whole registry relies on this sort being stable"
  );
}

/* ---------- handlers are awaited one at a time, not raced ---------- */

{
  const bus = createHookBus();
  const ran = [];
  // The slow handler is registered first: if emit() raced them, the fast one
  // would finish first and the order would invert.
  bus.on(HOOKS.CRATE_BUILT, async (ctx) => {
    await tick();
    ran.push("slow");
    ctx.seenBySlow = true;
  });
  bus.on(HOOKS.CRATE_BUILT, (ctx) => {
    ran.push("fast");
    ctx.slowRanFirst = ctx.seenBySlow === true;
  });

  const ctx = {};
  await bus.emit(HOOKS.CRATE_BUILT, ctx);

  assert.deepEqual(ran, ["slow", "fast"], "an async handler should be awaited before the next one starts");
  assert.equal(
    ctx.slowRanFirst,
    true,
    "a later handler should observe mutations an earlier one made to ctx — plugins enrich the same crate in turn"
  );
}

/* ---------- the shared ctx is the only state; the bus holds none ---------- */

{
  const bus = createHookBus();
  bus.on(HOOKS.CONFIG_PREPARE, (ctx) => { ctx.count = (ctx.count || 0) + 1; });

  const first = {};
  const second = {};
  await bus.emit(HOOKS.CONFIG_PREPARE, first);
  await bus.emit(HOOKS.CONFIG_PREPARE, second);

  assert.equal(first.count, 1, "the first build's ctx should see exactly one run of the handler");
  assert.equal(
    second.count,
    1,
    "a second build should start clean — per-build state lives in ctx, never in the bus or its handlers"
  );
}

/* ---------- emitting a hook nobody registered for is a no-op ---------- */

{
  const bus = createHookBus();
  await assert.doesNotReject(
    () => bus.emit(HOOKS.FILES_ANALYZE, {}),
    "emitting a hook with no registered handlers should do nothing, not throw — docx builds never fire files:analyze"
  );
}

/* ---------- the real registry produces the documented order ---------- */

const pluginsTapping = (hook) => PLUGINS.filter((p) => p.hooks && p.hooks[hook]).map((p) => p.name);

assert.deepEqual(
  pluginsTapping(HOOKS.CRATE_BUILT),
  ["austlang", "merge"],
  "AUSTLANG must enrich the crate before merge runs — merge reads entities AUSTLANG may have added"
);
assert.deepEqual(
  pluginsTapping(HOOKS.OUTPUT_WRITE),
  ["ro-crate-json-output", "ro-crate-xlsx-output", "ro-crate-html-output"],
  "outputs must be written JSON, then xlsx, then HTML"
);
assert.deepEqual(
  pluginsTapping(HOOKS.CRATE_VALIDATE),
  ["validate-crate"],
  "validation should be the only thing tapping crate:validate — that stage reports, it doesn't mutate"
);

assert.ok(
  PLUGINS.every((p) => Object.values(p.hooks || {}).every((h) => typeof h === "function")),
  "every registered hook handler should be a function"
);

/* ---------- registering the real plugins preserves that order on the bus ---------- */

{
  const bus = createHookBus();
  registerAllPlugins(bus);
  const ran = [];
  const logged = [];
  // A ctx every real output handler declines: overwrite off against a folder
  // where the file already exists (so JSON skips), and both optional outputs
  // switched off. That exercises the real handlers in their real order
  // without needing a crate or a filesystem.
  const ctx = {
    options: { overwrite: false, makeXlsx: false, makeHtml: false },
    dirHandle: { getFileHandle: async () => ({}) },
    log: (msg) => { logged.push(msg); },
  };
  bus.on(HOOKS.OUTPUT_WRITE, () => { ran.push("appended-last"); });
  await bus.emit(HOOKS.OUTPUT_WRITE, ctx);

  assert.deepEqual(
    ran,
    ["appended-last"],
    "a handler registered after the real plugins should run last, since all share the default priority"
  );
  assert.ok(
    logged.some((m) => m.includes("ro-crate-metadata.json") && m.includes("skipped")),
    "the always-on JSON plugin should have run and declined to overwrite — proving real handlers execute, not just register"
  );
}

/* ---------- input plugins are a separate, mutually exclusive registry ---------- */

assert.deepEqual(
  Object.keys(INPUT_PLUGINS).sort(),
  ["docx", "generic"],
  "input plugins should be keyed by the inputMode that selects them"
);
for (const [mode, plugin] of Object.entries(INPUT_PLUGINS)) {
  assert.equal(plugin.inputMode, mode, `input plugin "${plugin.name}" should be registered under its own inputMode`);
  assert.equal(typeof plugin.buildCrate, "function", `input plugin "${plugin.name}" should expose buildCrate()`);
  assert.ok(
    !PLUGINS.includes(plugin),
    `input plugin "${plugin.name}" should stay out of PLUGINS — exactly one runs per build, they aren't additive taps`
  );
}

/* ---------- the UI schemas are composed from whichever plugins declare them ---------- */

const optionKeys = composeOptionSchema().map((s) => s.key);
const settingsKeys = composeSettingsSchema().map((s) => s.key);

assert.deepEqual(
  optionKeys,
  PLUGINS.filter((p) => p.optionSchema).map((p) => p.optionSchema.key),
  "the Build panel should be composed from exactly the plugins declaring an optionSchema, in registry order"
);
assert.deepEqual(
  settingsKeys,
  PLUGINS.filter((p) => p.settingsSchema).map((p) => p.settingsSchema.key),
  "the Settings modal should be composed from exactly the plugins declaring a settingsSchema"
);
assert.ok(
  !optionKeys.includes("makeXlsx") && settingsKeys.includes("makeXlsx"),
  "xlsx output belongs in Settings, not Build options — it's a machine preference, not a per-build choice"
);
assert.ok(
  PLUGINS.filter((p) => !p.optionSchema && !p.settingsSchema).map((p) => p.name).includes("ro-crate-json-output"),
  "JSON output should declare no schema at all — that absence is how an always-on plugin is expressed"
);

console.log(`test-hooks: all tests passed (${Object.keys(HOOKS).length} hooks, ${PLUGINS.length} plugins, ${Object.keys(INPUT_PLUGINS).length} input modes)`);
