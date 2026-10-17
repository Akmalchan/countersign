// Server-side PDF text, using the same line grouping as the browser (site/js/console/extract.js).

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { itemsToLines, joinPdfLines } from '../../site/js/console/extract.js';

// The fields the document checks read from a PDF's info dictionary.
export const META_KEYS = ['Producer', 'Creator', 'CreationDate', 'ModDate'];
export const pickMeta = (info) => Object.fromEntries(META_KEYS.filter((k) => info?.[k]).map((k) => [k, String(info[k]).slice(0, 200)]));

/** Text (same line grouping as the browser) plus the PDF's metadata. */
export async function pdfInfo(buffer, maxPages = 4) {
  const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    lines.push(...itemsToLines((await page.getTextContent()).items));
  }
  const meta = pickMeta((await doc.getMetadata().catch(() => ({})))?.info);
  await doc.destroy();
  return { text: joinPdfLines(lines), meta };
}

export async function pdfText(buffer, maxPages = 4) {
  return (await pdfInfo(buffer, maxPages)).text;
}
