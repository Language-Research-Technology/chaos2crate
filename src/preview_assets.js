// URL rewriting for the in-app preview.
//
// A preview page is served to the popup as a blob, so it has no folder to
// resolve relative paths against: every reference to a file in the crate has
// to be swapped for that file's blob URL before the page is handed over.
// main.js walks the DOM to do it; the string-level decisions live here, where
// they can be tested without a DOM.

export function isAbsoluteLikeUrl(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//") || value.startsWith("#");
}

export function splitUrlParts(value) {
  const hashIdx = value.indexOf("#");
  const queryIdx = value.indexOf("?");
  const cut = [hashIdx, queryIdx].filter((n) => n >= 0).reduce((a, b) => Math.min(a, b), value.length);
  return {
    base: value.slice(0, cut),
    suffix: value.slice(cut),
  };
}

export function normalizeRelativePath(value) {
  let v = (value || "").trim();
  if (!v) return "";
  try { v = decodeURIComponent(v); } catch { /* keep as-is */ }
  v = v.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const out = [];
  for (const part of v.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

// The blob URL for one relative reference, or null when it isn't ours to
// rewrite (absolute, empty, or a file the crate doesn't contain).
export function mapAssetUrl(raw, assetMap) {
  if (!raw || isAbsoluteLikeUrl(raw)) return null;
  const { base, suffix } = splitUrlParts(raw);
  const key = normalizeRelativePath(base);
  if (!key) return null;
  const mapped = assetMap.get(key) || assetMap.get(encodeURI(key));
  return mapped ? mapped + suffix : null;
}

// Rewrite every url(...) in a stylesheet or inline style declaration.
//
// Templates reach for CSS as often as for markup — the birds root template
// gives each card its picture with
//   style="background-image: url('files/images/magpie.jpg')"
// which carries no src or href, so a DOM walk over [src],[href] never sees it
// and the image silently fails to load in the preview. It resolves fine when
// the written file is opened from disk, which is what makes this easy to miss.
//
// Handles single, double and unquoted forms, preserves the original quoting,
// and leaves anything it can't map untouched — an absolute URL, a data: URI,
// or a path to a file the crate doesn't have.
export function rewriteCssUrls(cssText, assetMap) {
  if (!cssText || !assetMap) return cssText;
  return String(cssText).replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (whole, quote, raw) => {
      const mapped = mapAssetUrl(raw.trim(), assetMap);
      return mapped ? `url(${quote}${mapped}${quote})` : whole;
    }
  );
}
