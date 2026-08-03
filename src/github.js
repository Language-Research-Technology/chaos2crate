// Shared GitHub-fetch helpers — used by main.js (profile list, template-repo
// folder dropdown) and the ro-crate-html-output plugin (fetching a chosen
// template bundle). Kept in one neutral module rather than owned by either
// side, to avoid a circular import between main.js and the plugin.

// raw.githubusercontent.com is served through a CDN that caches per exact URL
// for a few minutes, so a recent push can otherwise still serve stale content;
// a unique query param forces a fresh fetch from origin.
export function bustCacheUrl(rawUrl) {
  return `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}_=${Date.now()}`;
}

export function buildGitHubRawUrl(owner, repo, ref, filePath) {
  const safePath = String(filePath || "").split("/").map((p) => encodeURIComponent(p)).join("/");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${safePath}`;
}

export function buildGitHubTreeUrl(owner, repo, ref, folderPath) {
  const safePath = String(folderPath || "").split("/").map((p) => encodeURIComponent(p)).join("/");
  return `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(ref)}/${safePath}`;
}

export async function fetchGitHubTextFile(owner, repo, ref, filePath, downloadUrl = "") {
  const url = downloadUrl || buildGitHubRawUrl(owner, repo, ref, filePath);
  const res = await fetch(bustCacheUrl(url), { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not download ${filePath} (${res.status} ${res.statusText}).`);
  return await res.text();
}

// Folder listings go through the GitHub Contents API, which — unlike the
// raw.githubusercontent.com fetches above — is rate-limited to 60
// unauthenticated requests/hour per IP. The same few folders (profiles list,
// template-repo folder list, a chosen template's contents) get re-listed
// every time their step is revisited in a session, so cache by (owner, repo,
// ref, folderPath) for the lifetime of the page load. Only successful
// results are cached — a failure (rate limit, network blip) should still be
// retried next time, not remembered as permanent.
const githubFolderCache = new Map();

export async function listGitHubFolder(owner, repo, ref, folderPath) {
  const cacheKey = `${owner}/${repo}/${ref}/${folderPath}`;
  if (githubFolderCache.has(cacheKey)) return githubFolderCache.get(cacheKey);

  const encodedFolder = folderPath.split("/").map((p) => encodeURIComponent(p)).join("/");
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedFolder}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(apiUrl, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`Could not list template folder "${folderPath}" (${res.status} ${res.statusText}).`);
  const entries = await res.json();
  if (!Array.isArray(entries)) throw new Error(`Unexpected API response for template folder "${folderPath}".`);
  githubFolderCache.set(cacheKey, entries);
  return entries;
}
