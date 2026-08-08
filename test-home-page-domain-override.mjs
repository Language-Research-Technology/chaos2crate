// The Build panel's "Home page" and "Site domain" fields override whatever
// homePageId/domain a template's own config.json shipped, since those are
// almost always a placeholder or another project's value (see
// benfoley/rocss-template-repo#3, where a shipped homePageId from one crate
// silently produced a blank home page for every other crate built with the
// same template). Left blank, the template's own config wins unchanged, so a
// template with sensible values of its own still works untouched.
import assert from "node:assert/strict";
import { applyHomePageAndDomainOverrides } from "./src/plugins/ro-crate-html-output/index.js";

const TEMPLATE_CFG = {
  multipage: true,
  homePageId: "#AnmWeb1_HOME",
  domain: "http://example.com",
  root: { template: "templates/root-template.html" },
};

assert.deepEqual(
  applyHomePageAndDomainOverrides(TEMPLATE_CFG, { homePageId: "#MyCollection", domain: "https://example.org/my-site" }),
  { ...TEMPLATE_CFG, homePageId: "#MyCollection", domain: "https://example.org/my-site" },
  "both fields set overrides both"
);

assert.deepEqual(
  applyHomePageAndDomainOverrides(TEMPLATE_CFG, { homePageId: "#MyCollection", domain: "" }),
  { ...TEMPLATE_CFG, homePageId: "#MyCollection" },
  "one field blank leaves the template's own value for that field alone"
);

assert.deepEqual(
  applyHomePageAndDomainOverrides(TEMPLATE_CFG, { homePageId: "", domain: "" }),
  TEMPLATE_CFG,
  "both fields blank leaves the template's config untouched"
);

assert.deepEqual(
  applyHomePageAndDomainOverrides(TEMPLATE_CFG, {}),
  TEMPLATE_CFG,
  "options missing the keys entirely behaves the same as blank"
);

assert.equal(
  applyHomePageAndDomainOverrides(null, { homePageId: "#X", domain: "https://x.example" }),
  null,
  "no base config (no template resolved) stays null rather than being invented"
);

{
  // The override must not mutate the caller's config object — effectiveCfg
  // downstream is reused across multipage rendering and the "Show" cache.
  const original = { ...TEMPLATE_CFG };
  applyHomePageAndDomainOverrides(TEMPLATE_CFG, { homePageId: "#Other" });
  assert.deepEqual(TEMPLATE_CFG, original, "the input config object is not mutated");
}

console.log("test-home-page-domain-override: all tests passed (5 override cases, null-config and no-mutation guards)");
