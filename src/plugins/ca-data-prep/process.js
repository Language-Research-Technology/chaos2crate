import { ROCrate } from "ro-crate";
import mammoth from "mammoth";

export function normalizeText(text) {
  let normalized = String(text || "");

  normalized = normalized.replace(/\r\n/g, "\n");
  normalized = normalized.replace(/\r/g, "\n");
  normalized = normalized.replace(/\u00A0/g, " ");
  normalized = normalized.replace(/^[\t ]+/gm, "\t");
  normalized = normalized.replace(/^([A-Z]):[\t ]+/gm, "$1:\t");
  normalized = normalized.replace(/^([A-Z])[\t ]+/gm, "$1:\t");
  normalized = normalized.replace(/(\t.*) \t/gm, "$1 ");
  normalized = normalized.replace(/^.*END OF TRANSCRIPT.*$/gm, "");

  return normalized;
}

export function mergeContinuationLines(text) {
  let merged = text;
  const protectedPatterns = [
    /^Speakers:$/i,
    /^PRELIMINARIES$/i,
    /^MAIN$/i,
    /^POSTLIMINARIES$/i,
    /^Transcript:/i,
    /^Recording date:/i,
    /^Length of audio recording:/i,
    /^Length of video recording:/i,
    /^Transcriber:/i,
  ];

  const isProtectedLine = (value) => protectedPatterns.some((pattern) => pattern.test(value.trim()));

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const lines = merged.split("\n");
    const repaired = [];
    let changed = false;

    for (const rawLine of lines) {
      const line = rawLine;
      const trimmed = line.trim();
      const isSpeakerLine = /^([A-Z][A-Z0-9]?\s*:|[A-Z][A-Z0-9]?:)\s*(\t|.*)$/.test(line);

      if (isProtectedLine(trimmed)) {
        repaired.push(line);
        continue;
      }

      if (!isSpeakerLine && repaired.length > 0) {
        const previous = repaired[repaired.length - 1];
        const nextValue = previous.trimEnd() + " " + line.trim();
        repaired[repaired.length - 1] = nextValue;
        changed = true;
      } else {
        repaired.push(line);
      }
    }

    const candidate = repaired.join("\n");
    if (!changed || candidate === merged) {
      merged = candidate;
      break;
    }
    merged = candidate;
  }

  return merged;
}

export function parseSpeakerBlock(lines, warnings = []) {
  const speakers = new Map();
  let inSpeakerSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === "Speakers:") {
      inSpeakerSection = true;
      continue;
    }

    if (inSpeakerSection && trimmed === "PRELIMINARIES") {
      inSpeakerSection = false;
      break;
    }

    if (!inSpeakerSection) continue;

    const speakerMatch = trimmed.match(/^([A-Z][A-Z0-9]?)\s*:\s*(.*)$/);
    if (!speakerMatch) continue;

    const speakerID = speakerMatch[1];
    const speakerText = speakerMatch[2].trim();
    const optionalCode = speakerText.match(/(#\S+)/)?.[1] ?? null;
    const resolvedSpeakerID = optionalCode || speakerID;
    speakers.set(speakerID, {
      label: speakerText.replace(/\s*#\S+\s*$/, "").trim(),
      optionalCode,
      resolvedSpeakerID,
    });

    if (!optionalCode) warnings.push(`Speaker ${speakerID} is missing an optional #speaker code.`);
  }

  return speakers;
}

export function buildSpeakerPersonEntities(speakerMap) {
  const entities = [];

  for (const [speakerID, details] of speakerMap.entries()) {
    const entityId = details.optionalCode ? details.optionalCode : `#${speakerID}`;
    const entity = {
      "@id": entityId,
      "@type": "Person",
      name: details.label || speakerID,
    };

    if (details.optionalCode) entity.identifier = details.optionalCode;
    entities.push(entity);
  }

  return entities;
}

export function validateSectionOrder(foundSections, warnings = []) {
  const expected = ["PRELIMINARIES", "MAIN", "POSTLIMINARIES"];
  const actual = foundSections.slice();

  if (!actual.length) {
    warnings.push("No section markers found. Defaulting all rows to MAIN.");
    return;
  }

  const firstMarker = actual[0];
  if (firstMarker !== "PRELIMINARIES") {
    warnings.push(`Unexpected first section marker: ${firstMarker ?? "none"}. Expected PRELIMINARIES.`);
  }

  const orderedSeen = [];
  for (const marker of expected) {
    if (actual.includes(marker)) orderedSeen.push(marker);
  }

  if (orderedSeen.length > 0 && orderedSeen[0] !== "PRELIMINARIES") {
    warnings.push("Section order warning: expected PRELIMINARIES before MAIN.");
  }

  if (orderedSeen.includes("MAIN") && orderedSeen.indexOf("MAIN") < orderedSeen.indexOf("PRELIMINARIES")) {
    warnings.push("Section order warning: MAIN appears before PRELIMINARIES.");
  }

  if (actual.includes("POSTLIMINARIES")) {
    const mainIndex = actual.indexOf("MAIN");
    const postIndex = actual.indexOf("POSTLIMINARIES");
    if (mainIndex !== -1 && postIndex !== -1 && postIndex < mainIndex) {
      warnings.push("Section order warning: POSTLIMINARIES appears before MAIN.");
    }
  }
}

export function parseRows(text, warnings = []) {
  const rows = [];
  const lines = text.split("\n");
  const speakers = parseSpeakerBlock(lines, warnings);
  let sectionOrder = [];
  let currentSection = "MAIN";
  let transcriptStarted = false;
  let lastRow = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line === "Speakers:") {
      transcriptStarted = false;
      continue;
    }

    if (line === "PRELIMINARIES") {
      transcriptStarted = true;
      currentSection = "PRE";
      sectionOrder.push(line);
      continue;
    }

    if (line === "MAIN") {
      transcriptStarted = true;
      currentSection = "MAIN";
      sectionOrder.push(line);
      continue;
    }

    if (line === "POSTLIMINARIES") {
      transcriptStarted = true;
      currentSection = "POST";
      sectionOrder.push(line);
      continue;
    }

    if (!transcriptStarted) continue;

    if (speakers.size > 0 && /^([A-Z][A-Z0-9]?)\s*:\s*/.test(line)) {
      const match = line.match(/^([A-Z][A-Z0-9]?)\s*:\s*(.*)$/);
      if (!match) continue;

      const rawSpeakerID = match[1];
      const transcriptText = match[2].trim();
      const speakerDetails = speakers.get(rawSpeakerID);
      const speakerID = speakerDetails?.optionalCode || rawSpeakerID;
      if (!speakerID || !transcriptText) continue;

      lastRow = { speakerID, text: transcriptText, section: currentSection };
      rows.push(lastRow);
      continue;
    }

    if (!lastRow) continue;
    lastRow.text = `${lastRow.text} ${line.trim()}`.trim();
  }

  validateSectionOrder(sectionOrder, warnings);
  return rows;
}

