import { HOOKS } from "../hooks.js";
import { buildRoCrateMetadata, processTranscriptText, extractDocumentText, buildSpeakerPersonEntities } from "./process.js";
import { writeFileAtPath } from "../../fs_helpers.js";

export async function readDocxFileBytesFromDirHandle(dirHandle, relativePath) {
  if (!dirHandle || !relativePath) return null;
  const parts = String(relativePath).replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return null;
  let dir = dirHandle;
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create: false });
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: false });
  return await (await fileHandle.getFile()).arrayBuffer();
}

export const plugin = {
  name: "ca-data-prep",
  optionSchema: {
    key: "processTranscriptDocuments",
    label: "Process plain transcript documents (.docx)",
    default: false,
    hint: "Runs the CAAT/AmAus transcript parser over .docx files in the generic folder build, writing cleaned CSV/log outputs and transcript metadata.",
  },
  hooks: {
    [HOOKS.FILES_ANALYZE]: async (ctx) => {
      if (!ctx.options.processTranscriptDocuments) return;
      const files = (ctx.filesWithMeta || ctx.files || []).filter((entry) => /\.docx$/i.test(entry.fileName || entry.name || ""));
      if (!files.length) return;

      const documentRecords = [];
      for (const file of files) {
        const filePath = file.relativePath || file.fileName || file.name || "";
        let buffer = file.arrayBuffer ? await file.arrayBuffer() : null;
        if (!buffer && ctx.dirHandle && filePath) {
          buffer = await readDocxFileBytesFromDirHandle(ctx.dirHandle, filePath);
        }
        if (!buffer) {
          ctx.log(`Skipped transcript processing for ${filePath || file.fileName || file.name || "unknown .docx"}: file bytes were unavailable.`, "warn");
          continue;
        }
        const text = await extractDocumentText(buffer);
        const result = processTranscriptText(text, ctx.options || {});
        const baseName = (file.fileName || file.name).replace(/\.docx$/i, "");
        const csvText = (() => {
          const lines = ["speakerID,text,section"];
          for (const row of result.rows) lines.push(`${row.speakerID},${row.text},${row.section}`);
          return lines.join("\n") + "\n";
        })();

        const speakerRefs = Array.from(result.speakerMap.entries()).map(([speakerID, details]) => ({
          "@id": details.optionalCode || `#${speakerID}`,
        }));

        documentRecords.push({
          baseName,
          docxName: file.fileName || file.name,
          csvName: `${baseName}.csv`,
          sourcePath: file.relativePath,
          objectId: `./${baseName}`,
          docxId: file.relativePath,
          csvId: `./${baseName}.csv`,
          annotationId: `#annotation-${baseName}`,
          speakerRefs,
          persons: buildSpeakerPersonEntities(result.speakerMap),
          csvText,
          logText: `${result.log}\n`,
          fileCount: 1,
        });
      }

      ctx.caDataPrep = { files, documentRecords };
      ctx.log(`Prepared transcript processing for ${files.length} .docx file(s).`, "muted");
    },

    [HOOKS.CRATE_BUILT]: async (ctx) => {
      if (!ctx.options.processTranscriptDocuments || !ctx.caDataPrep) return;
      const { files, documentRecords } = ctx.caDataPrep;
      if (!documentRecords.length) return;

      for (const document of documentRecords) {
        await writeFileAtPath(ctx.dirHandle, `${document.baseName}.csv`, document.csvText);
        await writeFileAtPath(ctx.dirHandle, `${document.baseName}.log.txt`, document.logText);
      }

      ctx.crate = buildRoCrateMetadata((ctx.dirHandle && ctx.dirHandle.name) || "Transcript Collection", documentRecords);
      ctx.sourceCount = files.length;
      ctx.log(`Built transcript crate from ${files.length} .docx file(s).`, "ok");
    },
  },
};
