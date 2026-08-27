// Shared CSV building + browser-download helpers for analysis plugins —
// concordance.js and ngrams.js both need the same field-escaping and
// save-as-file behavior for their results.

export function csvField(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsvText(header, rows) {
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return lines.join("\n");
}

// Same Blob + URL.createObjectURL + <a download> pattern as main.js's
// saveLog() — kept local here rather than shared with main.js since
// analysis-plugins modules don't otherwise import from main.js (main.js
// imports from them, not the reverse).
export function downloadCsv(filename, csvText) {
  const url = URL.createObjectURL(new Blob([csvText], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