export function cleanCharacterValues(value) {
  const replacements = {
    "“": '"',
    "”": '"',
    "‘": "'",
    "’": "'",
    "—": "-",
    "–": "-",
  };

  if (typeof value !== "string") return value;

  let cleaned = value.trim();
  for (const [oldChar, newChar] of Object.entries(replacements)) {
    cleaned = cleaned.replaceAll(oldChar, newChar);
  }

  return cleaned;
}

export function collectCharacterInventory(rows) {
  const chars = new Set();
  for (const row of rows) {
    const values = [row.speakerID, row.text, row.section];
    for (const value of values) {
      const text = String(value ?? "");
      for (const char of text) chars.add(char);
    }
  }
  return [...chars].sort();
}

export function collectUnresolvedSpeakerRows(rows) {
  return rows
    .map((row, index) => ({ index, speakerID: row.speakerID || "" }))
    .filter(({ speakerID }) => !String(speakerID).includes("#"));
}

export function formatUnresolvedSpeakerRows(rows) {
  const unresolved = collectUnresolvedSpeakerRows(rows);
  if (!unresolved.length) return "Unresolved speakerIDs: none";

  const lines = [`Unresolved speakerIDs (${unresolved.length}):`];
  for (const item of unresolved) lines.push(`Row ${item.index}: ${item.speakerID}`);

  return lines.join("\n");
}

