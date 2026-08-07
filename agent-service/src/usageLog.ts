import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.ts';

export interface UsageLogEntry {
  timestamp: string;
  operation: string;
  provider: 'claude' | 'openai';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  /** Which target system's descriptor this call was for (e.g. "orderflow"), null if unknown/not applicable (e.g. a CLI call that never resolved one). Powers the usage report's descriptor filter. */
  descriptor: string | null;
}

const LOG_PATH = join(config.reportsDir, 'usage-log.jsonl');
const HTML_DIR = join(config.reportsDir, 'usage-html');
const HTML_PATH = join(HTML_DIR, 'index.html');

/**
 * Append one usage entry and re-render the HTML report. Observability
 * only — must NEVER throw, so a logging failure can never crash the
 * discovery/generate/diagnose run that produced this entry.
 */
export async function recordUsage(entry: UsageLogEntry): Promise<void> {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.warn(`[usageLog] Failed to append usage entry: ${(err as Error).message}`);
    // Fall through anyway — still try to re-render from whatever's already
    // on disk, so one failed append doesn't freeze the dashboard.
  }

  await regenerateUsageHtml();
}

/**
 * Re-renders the HTML report from whatever's currently in the log file,
 * without appending anything. Exported so a one-off migration (e.g.
 * backfilling costUsd for entries logged before a model was added to
 * pricing.ts) can refresh the report after editing the log directly,
 * instead of duplicating the render logic.
 */
export async function regenerateUsageHtml(): Promise<void> {
  try {
    const entries = await readAllEntries();
    const html = renderHtml(entries);
    await mkdir(HTML_DIR, { recursive: true });
    await writeFile(HTML_PATH, html, 'utf-8');
  } catch (err) {
    console.warn(`[usageLog] Failed to render usage report: ${(err as Error).message}`);
  }
}

async function readAllEntries(): Promise<UsageLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(LOG_PATH, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // no calls logged yet
    throw err;
  }

  const entries: UsageLogEntry[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as UsageLogEntry);
    } catch {
      console.warn(`[usageLog] Skipping corrupted line ${i + 1} in ${LOG_PATH}`);
    }
  }
  return entries;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtCost(cost: number | null): string {
  return cost === null ? '—' : `$${cost.toFixed(4)}`;
}

