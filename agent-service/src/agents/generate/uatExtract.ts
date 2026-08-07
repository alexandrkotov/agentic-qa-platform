import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Pure text-extraction helpers for UAT artifacts — no filesystem or HTTP
// concerns of their own (those live in admin/server.ts's routes, which hand
// this module a Buffer or a URL and do nothing else with the result besides
// return it to the browser for human review). Every path here only ever
// PRODUCES text; nothing in this file writes to disk — see uat.ts for the
// one function (saveUatContext) that actually persists, called separately
// once a human has reviewed/edited what came out of here.
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.pdf', '.docx', '.xlsx', '.xls'];

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export async function extractTextFromFile(buffer: Buffer, filename: string): Promise<string> {
  const ext = extensionOf(filename);

  switch (ext) {
    case '.txt':
    case '.md':
    case '.markdown':
      return buffer.toString('utf-8');

    case '.pdf': {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return result.text;
      } finally {
        await parser.destroy();
      }
    }

    case '.docx': {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    case '.xlsx':
    case '.xls': {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      return workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        return `## Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`;
      }).join('\n\n');
    }

    default:
      throw Object.assign(
        new Error(`Unsupported file type "${ext || '(no extension)'}" — supported: ${SUPPORTED_EXTENSIONS.join(', ')}`),
        { status: 400 },
      );
  }
}

const GOOGLE_DOC_ID_PATTERN = /docs\.google\.com\/document\/d\/([^/]+)/;
const GOOGLE_SHEET_ID_PATTERN = /docs\.google\.com\/spreadsheets\/d\/([^/]+)/;

/**
 * Fetches a Google Doc/Sheet's own public export endpoint — works ONLY for
 * documents shared "Anyone with the link can view"; there is no OAuth here,
 * deliberately (see the plan this shipped from). A private document doesn't
 * 403 cleanly — Google redirects to an HTML login page instead, which would
 * otherwise silently "succeed" with garbage text, so this checks the
 * response's content-type against what the export format actually promises,
 * not just the HTTP status.
 */
export async function extractTextFromGoogleUrl(url: string): Promise<string> {
  const docMatch = url.match(GOOGLE_DOC_ID_PATTERN);
  const sheetMatch = url.match(GOOGLE_SHEET_ID_PATTERN);

  if (!docMatch && !sheetMatch) {
    throw Object.assign(
      new Error('URL must be a docs.google.com/document/... or docs.google.com/spreadsheets/... link'),
      { status: 400 },
    );
  }

  const [id, format, expectedContentType] = docMatch
    ? [docMatch[1], 'txt', 'text/plain']
    : [sheetMatch![1], 'csv', 'text/csv'];
  const exportUrl = docMatch
    ? `https://docs.google.com/document/d/${id}/export?format=${format}`
    : `https://docs.google.com/spreadsheets/d/${id}/export?format=${format}`;

  const res = await fetch(exportUrl);
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes(expectedContentType)) {
    throw Object.assign(
      new Error(
        'Could not fetch this document\'s content — make sure it\'s shared "Anyone with the link can view" (Google redirects private documents to a sign-in page instead of returning an error).',
      ),
      { status: 400 },
    );
  }

  return res.text();
}
