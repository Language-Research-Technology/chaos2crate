import assert from "node:assert/strict";

import {
  readExplicitProfileIdFromQuery,
  matchForcedProfileIdFromQuery,
  collectOptionSubtreeKeys,
} from "../src/profile_url_override.js";

const PROFILE_IDS = ["birds", "language-resources", "structured-docs"];

assert.equal(
  readExplicitProfileIdFromQuery("?profile=birds"),
  "birds",
  "profile=<id> should be read as an explicit forced-profile request"
);

assert.equal(
  readExplicitProfileIdFromQuery("?PROFILE=structured-docs"),
  "structured-docs",
  "the explicit profile query key should be matched case-insensitively"
);

assert.equal(
  readExplicitProfileIdFromQuery("?birds"),
  null,
  "a bare query token is not an explicit profile request"
);

assert.equal(
  matchForcedProfileIdFromQuery("?profile=language-resources", PROFILE_IDS),
  "language-resources",
  "an explicit profile query should match a known profile id"
);

assert.equal(
  matchForcedProfileIdFromQuery("?structured-docs", PROFILE_IDS),
  "structured-docs",
  "a bare query token should force the matching known profile"
);

assert.equal(
  matchForcedProfileIdFromQuery("?x=birds&y=1", PROFILE_IDS),
  "birds",
  "query values should also be checked for a known profile id"
);

assert.equal(
  matchForcedProfileIdFromQuery("?profile=unknown&birds", PROFILE_IDS),
  "birds",
  "an invalid explicit profile should fall back to any other matching query token"
);

assert.equal(
  matchForcedProfileIdFromQuery("?profile=UNKNOWN", PROFILE_IDS),
  null,
  "unknown query values should not force any profile"
);

const hidden = collectOptionSubtreeKeys(
  [
    {
      key: "makeHtml",
      children: [
        { key: "templateRepoFolder" },
        { key: "styledPreview", children: [{ key: "configFile" }] },
      ],
    },
    { key: "merge" },
  ],
  ["makeHtml"]
);

assert.deepEqual(
  [...hidden].sort(),
  ["configFile", "makeHtml", "styledPreview", "templateRepoFolder"],
  "hiding one option group should include the whole subtree so its UI can disappear while values stay applied"
);

console.log("test-profile-url-override: all tests passed (query matching and hidden subtree selection)");