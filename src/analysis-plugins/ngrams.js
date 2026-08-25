// N-gram analysis: extract contiguous word sequences and rank them by
// frequency, following the n-gram half of the LADAL collocations tutorial
// (https://ladal.edu.au/tutorials/collocations/collocations.html) and its
// companion collocation_analyser notebook — kept to plain JS, no R/Python.
//
// For bigrams specifically, also reports two association measures from that
// notebook: Mutual Information and t-score. Its third measure, "log-ratio",
// is defined there as log2((O/N)/(E/N)) — which is algebraically identical
// to log2(O/E), the same number as MI — so it isn't reproduced as a
// separate column.

const MAX_RENDERED_ROWS = 2000;

// A short, standard list of English function words — enough to filter the
// "the of a" noise out of a frequency list, not an exhaustive resource.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "in", "on",
  "at", "to", "for", "with", "without", "by", "from", "up", "down", "out",
  "off", "over", "under", "again", "further", "is", "am", "are", "was",
  "were", "be", "been", "being", "do", "does", "did", "doing", "have", "has",
  "had", "having", "this", "that", "these", "those", "it", "its", "as", "so",
  "than", "too", "very", "can", "will", "just", "don", "should", "now", "i",
  "you", "he", "she", "we", "they", "them", "his", "her", "their", "our",
  "your", "my", "me", "him", "us", "not", "no", "nor", "only", "own", "same",
  "such", "both", "each", "few", "more", "most", "other", "some", "any",
  "all", "there", "here", "when", "where", "why", "how", "what", "which",
  "who", "whom",
]);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function csvField(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Words only — letters/digits with an optional internal apostrophe for
// contractions and possessives ("don't", "darwin's") — punctuation is
// dropped rather than kept as its own token.
function tokenize(text, caseSensitive) {
  const matches = String(text || "").match(/[A-Za-z0-9]+(?:'[A-Za-z]+)?/g) || [];
  return caseSensitive ? matches : matches.map((t) => t.toLowerCase());
}

function containsStopword(ngram) {
  return ngram.split(" ").some((w) => STOPWORDS.has(w.toLowerCase()));
}

// Counts every n-gram and (regardless of n) every unigram across the corpus
// — unigram counts and the total token count are what the bigram-only MI/
// t-score measures need. N-grams never span two documents: each doc.text is
// its own utterance/row/line, so a window only ever slides within one.
function countNgrams(documents, { n, caseSensitive }) {
  const counts = new Map();
  const unigramCounts = new Map();
  let totalUnigrams = 0;
  for (const doc of documents) {
    const tokens = tokenize(doc.text, caseSensitive);
    for (const t of tokens) {
      unigramCounts.set(t, (unigramCounts.get(t) || 0) + 1);
      totalUnigrams++;
    }
    for (let i = 0; i + n <= tokens.length; i++) {
      const key = tokens.slice(i, i + n).join(" ");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return { counts, unigramCounts, totalUnigrams };
}

// Exported for testing. options: { n, caseSensitive, removeStopwords, minFreq }.
export function analyzeNgrams(documents, options) {
  const { n, removeStopwords, minFreq } = options;
  const { counts, unigramCounts, totalUnigrams } = countNgrams(documents, options);

  const rows = [];
  for (const [ngram, count] of counts) {
    if (count < minFreq) continue;
    if (removeStopwords && containsStopword(ngram)) continue;
    const row = { ngram, count };
    if (n === 2) {
      const [w1, w2] = ngram.split(" ");
      const f1 = unigramCounts.get(w1) || 0;
      const f2 = unigramCounts.get(w2) || 0;
      const expected = totalUnigrams > 0 ? (f1 * f2) / totalUnigrams : 0;
      row.mi = expected > 0 ? Math.log2(count / expected) : null;
      row.tScore = (count - expected) / Math.sqrt(Math.max(count, 1));
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

function fmtScore(value) {
  return value === null || value === undefined ? "" : value.toFixed(2);
}

export const ngramsPlugin = {
  id: "ngrams",
  name: "N-gram Analysis",
  description: "Extract and rank frequent word sequences (bigrams, trigrams, ...); bigrams also get MI and t-score.",
  render(container, { documents }) {
    container.innerHTML = `
      <div class="ngram-controls">
        <label>N-gram size: <input type="number" id="ngramN" min="1" max="5" value="2" /></label>
        <label>Min frequency: <input type="number" id="ngramMinFreq" min="1" value="2" /></label>
        <button id="ngramAnalyzeBtn" type="button">Analyze</button>
      </div>
      <div class="ngram-options">
        <label class="checkbox"><input type="checkbox" id="ngramCaseSensitive" /> Case sensitive</label>
        <label class="checkbox"><input type="checkbox" id="ngramRemoveStopwords" checked /> Remove stopwords</label>
        <input type="text" id="ngramFilter" placeholder="Filter results…" />
      </div>
      <div id="ngramStatus" class="hint"></div>
      <div id="ngramResultsWrap" class="ngram-results-wrap hidden">
        <div class="ngram-results-bar">
          <span id="ngramCount"></span>
          <div class="ngram-results-actions">
            <button id="ngramSortFreq" class="secondary" type="button">Sort by frequency</button>
            <button id="ngramSortMi" class="secondary hidden" type="button">Sort by MI</button>
            <button id="ngramSortT" class="secondary hidden" type="button">Sort by t-score</button>
            <button id="ngramCopyBtn" class="icon-copy-btn" type="button" title="Copy results as CSV" aria-label="Copy results as CSV">&#128203;</button>
          </div>
        </div>
        <div class="ngram-table-scroll">
          <table class="ngram-table">
            <thead id="ngramTableHead"></thead>
            <tbody id="ngramBody"></tbody>
          </table>
        </div>
      </div>
    `;

    let currentRows = [];
    let currentN = 2;
    const statusEl = container.querySelector("#ngramStatus");
    const resultsWrap = container.querySelector("#ngramResultsWrap");
    const headEl = container.querySelector("#ngramTableHead");
    const bodyEl = container.querySelector("#ngramBody");
    const countEl = container.querySelector("#ngramCount");
    const filterInput = container.querySelector("#ngramFilter");
    const sortMiBtn = container.querySelector("#ngramSortMi");
    const sortTBtn = container.querySelector("#ngramSortT");
    const copyBtn = container.querySelector("#ngramCopyBtn");

    function renderRows() {
      const filter = filterInput.value.trim().toLowerCase();
      const filtered = filter ? currentRows.filter((r) => r.ngram.toLowerCase().includes(filter)) : currentRows;
      const limited = filtered.slice(0, MAX_RENDERED_ROWS);

      headEl.innerHTML = currentN === 2
        ? "<tr><th>N-gram</th><th>Frequency</th><th>MI</th><th>t-score</th></tr>"
        : "<tr><th>N-gram</th><th>Frequency</th></tr>";

      bodyEl.innerHTML = "";
      for (const r of limited) {
        const tr = document.createElement("tr");
        tr.innerHTML = currentN === 2
          ? `<td class="ngram-text">${escapeHtml(r.ngram)}</td><td class="ngram-num">${r.count}</td><td class="ngram-num">${fmtScore(r.mi)}</td><td class="ngram-num">${fmtScore(r.tScore)}</td>`
          : `<td class="ngram-text">${escapeHtml(r.ngram)}</td><td class="ngram-num">${r.count}</td>`;
        bodyEl.appendChild(tr);
      }
      countEl.textContent = filtered.length > limited.length
        ? `${filtered.length} unique n-gram(s) (showing first ${limited.length})`
        : `${filtered.length} unique n-gram(s)`;
    }

    function runAnalysis() {
      if (!documents.length) {
        statusEl.textContent = "No text loaded — pick data files on the left.";
        resultsWrap.classList.add("hidden");
        return;
      }
      currentN = Math.min(5, Math.max(1, parseInt(container.querySelector("#ngramN").value, 10) || 2));
      const minFreq = Math.max(1, parseInt(container.querySelector("#ngramMinFreq").value, 10) || 1);
      const options = {
        n: currentN,
        caseSensitive: container.querySelector("#ngramCaseSensitive").checked,
        removeStopwords: container.querySelector("#ngramRemoveStopwords").checked,
        minFreq,
      };
      currentRows = analyzeNgrams(documents, options);
      sortMiBtn.classList.toggle("hidden", currentN !== 2);
      sortTBtn.classList.toggle("hidden", currentN !== 2);
      statusEl.textContent = "";
      resultsWrap.classList.remove("hidden");
      renderRows();
    }

    container.querySelector("#ngramAnalyzeBtn").addEventListener("click", runAnalysis);
    filterInput.addEventListener("input", renderRows);
    container.querySelector("#ngramSortFreq").addEventListener("click", () => {
      currentRows = [...currentRows].sort((a, b) => b.count - a.count);
      renderRows();
    });
    sortMiBtn.addEventListener("click", () => {
      currentRows = [...currentRows].sort((a, b) => (b.mi ?? -Infinity) - (a.mi ?? -Infinity));
      renderRows();
    });
    sortTBtn.addEventListener("click", () => {
      currentRows = [...currentRows].sort((a, b) => b.tScore - a.tScore);
      renderRows();
    });
    copyBtn.addEventListener("click", async () => {
      if (!currentRows.length) return;
      const lines = [currentN === 2 ? "ngram,count,mi,t_score" : "ngram,count"];
      for (const r of currentRows) {
        lines.push(currentN === 2
          ? [r.ngram, r.count, fmtScore(r.mi), fmtScore(r.tScore)].map(csvField).join(",")
          : [r.ngram, r.count].map(csvField).join(","));
      }
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
        copyBtn.classList.add("copied");
        setTimeout(() => copyBtn.classList.remove("copied"), 1500);
      } catch (e) {
        console.warn("Could not copy n-gram results to clipboard:", e);
      }
    });

    statusEl.textContent = documents.length
      ? `${documents.length} line(s) loaded. Click Analyze to extract n-grams.`
      : "No text loaded — pick data files on the left.";
  },
};
