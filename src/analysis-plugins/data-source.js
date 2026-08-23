// Reads the folder of data a build plugin produced (CSV/CHAT transcripts,
// plain text) into a flat list of "documents" — one per row/utterance/line —
// that analysis plugins search over. Kept separate from src/fs_helpers.js
// because it's about *interpreting* file contents, not just reading bytes.

const SUPPORTED_EXTENSIONS = [".csv", ".cha", ".txt"];

function extensionOf(fileName) {
  const m = /\.[^.]+$/.exec(fileName || "");
  return m ? m[0].toLowerCase() : "";
}

// Recursively lists files under dirHandle with a supported extension,
// skipping dotfiles/dot-directories. Unlike main.js's walkDirectory, this
// doesn't need to exclude generated crate/plugin-output paths — the folder a
// user picks for visualisation is typically the plugin output folder itself.
async function scanDataFiles(dirHandle, prefix = "") {
  const files = [];
  for await (const entry of dirHandle.values()) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      files.push(...await scanDataFiles(entry, relativePath));
    } else {
      const ext = extensionOf(entry.name);
      if (SUPPORTED_EXTENSIONS.includes(ext)) files.push({ fileName: entry.name, relativePath, ext });
    }
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

// Resolves a "/"-joined relative path (e.g. "c2c-output/csv") to a directory
// handle under dirHandle, or null if any segment along the way doesn't exist.
async function resolveDirectoryHandle(dirHandle, relativePath) {
  const parts = String(relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  let dir = dirHandle;
  for (const part of parts) {
    try { dir = await dir.getDirectoryHandle(part, { create: false }); }
    catch (e) {
      if (e && e.name === "NotFoundError") return null;
      throw e;
    }
  }
  return dir;
}

// The picker's actual data source: rather than listing every file in the
// folder, offer the directories build plugins declared as outputPaths (e.g.
// c2c-output/csv, c2c-output/logs, c2c-output/chat — see composeOutputPaths()
// in src/plugins/index.js). Only directories that both exist and actually
// contain a supported file are offered, so an empty or irrelevant declared
// output (e.g. a plugin's HTML/asset folder) doesn't show up as a dead option.
export async function scanOutputDirectories(dirHandle, outputPaths) {
  const results = [];
  for (const { path } of outputPaths.filter((p) => p.kind === "dir")) {
    const subDir = await resolveDirectoryHandle(dirHandle, path);
    if (!subDir) continue;
    const files = await scanDataFiles(subDir, path);
    if (files.length) results.push({ path, files });
  }
  return results;
}

// Minimal RFC4180-ish CSV parser: handles quoted fields containing commas,
// newlines and escaped ("") quotes — the shapes c2c-plugins' escapeCsv()
// (ca-data-prep/process.js) produces. Not a general CSV library; good enough
// for the app's own generated output.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // skip — a following \n (if any) ends the row
    } else {
      field += c;
    }
  }
  if (field.length || row.length) pushRow();
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function documentsFromCsv(relativePath, text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const textCol = header.indexOf("text");
  const speakerCol = header.findIndex((h) => h === "speakerid" || h === "speaker");
  const docs = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.some((c) => c.trim())) continue;
    const text = (textCol >= 0 ? cells[textCol] : cells.join(" ")) || "";
    if (!text.trim()) continue;
    docs.push({
      id: `${relativePath}#${i}`,
      source: relativePath,
      speaker: speakerCol >= 0 ? (cells[speakerCol] || "") : "",
      text,
    });
  }
  return docs;
}

// CHAT (.cha) transcript lines look like "*CHI:\ttext..." — everything else
// (the @-prefixed header block) is metadata, not utterance text.
function documentsFromChat(relativePath, text) {
  const docs = [];
  let index = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const utterance = m[2].trim();
    if (!utterance) continue;
    index++;
    docs.push({ id: `${relativePath}#${index}`, source: relativePath, speaker: m[1].trim(), text: utterance });
  }
  return docs;
}

function documentsFromText(relativePath, text) {
  const docs = [];
  let index = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    index++;
    docs.push({ id: `${relativePath}#${index}`, source: relativePath, speaker: "", text: trimmed });
  }
  return docs;
}

// Reads and parses every given file into the flat document list analysis
// plugins search over. `readText(relativePath)` is injected (rather than a
// dirHandle) so this module doesn't need to know about File System Access
// handles — main.js passes readFileTextFromDirectory bound to its dirHandle.
export async function loadDocuments(files, readText, log) {
  const documents = [];
  for (const file of files) {
    const text = await readText(file.relativePath);
    if (text === null) { if (log) log(`Skipped ${file.relativePath}: could not be read.`, "warn"); continue; }
    if (file.ext === ".csv") documents.push(...documentsFromCsv(file.relativePath, text));
    else if (file.ext === ".cha") documents.push(...documentsFromChat(file.relativePath, text));
    else documents.push(...documentsFromText(file.relativePath, text));
  }
  return documents;
}
