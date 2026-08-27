// Concordance (KWIC — keyword-in-context) explorer. Follows the LADAL
// concordancing tutorial's shape (https://ladal.edu.au/tutorials/concordancing/)
// as simply as possible: find every match of a search term across the loaded
// documents, then show it with a few words of context on either side.

import { buildCsvText, downloadCsv } from "./csv.js";

const MAX_RENDERED_ROWS = 2000;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// For the "Save CSV" filename — a plain, filesystem-safe slug of the search
// query, not a full escape (this never needs to round-trip back into a
// regex or CSV field the way csvField's escaping does).
function slugify(value) {
  const s = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 40) || "query";
}

function buildMatcher(query, { regex, wholeWord, caseSensitive }) {
  let pattern = regex ? query : escapeRegExp(query);
  if (!regex && wholeWord) pattern = `\\b${pattern}\\b`;
  return new RegExp(pattern, caseSensitive ? "g" : "gi");
}

// Character-based context extraction: slice the raw text around the match,
// then trim to whole words — simpler than token-indexing the whole document
// up front, and it still yields an N-word window either side.
function contextWords(text, count, fromEnd) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return fromEnd ? words.slice(-count).join(" ") : words.slice(0, count).join(" ");
}

export function search(documents, query, options) {
  const matcher = buildMatcher(query, options);
  const results = [];
  for (const doc of documents) {
    matcher.lastIndex = 0;
    let m;
    while ((m = matcher.exec(doc.text))) {
      if (m[0] === "") { matcher.lastIndex++; continue; }
      results.push({
        source: doc.source,
        speaker: doc.speaker || "",
        left: contextWords(doc.text.slice(0, m.index), options.windowSize, true),
        keyword: m[0],
        right: contextWords(doc.text.slice(m.index + m[0].length), options.windowSize, false),
      });
    }
  }
  return results;
}

