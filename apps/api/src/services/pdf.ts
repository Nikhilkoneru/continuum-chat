import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

const execFileAsync = promisify(execFile);

const PDF_PAGE_TEXT_MIN_ALNUM = 20;
const OCR_RENDER_SCALE = 1.75;
const MAX_CONTEXT_PAGES = 8;
const MAX_CONTEXT_CHARS_PER_PAGE = 1_800;
const MAX_CONTEXT_CHARS = 12_000;

const stopWords = new Set([
  'about',
  'after',
  'again',
  'also',
  'been',
  'being',
  'between',
  'could',
  'from',
  'have',
  'into',
  'just',
  'more',
  'most',
  'only',
  'should',
  'some',
  'than',
  'that',
  'their',
  'them',
  'there',
  'these',
  'they',
  'this',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
  'your',
]);

const genericPromptPatterns = [
  /\bsummar(?:ize|y)\b/i,
  /\boverview\b/i,
  /\bunderstand\b/i,
  /\bexplain\b/i,
  /\bwhat(?:'s| is)\b/i,
  /\bread (?:this|the|attached)\b/i,
];

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

type PdfTextContentLike = {
  items: Array<{ str?: string }>;
};

type PdfViewportLike = {
  width: number;
  height: number;
};

type PdfRenderTaskLike = {
  promise: Promise<void>;
};

type PdfPageLike = {
  getTextContent: () => Promise<PdfTextContentLike>;
  getViewport: (input: { scale: number }) => PdfViewportLike;
  render: (input: {
    canvasContext: unknown;
    viewport: PdfViewportLike;
  }) => PdfRenderTaskLike;
  cleanup?: () => void;
};

type PdfMetadataLike = {
  info?: {
    Title?: string;
  };
};

type PdfDocumentLike = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
  getMetadata?: () => Promise<PdfMetadataLike>;
  cleanup?: () => void;
  destroy?: () => Promise<void>;
};

export type PdfPageExtraction = {
  pageNumber: number;
  text: string;
  source: 'native' | 'ocr';
  charCount: number;
};

export type PdfDocumentContext = {
  extractedAt: string;
  title?: string;
  pageCount: number;
  extraction: 'native' | 'ocr' | 'mixed';
  pages: PdfPageExtraction[];
};

let pdfJsPromise: Promise<PdfJsModule> | null = null;
let tesseractBinaryPromise: Promise<string> | null = null;

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

const alphaNumericCount = (value: string) => (value.match(/[a-z0-9]/gi) ?? []).length;

const hasMeaningfulText = (value: string) => alphaNumericCount(value) >= PDF_PAGE_TEXT_MIN_ALNUM;