export function formatCharacterInventory(rows) {
  const chars = collectCharacterInventory(rows);
  const lines = ["Character inventory:"];

  for (const char of chars) {
    const code = `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    const name = (globalThis.__TRANSCRIPT_CHAR_NAMES__ && globalThis.__TRANSCRIPT_CHAR_NAMES__[char]) || "";
    lines.push(`${JSON.stringify(char)}  ${code}  ${name || char}`);
  }

  return lines.join("\n");
}

export function stripTimecodes(text, removed = []) {
  const pattern = /\(\s*~?\d+:\d+\s*\)/g;
  let cleaned = String(text || "");
  const matches = cleaned.match(pattern) || [];
  for (const match of matches) removed.push(match);
  cleaned = cleaned.replace(pattern, "");
  return cleaned;
}

export function toCsv(rows) {
  const output = ["speakerID,text,section"];
  for (const row of rows) {
    const speakerID = escapeCsv(row.speakerID || "");
    const text = escapeCsv(row.text || "");
    const section = escapeCsv(row.section || "MAIN");
    output.push(`${speakerID},${text},${section}`);
  }
  return output.join("\n") + "\n";
}

export function escapeCsv(value) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

export function processTranscriptText(text, config = {}) {
  const warnings = [];
  const removedTimecodes = [];
  const normalized = normalizeText(text);
  const timecodeStripped = stripTimecodes(normalized, removedTimecodes);
  const merged = mergeContinuationLines(timecodeStripped);
  const speakerMap = parseSpeakerBlock(merged.split("\n"), warnings);
  let rows = parseRows(merged, warnings);

  if (config.headerRows > 0) rows = rows.slice(config.headerRows);
  if (config.footerRows > 0) rows = rows.slice(0, Math.max(0, rows.length - config.footerRows));

  rows = rows.map((row) => ({
    speakerID: cleanCharacterValues(row.speakerID),
    text: cleanCharacterValues(row.text),
    section: cleanCharacterValues(row.section || "MAIN"),
  }));

  const logLines = [
    "Transformations applied: text normalization, continuation repair, speaker block review, section classification, character cleanup.",
    "",
    formatUnresolvedSpeakerRows(rows),
    "",
    formatCharacterInventory(rows),
  ];

  if (removedTimecodes.length) {
    logLines.splice(0, 0, `Timecodes removed (${removedTimecodes.length}): ${removedTimecodes.join(", ")}`);
  }

  return {
    rows,
    speakerMap,
    warnings,
    removedTimecodes,
    log: logLines.join("\n"),
  };
}

export async function resolveMammothArrayBuffer(docxSource) {
  if (!docxSource) return null;

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(docxSource)) {
    return docxSource.buffer.slice(docxSource.byteOffset, docxSource.byteOffset + docxSource.byteLength);
  }

  if (docxSource instanceof ArrayBuffer) {
    return docxSource;
  }

  if (ArrayBuffer.isView(docxSource)) {
    const view = docxSource;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  if (docxSource && typeof docxSource.arrayBuffer === "function") {
    return await docxSource.arrayBuffer();
  }

  if (docxSource && typeof docxSource.buffer !== "undefined" && docxSource.buffer instanceof ArrayBuffer) {
    const view = docxSource;
    const bytes = new Uint8Array(view.buffer, view.byteOffset || 0, view.byteLength || view.buffer.byteLength);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  return null;
}

export function toMammothInputOptions(docxSource) {
  if (!docxSource) return {};
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(docxSource)) {
    return { buffer: docxSource };
  }
  if (docxSource instanceof ArrayBuffer) {
    return { arrayBuffer: docxSource };
  }
  if (ArrayBuffer.isView(docxSource)) {
    const view = docxSource;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }
  if (docxSource && typeof docxSource.arrayBuffer === "function") {
    return { arrayBuffer: true };
  }
  if (docxSource && typeof docxSource.buffer !== "undefined" && docxSource.buffer instanceof ArrayBuffer) {
    const view = docxSource;
    const bytes = new Uint8Array(view.buffer, view.byteOffset || 0, view.byteLength || view.buffer.byteLength);
    return { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }
  return {};
}

export async function callMammothExtractRawText(docxBuffer) {
  const arrayBuffer = docxBuffer instanceof ArrayBuffer ? docxBuffer : new Uint8Array(docxBuffer).buffer.slice(
    0,
    docxBuffer.byteLength || docxBuffer.length
  );
  const candidates = [
    { buffer: docxBuffer },
    { buffer: new Uint8Array(arrayBuffer) },
    { arrayBuffer },
  ];

  let lastError;
  for (const options of candidates) {
    try {
      return await mammoth.extractRawText(options);
    } catch (error) {
      const message = error && typeof error.message === "string" ? error.message : String(error);
      if (!/Could not find file in options/i.test(message)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError || new Error("Could not find file in options");
}

export async function extractDocumentText(docxSource) {
  if (!docxSource) return "";

  const mammothBuffer = await resolveMammothArrayBuffer(docxSource);
  if (!mammothBuffer) return "";

  const result = await callMammothExtractRawText(mammothBuffer);
  return result.value || "";
}

export function buildRoCrateMetadata(collectionName, documents) {
  const crate = new ROCrate({ array: true, link: true });
  crate.addContext({ ldac: "https://w3id.org/ldac/terms#" });
  crate.addContext({ pcdm: "http://pcdm.org/models#" });

  crate.rootDataset["@id"] = "./";
  crate.rootDataset["@type"] = ["Dataset", "RepositoryCollection"];
  crate.rootDataset.name = collectionName;
  crate.rootDataset.conformsTo = { "@id": "https://w3id.org/ldac/profile" };
  crate.descriptor.about = { "@id": "./" };

  const collectionEntity = {
    "@id": "./collection",
    "@type": "RepositoryCollection",
    name: collectionName,
    hasMember: documents.map((document) => ({ "@id": document.objectId })),
  };

  crate.addEntity(collectionEntity);
  crate.rootDataset.hasMember = documents.map((document) => ({ "@id": document.objectId }));

  for (const document of documents) {
    const objectEntity = {
      "@id": document.objectId,
      "@type": "RepositoryObject",
      name: document.baseName,
      hasPart: [
        { "@id": document.docxId },
        { "@id": document.csvId },
      ],
      speaker: document.speakerRefs,
    };

    const annotationEntity = {
      "@id": document.annotationId,
      "@type": "Annotation",
      annotationOf: { "@id": document.objectId },
      annotationBody: { "@id": document.csvId },
    };

    crate.addEntity(objectEntity);
    crate.addEntity(annotationEntity);
    crate.addEntity({
      "@id": document.docxId,
      "@type": "File",
      name: document.docxName,
      encodingFormat: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    crate.addEntity({
      "@id": document.csvId,
      "@type": "File",
      name: document.csvName,
      encodingFormat: "text/csv",
    });

    for (const person of document.persons) crate.addEntity(person);
  }

  return crate;
}