function renderHtml(entries: UsageLogEntry[]): string {
  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let anyUnknownCost = false;
  let failedCount = 0;
  let anyCacheUsage = false;
  for (const e of entries) {
    totalInput += e.inputTokens;
    totalOutput += e.outputTokens;
    totalCacheWrite += e.cacheCreationTokens;
    totalCacheRead += e.cacheReadTokens;
    if (e.costUsd === null) anyUnknownCost = true;
    else totalCost += e.costUsd;
    // 0 input + 0 output only happens when the API call errored before any
    // response came back (recordUsage runs in a `finally`, so a failed call
    // still gets logged) -- never a real, billed call. Used to hide these
    // by default, since they're not interesting for "what did this cost".
    if (e.inputTokens === 0 && e.outputTokens === 0) failedCount++;
    if (e.cacheCreationTokens > 0 || e.cacheReadTokens > 0) anyCacheUsage = true;
  }

  // Cache write/read only ever show non-zero once prompt caching is actually
  // wired up (a `cache_control` breakpoint on a request) -- neither provider
  // sets one today, so these columns would otherwise be all zeros, always.
  // Hidden until an entry actually has cache activity, not deleted outright,
  // so they reappear on their own the day that changes.

  // Distinct descriptor labels actually present, for the filter <select>'s
  // options — sorted for a stable dropdown order, independent of how the
  // underlying log happens to be ordered. typeof-checked, not `!== null`:
  // log lines written before this field existed have no "descriptor" key at
  // all, so JSON.parse gives `undefined` there, not `null` — a `!== null`
  // filter would let `undefined` straight through into esc(), which throws
  // on a non-string (confirmed live against this repo's own real log file).
  const descriptors = [...new Set(entries.map((e) => e.descriptor).filter((d): d is string => typeof d === 'string'))].sort();

  const rows = sorted
    .map((e) => {
      const failed = e.inputTokens === 0 && e.outputTokens === 0;
      const cacheCells = anyCacheUsage
        ? `
        <td class="num">${e.cacheCreationTokens.toLocaleString()}</td>
        <td class="num">${e.cacheReadTokens.toLocaleString()}</td>`
        : '';
      return `
      <tr${failed ? ' data-failed="true"' : ''} data-descriptor="${esc(e.descriptor ?? '')}" data-timestamp="${esc(e.timestamp)}" data-input="${e.inputTokens}" data-output="${e.outputTokens}" data-cost="${e.costUsd ?? ''}">
        <td>${esc(e.timestamp)}</td>
        <td>${esc(e.operation)}</td>
        <td>${esc(e.provider)}</td>
        <td>${esc(e.model)}</td>
        <td class="num">${e.inputTokens.toLocaleString()}</td>
        <td class="num">${e.outputTokens.toLocaleString()}</td>${cacheCells}
        <td class="num">${fmtCost(e.costUsd)}</td>
      </tr>`;
    })
    .join('');

  const subtitleHtml = `Live — updates every 5s without reloading the page. ${entries.length} call(s) logged${failedCount > 0 ? ` (${failedCount} failed — errored before any tokens came back, $0, hidden by default)` : ''}.`;

  const summaryHtml = `<div class="stat"><span class="label">Total calls</span><span class="value">${entries.length}</span></div>
    <div class="stat"><span class="label">Input tokens</span><span class="value">${totalInput.toLocaleString()}</span></div>
    <div class="stat"><span class="label">Output tokens</span><span class="value">${totalOutput.toLocaleString()}</span></div>
    ${
      anyCacheUsage
        ? `<div class="stat"><span class="label">Cache write</span><span class="value">${totalCacheWrite.toLocaleString()}</span></div>
    <div class="stat"><span class="label">Cache read</span><span class="value">${totalCacheRead.toLocaleString()}</span></div>`
        : ''
    }
    <div class="stat"><span class="label">Total known cost</span><span class="value">$${totalCost.toFixed(4)}</span></div>`;

  const noteHtml = anyUnknownCost
    ? '<div class="note">Note: some entries have no cost estimate (e.g. OpenAI calls, or an unpriced model) and are excluded from the total above.</div>'
    : '';

  const descriptorOptionsHtml = descriptors.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  const failedToggleHtml =
    failedCount > 0
      ? `<label class="toggle"><span class="switch"><input type="checkbox" id="show-failed"><span class="switch-track"></span></span>Show ${failedCount} failed call${failedCount === 1 ? '' : 's'} (0 tokens, errored before any response)</label>`
      : '';
  const filterHtml =
    entries.length === 0
      ? ''
      : `<div class="filters">
    <label class="filter-field">Descriptor
      <select id="filter-descriptor"><option value="">All descriptors</option>${descriptorOptionsHtml}</select>
    </label>
    <label class="filter-field">From <input type="date" id="filter-from"></label>
    <label class="filter-field">To <input type="date" id="filter-to"></label>
  </div>`;
  const controlsHtml = filterHtml + failedToggleHtml;

  const resultsHtml =
    entries.length === 0
      ? '<div class="empty">No usage recorded yet.</div>'
      : `<table>
    <thead>
      <tr>
        <th>Timestamp</th><th>Operation</th><th>Provider</th><th>Model</th>
        <th class="num">Input</th><th class="num">Output</th>${anyCacheUsage ? '<th class="num">Cache Write</th><th class="num">Cache Read</th>' : ''}<th class="num">Cost</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Agent Service — AI Usage Log</title>
<style>
  :root { color-scheme: dark; }
  body { background:#12141a; color:#e4e6eb; font-family: system-ui, sans-serif; margin: 2rem; }
  h1 { font-size: 1.3rem; margin-bottom: 0.25rem; }
  .subtitle { color:#8a8f98; font-size:0.85rem; margin-bottom:1.5rem; }
  .summary { display:flex; gap:2rem; flex-wrap:wrap; background:#1b1e27; border:1px solid #2a2e3a; border-radius:8px; padding:1rem 1.5rem; margin-bottom:1.5rem; }
  .summary .stat { display:flex; flex-direction:column; }
  .summary .stat .label { font-size:0.75rem; color:#8a8f98; text-transform:uppercase; letter-spacing:0.03em; }
  .summary .stat .value { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size:1.15rem; margin-top:0.15rem; }
  .note { color:#d4a72c; font-size:0.8rem; margin-top:0.5rem; }
  .controls { margin-bottom: 1rem; }
  .filters { display: flex; flex-wrap: wrap; gap: 1.2rem; margin-bottom: 0.75rem; }
  .filter-field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.75rem; color: #8a8f98; text-transform: uppercase; letter-spacing: 0.03em; }
  .filter-field select, .filter-field input[type="date"] {
    font: inherit; text-transform: none; letter-spacing: normal; color: #e4e6eb;
    background: #1b1e27; border: 1px solid #2a2e3a; border-radius: 6px; padding: 0.35rem 0.5rem;
  }
  tr.filtered-out { display: none !important; }
  .toggle { display: inline-flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; color: #8a8f98; cursor: pointer; user-select: none; }
  .switch { position: relative; display: inline-block; flex-shrink: 0; width: 36px; height: 20px; }
  .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; z-index: 1; }
  .switch-track { position: absolute; inset: 0; z-index: 0; background: #2a2e3a; border-radius: 999px; transition: background-color 0.15s ease; }
  .switch-track::before {
    content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
    background: #e4e6eb; border-radius: 50%; transition: transform 0.15s ease;
  }
  .switch input:checked + .switch-track { background: #5b8cff; }
  .switch input:checked + .switch-track::before { transform: translateX(16px); }
  .switch input:focus-visible + .switch-track { outline: 2px solid #5b8cff; outline-offset: 2px; }
  table { border-collapse: collapse; width:100%; font-size:0.85rem; }
  th, td { padding: 0.4rem 0.7rem; border-bottom: 1px solid #262a35; text-align:left; }
  th { color:#8a8f98; font-weight:600; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.03em; }
  td.num, th.num { font-family: ui-monospace, "SF Mono", Consolas, monospace; text-align:right; }
  tr:hover td { background:#1b1e27; }
  tr[data-failed="true"] { display: none; }
  body.show-failed tr[data-failed="true"] { display: table-row; }
  .empty { color:#8a8f98; padding:2rem 0; }
</style>
</head>
<body>
  <h1>Agent Service — AI Usage Log</h1>
  <div class="subtitle" id="subtitle">${subtitleHtml}</div>
  <div class="summary" id="summary">${summaryHtml}</div>
  <div id="note">${noteHtml}</div>
  <div class="controls" id="controls">${controlsHtml}</div>
  <div id="results">${resultsHtml}</div>
  <script>
    // No meta-refresh / full reload -- fetches this same page every 5s and
    // patches just the regions that can change, so the toggle below (and
    // anything else with live DOM state) survives an update instead of
    // needing localStorage just to get through a reload.
    (function () {
      var SHOW_FAILED_KEY = 'usage-log-show-failed';
      var DESCRIPTOR_KEY = 'usage-log-filter-descriptor';
      var FROM_KEY = 'usage-log-filter-from';
      var TO_KEY = 'usage-log-filter-to';

      // Snapshot of #summary's own last server-rendered content (plain
      // grand totals), refreshed every time applyFilters() runs (page load,
      // and after every 5s poll's swap()) — restored verbatim the moment a
      // filter is cleared, rather than leaving the stale filtered view up
      // to 5s stale until the next poll happens to swap it away.
      var originalSummaryHtml = '';

      // Re-applies row visibility for the descriptor/date filters — needs
      // its own pass separate from the failed-calls toggle (that one's
      // handled by a body class + CSS attribute selector) because it
      // depends on comparing each row's own data attributes against the
      // filter controls' current values.
      function filterRows() {
        var descriptorSel = document.getElementById('filter-descriptor');
        var fromInput = document.getElementById('filter-from');
        var toInput = document.getElementById('filter-to');
        var descriptor = descriptorSel ? descriptorSel.value : '';
        var from = fromInput ? fromInput.value : '';
        var to = toInput ? toInput.value : '';
        var rows = document.querySelectorAll('#results tr[data-timestamp]');
        rows.forEach(function (row) {
          var matches = true;
          if (descriptor && row.getAttribute('data-descriptor') !== descriptor) matches = false;
          var date = (row.getAttribute('data-timestamp') || '').slice(0, 10); // YYYY-MM-DD prefix of an ISO 8601 timestamp
          if (from && date < from) matches = false;
          if (to && date > to) matches = false;
          row.classList.toggle('filtered-out', !matches);
        });
        updateSummaryForFilter();
      }

      // Reuses the same #summary box a filter-free page already shows,
      // rather than a second block next to it — one place to look, not two
      // that could disagree. Left alone (still whatever the server just
      // rendered — grand totals across every entry, unaffected by the
      // failed-calls toggle, same as always) unless the descriptor/date
      // filters are actually engaged; only then does it switch to a
      // "Showing N of M" view computed from what's currently visible
      // (which — in this mode only — does also take the failed-calls
      // toggle into account, since the whole point is "what am I looking
      // at right now"). Every 5s poll swap puts the plain server-rendered
      // version back first (see swap()/poll() below), so clearing the
      // filters later needs no separate "restore" path — filterRows()
      // simply stops overwriting it once nothing is engaged, and it's the
      // very state that came off the wire.
      function updateSummaryForFilter() {
        var container = document.getElementById('summary');
        if (!container) return;
        var descriptorSel = document.getElementById('filter-descriptor');
        var fromInput = document.getElementById('filter-from');
        var toInput = document.getElementById('filter-to');
        var filterEngaged = (descriptorSel && descriptorSel.value) || (fromInput && fromInput.value) || (toInput && toInput.value);
        if (!filterEngaged) {
          if (originalSummaryHtml) container.innerHTML = originalSummaryHtml;
          return;
        }

        var showFailed = document.body.classList.contains('show-failed');
        var rows = document.querySelectorAll('#results tr[data-timestamp]');
        var total = rows.length;
        var visible = 0, input = 0, output = 0, cost = 0;
        rows.forEach(function (row) {
          var isFailed = row.hasAttribute('data-failed');
          if (isFailed && !showFailed) return;
          if (row.classList.contains('filtered-out')) return;
          visible++;
          input += Number(row.getAttribute('data-input')) || 0;
          output += Number(row.getAttribute('data-output')) || 0;
          var costAttr = row.getAttribute('data-cost');
          if (costAttr) cost += Number(costAttr);
        });
        container.innerHTML =
          '<div class="stat"><span class="label">Showing</span><span class="value">' + visible + ' of ' + total + '</span></div>' +
          '<div class="stat"><span class="label">Input tokens</span><span class="value">' + input.toLocaleString() + '</span></div>' +
          '<div class="stat"><span class="label">Output tokens</span><span class="value">' + output.toLocaleString() + '</span></div>' +
          '<div class="stat"><span class="label">Known cost</span><span class="value">$' + cost.toFixed(4) + '</span></div>';
      }

      // Re-attaches listeners and restores saved values every time this
      // runs, not just once — #controls' entire innerHTML (including these
      // very elements) gets replaced wholesale on every 5s poll swap below,
      // so any listener/value from a previous pass is gone along with it.
      function applyFilters() {
        var summaryEl = document.getElementById('summary');
        if (summaryEl) originalSummaryHtml = summaryEl.innerHTML;

        var checkbox = document.getElementById('show-failed');
        if (checkbox) {
          var show = localStorage.getItem(SHOW_FAILED_KEY) === '1';
          checkbox.checked = show;
          document.body.classList.toggle('show-failed', show);
          checkbox.addEventListener('change', function () {
            localStorage.setItem(SHOW_FAILED_KEY, checkbox.checked ? '1' : '0');
            document.body.classList.toggle('show-failed', checkbox.checked);
            updateSummaryForFilter();
          });
        }

        var descriptorSel = document.getElementById('filter-descriptor');
        if (descriptorSel) {
          descriptorSel.value = localStorage.getItem(DESCRIPTOR_KEY) || '';
          descriptorSel.addEventListener('change', function () {
            localStorage.setItem(DESCRIPTOR_KEY, descriptorSel.value);
            filterRows();
          });
        }
        var fromInput = document.getElementById('filter-from');
        if (fromInput) {
          fromInput.value = localStorage.getItem(FROM_KEY) || '';
          fromInput.addEventListener('input', function () {
            localStorage.setItem(FROM_KEY, fromInput.value);
            filterRows();
          });
        }
        var toInput = document.getElementById('filter-to');
        if (toInput) {
          toInput.value = localStorage.getItem(TO_KEY) || '';
          toInput.addEventListener('input', function () {
            localStorage.setItem(TO_KEY, toInput.value);
            filterRows();
          });
        }

        filterRows();
      }

      function swap(id, doc) {
        var live = document.getElementById(id);
        var fresh = doc.getElementById(id);
        if (live && fresh) live.innerHTML = fresh.innerHTML;
      }

      async function poll() {
        try {
          var res = await fetch(window.location.href, { cache: 'no-store' });
          var html = await res.text();
          var doc = new DOMParser().parseFromString(html, 'text/html');
          ['subtitle', 'summary', 'note', 'controls', 'results'].forEach(function (id) {
            swap(id, doc);
          });
          applyFilters();
        } catch (err) {
          console.warn('[usage-log] refresh failed', err);
        }
        setTimeout(poll, 5000);
      }

      applyFilters();
      setTimeout(poll, 5000);
    })();
  </script>
</body>
</html>
`;
}