const excerptText = (value: string, maxChars: number) => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars).trimEnd()}…`;
};

const loadPdfJs = async () => {
  if (!('DOMMatrix' in globalThis)) {
    Object.assign(globalThis, {
      DOMMatrix,
      ImageData,
      Path2D,
    });
  }

  pdfJsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfJsPromise;
};

const resolveTesseractBinary = async () => {
  if (tesseractBinaryPromise) {
    return tesseractBinaryPromise;
  }

  tesseractBinaryPromise = (async () => {
    const candidates = ['tesseract', '/opt/homebrew/bin/tesseract'];

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version']);
        return candidate;
      } catch {
        continue;
      }
    }

    throw new Error('Tesseract OCR is required for scanned PDFs but was not found on this machine.');
  })();

  return tesseractBinaryPromise;
};

const extractPageText = async (page: PdfPageLike) => {
  const content = await page.getTextContent();
  return normalizeText(content.items.map((item) => item.str ?? '').join(' '));
};

const renderPageToImage = async (page: PdfPageLike, outputPath: string) => {
  const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
  const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  const context = canvas.getContext('2d');

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;

  await fs.writeFile(outputPath, canvas.toBuffer('image/png'));
};

const runOcr = async (imagePath: string) => {
  const tesseractBinary = await resolveTesseractBinary();
  const { stdout } = await execFileAsync(tesseractBinary, [imagePath, 'stdout', '-l', 'eng', '--psm', '3'], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return normalizeText(stdout);
};

const scorePage = (text: string, queryTerms: string[]) => {
  const normalized = text.toLowerCase();

  return queryTerms.reduce((score, term) => {
    const matches = normalized.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    return score + (matches?.length ?? 0);
  }, 0);
};

const getQueryTerms = (query: string) =>
  Array.from(
    new Set(
      query
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g) ?? [],
    ),
  )
    .filter((term) => !stopWords.has(term))
    .slice(0, 14);

const isGenericPrompt = (query: string, queryTerms: string[]) =>
  queryTerms.length < 2 || genericPromptPatterns.some((pattern) => pattern.test(query));

export const extractPdfDocumentContext = async ({
  filePath,
}: {
  filePath: string;
}): Promise<PdfDocumentContext> => {
  const pdfjs = await loadPdfJs();
  const bytes = await fs.readFile(filePath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = (await loadingTask.promise) as unknown as PdfDocumentLike;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpa-pdf-'));

  try {
    const metadata = pdf.getMetadata ? await pdf.getMetadata().catch(() => null) : null;
    const pages: PdfPageExtraction[] = [];
    let nativePageCount = 0;
    let ocrPageCount = 0;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);

      try {
        const nativeText = await extractPageText(page);

        if (hasMeaningfulText(nativeText)) {
          pages.push({
            pageNumber,
            text: nativeText,
            source: 'native',
            charCount: nativeText.length,
          });
          nativePageCount += 1;
          continue;
        }

        const imagePath = path.join(tempDir, `page-${pageNumber}.png`);
        await renderPageToImage(page, imagePath);
        const ocrText = await runOcr(imagePath);

        if (!ocrText && nativeText) {
          pages.push({
            pageNumber,
            text: nativeText,
            source: 'native',
            charCount: nativeText.length,
          });
          nativePageCount += 1;
          continue;
        }

        if (ocrText) {
          pages.push({
            pageNumber,
            text: ocrText,
            source: 'ocr',
            charCount: ocrText.length,
          });
          ocrPageCount += 1;
        }
      } finally {
        page.cleanup?.();
      }
    }

    if (pages.length === 0) {
      throw new Error('The PDF could not be converted into readable text.');
    }

    return {
      extractedAt: new Date().toISOString(),
      title: metadata?.info?.Title ? normalizeText(metadata.info.Title) : undefined,
      pageCount: pdf.numPages,
      extraction:
        nativePageCount > 0 && ocrPageCount > 0 ? 'mixed' : ocrPageCount > 0 ? 'ocr' : 'native',
      pages,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    pdf.cleanup?.();
    await pdf.destroy?.().catch(() => undefined);
    await loadingTask.destroy();
  }
};

export const formatPdfContextForPrompt = ({
  attachmentName,
  context,
  query,
}: {
  attachmentName: string;
  context: PdfDocumentContext;
  query: string;
}) => {
  const queryTerms = getQueryTerms(query);
  const orderedPages = isGenericPrompt(query, queryTerms)
    ? [...context.pages]
    : [...context.pages].sort((left, right) => {
        const scoreDelta = scorePage(right.text, queryTerms) - scorePage(left.text, queryTerms);
        return scoreDelta !== 0 ? scoreDelta : left.pageNumber - right.pageNumber;
      });

  const selectedPages: Array<{
    pageNumber: number;
    source: PdfPageExtraction['source'];
    text: string;
  }> = [];
  let totalChars = 0;

  for (const page of orderedPages) {
    if (!page.text) {
      continue;
    }

    const text = excerptText(page.text, MAX_CONTEXT_CHARS_PER_PAGE);
    const nextTotal = totalChars + text.length;

    if (selectedPages.length > 0 && nextTotal > MAX_CONTEXT_CHARS) {
      break;
    }

    selectedPages.push({
      pageNumber: page.pageNumber,
      source: page.source,
      text,
    });
    totalChars = nextTotal;

    if (selectedPages.length >= MAX_CONTEXT_PAGES) {
      break;
    }
  }

  const pagesForPrompt = selectedPages.length > 0 ? selectedPages : context.pages.slice(0, Math.min(context.pages.length, 3)).map((page) => ({
    pageNumber: page.pageNumber,
    source: page.source,
    text: excerptText(page.text, MAX_CONTEXT_CHARS_PER_PAGE),
  }));

  const omittedPages = Math.max(context.pages.length - pagesForPrompt.length, 0);

  return [
    `PDF attachment: ${attachmentName}`,
    `Page count: ${context.pageCount}`,
    `Extraction: ${context.extraction}`,
    context.title ? `Title: ${context.title}` : null,
    'Use the following locally extracted PDF text as grounding context. Cite page numbers when relevant.',
    ...pagesForPrompt.map(
      (page) => `[Page ${page.pageNumber}${page.source === 'ocr' ? ' | OCR' : ''}]\n${page.text}`,
    ),
    omittedPages > 0
      ? `Only the most relevant ${pagesForPrompt.length} page excerpts are included here; ${omittedPages} other page(s) remain in the source PDF attachment.`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n\n');
};
