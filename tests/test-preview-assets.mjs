// URL rewriting for the in-app preview.
//
// A preview page is handed to the popup as a blob, with no folder to resolve
// relative paths against, so every reference to a crate file has to become
// that file's blob URL first. Attributes were covered; CSS wasn't — and the
// birds template gives each card its picture through
// style="background-image: url('files/images/magpie.jpg')", which has neither
// src nor href. The card came up empty in the preview while the written file
// opened from disk looked fine, which is what made it easy to miss.
import assert from "node:assert/strict";
import {
  isAbsoluteLikeUrl, splitUrlParts, normalizeRelativePath, mapAssetUrl, rewriteCssUrls,
} from "../src/preview_assets.js";

const assetMap = new Map([
  ["files/images/magpie.jpg", "blob:http://localhost/magpie"],
  ["files/audio/calls/magpie.mp3", "blob:http://localhost/call"],
  ["style.css", "blob:http://localhost/style"],
]);

/* ---------- what counts as ours to rewrite ---------- */

assert.equal(isAbsoluteLikeUrl("https://example.com/a.jpg"), true);
assert.equal(isAbsoluteLikeUrl("data:image/png;base64,AAA"), true);
assert.equal(isAbsoluteLikeUrl("//cdn.example.com/a.jpg"), true);
assert.equal(isAbsoluteLikeUrl("#anchor"), true);
assert.equal(isAbsoluteLikeUrl("files/images/magpie.jpg"), false);

assert.deepEqual(splitUrlParts("a/b.jpg?v=2#frag"), { base: "a/b.jpg", suffix: "?v=2#frag" });
assert.deepEqual(splitUrlParts("a/b.jpg"), { base: "a/b.jpg", suffix: "" });

assert.equal(normalizeRelativePath("./files/images/magpie.jpg"), "files/images/magpie.jpg");
assert.equal(normalizeRelativePath("../../files/images/magpie.jpg"), "files/images/magpie.jpg",
  "a page nested under ro-crate-preview_html reaches back up to the crate root");
assert.equal(normalizeRelativePath("/files/images/magpie.jpg"), "files/images/magpie.jpg");
assert.equal(normalizeRelativePath("files%2Fimages%2Fmagpie.jpg"), "files/images/magpie.jpg");

/* ---------- single references ---------- */

assert.equal(mapAssetUrl("files/images/magpie.jpg", assetMap), "blob:http://localhost/magpie");
assert.equal(mapAssetUrl("./files/images/magpie.jpg", assetMap), "blob:http://localhost/magpie");
assert.equal(mapAssetUrl("files/images/magpie.jpg?v=2", assetMap), "blob:http://localhost/magpie?v=2",
  "a query string should survive the swap");
assert.equal(mapAssetUrl("https://example.com/x.jpg", assetMap), null, "absolute URLs are left alone");
assert.equal(mapAssetUrl("files/images/nope.jpg", assetMap), null, "a file the crate doesn't have is left alone");
assert.equal(mapAssetUrl("", assetMap), null);

/* ---------- CSS ---------- */

{
  // The exact shape the birds root template emits.
  const style = "background-image: url('files/images/magpie.jpg');";
  assert.equal(
    rewriteCssUrls(style, assetMap),
    "background-image: url('blob:http://localhost/magpie');",
    "the inline style that gives a card its picture must be rewritten"
  );
}

assert.equal(
  rewriteCssUrls('background-image: url("files/images/magpie.jpg")', assetMap),
  'background-image: url("blob:http://localhost/magpie")',
  "double quotes preserved"
);
assert.equal(
  rewriteCssUrls("background-image: url(files/images/magpie.jpg)", assetMap),
  "background-image: url(blob:http://localhost/magpie)",
  "unquoted form preserved"
);
assert.equal(
  rewriteCssUrls("background: url( 'files/images/magpie.jpg' )", assetMap),
  "background: url('blob:http://localhost/magpie')",
  "whitespace inside url() shouldn't defeat the match"
);

{
  const css = `
    .bird { background-image: url('files/images/magpie.jpg'); }
    .call { background: url("files/audio/calls/magpie.mp3"); }
    .remote { background: url(https://example.com/bg.png); }
    .inline { background: url(data:image/gif;base64,R0lGOD); }
    .missing { background: url('files/images/nope.jpg'); }
  `;
  const out = rewriteCssUrls(css, assetMap);
  assert.match(out, /url\('blob:http:\/\/localhost\/magpie'\)/);
  assert.match(out, /url\("blob:http:\/\/localhost\/call"\)/);
  assert.match(out, /url\(https:\/\/example\.com\/bg\.png\)/, "an absolute URL stays put");
  assert.match(out, /url\(data:image\/gif;base64,R0lGOD\)/, "a data URI stays put");
  assert.match(out, /url\('files\/images\/nope\.jpg'\)/, "an unmapped path stays put rather than becoming empty");
}

assert.equal(rewriteCssUrls("", assetMap), "", "empty stylesheet is not an error");
assert.equal(rewriteCssUrls("color: red;", assetMap), "color: red;", "a declaration with no url() is untouched");
assert.equal(rewriteCssUrls("background: url('a.jpg')", null), "background: url('a.jpg')", "no map, no change");

console.log(`test-preview-assets: all tests passed (${assetMap.size} mapped assets, quoted/unquoted/absolute/data/unmapped url() forms)`);
