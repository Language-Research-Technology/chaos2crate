// Small File System Access API helpers shared between the UI (main.js) and
// the docx crate builder (docx_crate.js).

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
