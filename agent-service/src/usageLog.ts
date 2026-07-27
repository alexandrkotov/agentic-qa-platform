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
  }

  const rows = sorted
    .map((e) => {
      const failed = e.inputTokens === 0 && e.outputTokens === 0;
      return `
      <tr${failed ? ' data-failed="true"' : ''}>
        <td>${esc(e.timestamp)}</td>
        <td>${esc(e.operation)}</td>
        <td>${esc(e.provider)}</td>
        <td>${esc(e.model)}</td>
        <td class="num">${e.inputTokens.toLocaleString()}</td>
        <td class="num">${e.outputTokens.toLocaleString()}</td>
        <td class="num">${e.cacheCreationTokens.toLocaleString()}</td>
        <td class="num">${e.cacheReadTokens.toLocaleString()}</td>
        <td class="num">${fmtCost(e.costUsd)}</td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="5">
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
  .toggle { display: inline-flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; color: #8a8f98; cursor: pointer; user-select: none; }
  .switch { position: relative; display: inline-block; flex-shrink: 0; width: 36px; height: 20px; }
  .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .switch-track { position: absolute; inset: 0; background: #2a2e3a; border-radius: 999px; transition: background-color 0.15s ease; }
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
  <div class="subtitle">Auto-refreshes every 5s. ${entries.length} call(s) logged${failedCount > 0 ? ` (${failedCount} failed — errored before any tokens came back, $0, hidden by default)` : ''}.</div>
  <div class="summary">
    <div class="stat"><span class="label">Total calls</span><span class="value">${entries.length}</span></div>
    <div class="stat"><span class="label">Input tokens</span><span class="value">${totalInput.toLocaleString()}</span></div>
    <div class="stat"><span class="label">Output tokens</span><span class="value">${totalOutput.toLocaleString()}</span></div>
    <div class="stat"><span class="label">Cache write</span><span class="value">${totalCacheWrite.toLocaleString()}</span></div>
    <div class="stat"><span class="label">Cache read</span><span class="value">${totalCacheRead.toLocaleString()}</span></div>
    <div class="stat"><span class="label">Total known cost</span><span class="value">$${totalCost.toFixed(4)}</span></div>
  </div>
  ${anyUnknownCost ? '<div class="note">Note: some entries have no cost estimate (e.g. OpenAI calls, or an unpriced model) and are excluded from the total above.</div>' : ''}
  ${
    failedCount > 0
      ? `<div class="controls"><label class="toggle"><span class="switch"><input type="checkbox" id="show-failed"><span class="switch-track"></span></span>Show ${failedCount} failed call${failedCount === 1 ? '' : 's'} (0 tokens, errored before any response)</label></div>`
      : ''
  }
  ${
    entries.length === 0
      ? '<div class="empty">No usage recorded yet.</div>'
      : `<table>
    <thead>
      <tr>
        <th>Timestamp</th><th>Operation</th><th>Provider</th><th>Model</th>
        <th class="num">Input</th><th class="num">Output</th><th class="num">Cache Write</th><th class="num">Cache Read</th><th class="num">Cost</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>`
  }
  <script>
    // Page reloads every 5s (meta refresh above), so the toggle's state has
    // to persist itself via localStorage -- a plain in-memory checked flag
    // would reset back to hidden on every refresh.
    (function () {
      var KEY = 'usage-log-show-failed';
      var checkbox = document.getElementById('show-failed');
      if (!checkbox) return;
      var show = localStorage.getItem(KEY) === '1';
      checkbox.checked = show;
      document.body.classList.toggle('show-failed', show);
      checkbox.addEventListener('change', function () {
        localStorage.setItem(KEY, checkbox.checked ? '1' : '0');
        document.body.classList.toggle('show-failed', checkbox.checked);
      });
    })();
  </script>
</body>
</html>
`;
}