export const concordancePlugin = {
  id: "concordance",
  name: "Concordance (KWIC)",
  description: "Search for a word or phrase and see every occurrence in context.",
  render(container, { documents }) {
    container.innerHTML = `
      <div class="kwic-controls">
        <input type="text" id="kwicQuery" placeholder="Search word or phrase…" />
        <button id="kwicSearchBtn" type="button">Search</button>
      </div>
      <div class="kwic-options">
        <label class="checkbox"><input type="checkbox" id="kwicCaseSensitive" /> Case sensitive</label>
        <label class="checkbox"><input type="checkbox" id="kwicWholeWord" /> Whole word</label>
        <label class="checkbox"><input type="checkbox" id="kwicRegex" /> Regex</label>
        <label class="kwic-window">Context (words): <input type="number" id="kwicWindow" min="1" max="20" value="5" /></label>
      </div>
      <div id="kwicStatus" class="hint"></div>
      <div id="kwicResultsWrap" class="kwic-results-wrap hidden">
        <div class="kwic-results-bar">
          <span id="kwicCount"></span>
          <div class="kwic-results-actions">
            <button id="kwicSortLeft" class="secondary" type="button">Sort by left context</button>
            <button id="kwicSortRight" class="secondary" type="button">Sort by right context</button>
            <button id="kwicCopyBtn" class="icon-copy-btn" type="button" title="Copy results as CSV" aria-label="Copy results as CSV">&#128203;</button>
            <button id="kwicSaveCsvBtn" class="icon-copy-btn" type="button" title="Save results as CSV file" aria-label="Save results as CSV file">&#128190;</button>
          </div>
        </div>
        <div class="kwic-table-scroll">
          <table class="kwic-table">
            <thead><tr><th>Source</th><th>Speaker</th><th>Left context</th><th>Keyword</th><th>Right context</th></tr></thead>
            <tbody id="kwicBody"></tbody>
          </table>
        </div>
      </div>
    `;

    let currentResults = [];
    let currentQuery = "";
    const queryInput = container.querySelector("#kwicQuery");
    const statusEl = container.querySelector("#kwicStatus");
    const resultsWrap = container.querySelector("#kwicResultsWrap");
    const bodyEl = container.querySelector("#kwicBody");
    const countEl = container.querySelector("#kwicCount");
    const copyBtn = container.querySelector("#kwicCopyBtn");
    const saveCsvBtn = container.querySelector("#kwicSaveCsvBtn");

    function resultsCsvText() {
      return buildCsvText(
        ["source", "speaker", "left", "keyword", "right"],
        currentResults.map((r) => [r.source, r.speaker, r.left, r.keyword, r.right]),
      );
    }

    function renderRows(results) {
      bodyEl.innerHTML = "";
      const limited = results.slice(0, MAX_RENDERED_ROWS);
      for (const r of limited) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="kwic-source" title="${escapeHtml(r.source)}">${escapeHtml(r.source)}</td>
          <td>${escapeHtml(r.speaker)}</td>
          <td class="kwic-left" title="${escapeHtml(r.left)}">${escapeHtml(r.left)}</td>
          <td class="kwic-keyword">${escapeHtml(r.keyword)}</td>
          <td class="kwic-right" title="${escapeHtml(r.right)}">${escapeHtml(r.right)}</td>
        `;
        bodyEl.appendChild(tr);
      }
      countEl.textContent = results.length > limited.length
        ? `${results.length} matches (showing first ${limited.length})`
        : `${results.length} match${results.length === 1 ? "" : "es"}`;
    }

    function runSearch() {
      const query = queryInput.value.trim();
      currentResults = [];
      if (!query) {
        statusEl.textContent = "Enter a word or phrase to search for.";
        resultsWrap.classList.add("hidden");
        return;
      }
      if (!documents.length) {
        statusEl.textContent = "No text loaded — pick data files on the left.";
        resultsWrap.classList.add("hidden");
        return;
      }
      const options = {
        caseSensitive: container.querySelector("#kwicCaseSensitive").checked,
        wholeWord: container.querySelector("#kwicWholeWord").checked,
        regex: container.querySelector("#kwicRegex").checked,
        windowSize: Math.min(20, Math.max(1, parseInt(container.querySelector("#kwicWindow").value, 10) || 5)),
      };
      try {
        currentResults = search(documents, query, options);
      } catch (e) {
        statusEl.textContent = `Invalid pattern: ${e && e.message ? e.message : e}`;
        resultsWrap.classList.add("hidden");
        return;
      }
      currentQuery = query;
      statusEl.textContent = "";
      resultsWrap.classList.remove("hidden");
      renderRows(currentResults);
    }

    container.querySelector("#kwicSearchBtn").addEventListener("click", runSearch);
    queryInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
    container.querySelector("#kwicSortLeft").addEventListener("click", () => {
      currentResults = [...currentResults].sort((a, b) => a.left.localeCompare(b.left));
      renderRows(currentResults);
    });
    container.querySelector("#kwicSortRight").addEventListener("click", () => {
      currentResults = [...currentResults].sort((a, b) => a.right.localeCompare(b.right));
      renderRows(currentResults);
    });
    copyBtn.addEventListener("click", async () => {
      if (!currentResults.length) return;
      try {
        await navigator.clipboard.writeText(resultsCsvText());
        copyBtn.classList.add("copied");
        setTimeout(() => copyBtn.classList.remove("copied"), 1500);
      } catch (e) {
        console.warn("Could not copy concordance results to clipboard:", e);
      }
    });
    saveCsvBtn.addEventListener("click", () => {
      if (!currentResults.length) return;
      downloadCsv(`concordance-${slugify(currentQuery)}.csv`, resultsCsvText());
    });

    statusEl.textContent = documents.length
      ? `${documents.length} line(s) loaded. Enter a word or phrase to search for.`
      : "No text loaded — pick data files on the left.";
  },
};
