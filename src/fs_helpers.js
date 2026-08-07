// Small File System Access API helpers shared between the UI (main.js), the
// docx crate builder (docx_crate.js), and build plugins (src/plugins/*.js).

export async function verifyPermission(handle, readWrite) {
  const opts = { mode: readWrite ? "readwrite" : "read" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

export async function fileExists(handle, filename) {
  try { await handle.getFileHandle(filename, { create: false }); return true; }
  catch { return false; }
}

export async function readFileText(handle, filename) {
  try {
    const fh = await handle.getFileHandle(filename, { create: false });
    return await (await fh.getFile()).text();
  } catch (e) {
    if (e && e.name === "NotFoundError") return null;
    throw e;
  }
}

export async function readFileTextFromDirectory(handle, relativePath) {
  if (!handle) return null;
  const parts = String(relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return null;
  let dir = handle;
  for (let i = 0; i < parts.length - 1; i++) {
    try { dir = await dir.getDirectoryHandle(parts[i], { create: false }); }
    catch (e) {
      if (e && e.name === "NotFoundError") return null;
      throw e;
    }
  }
  try {
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: false });
    return await (await fh.getFile()).text();
  } catch (e) {
    if (e && e.name === "NotFoundError") return null;
    throw e;
  }
}

// Like readFileText but for binary files (.xlsx and friends) — returns an
// ArrayBuffer, or null when the file isn't there.
export async function readFileBytes(handle, filename) {
  try {
    const fh = await handle.getFileHandle(filename, { create: false });
    return await (await fh.getFile()).arrayBuffer();
  } catch (e) {
    if (e && e.name === "NotFoundError") return null;
    throw e;
  }
}

export async function readJsonFromFolder(handle, filename) {
  const text = await readFileText(handle, filename);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${filename} in the folder is not valid JSON: ${e.message}`); }
}

export async function writeFile(handle, filename, contents) {
  const fh = await handle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(contents);
  await w.close();
}

// Like writeFile, but `relativePath` may contain "/" segments (e.g. the
// ro-crate-preview_html/<hash>/<hash>/<hash>/<hash>/index.html layout a
// multipage build writes, or files/<collection>/media/<name> for docx
// output) — intermediate directories are created as needed.
export async function writeFileAtPath(dirHandle, relativePath, contents) {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop();
  let dir = dirHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  await writeFile(dir, filename, contents);
}
