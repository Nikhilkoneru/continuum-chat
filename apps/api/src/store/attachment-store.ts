import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AttachmentKind, AttachmentSummary } from '@github-personal-assistant/shared';

import {
  extractPdfDocumentContext,
  formatPdfContextForPrompt,
  type PdfDocumentContext,
} from '../services/pdf';

type StoredAttachment = AttachmentSummary & {
  ownerId: string;
  filePath: string;
  pdfContextFilePath?: string;
  pdfContext?: {
    extractedAt: string;
    pageCount: number;
    extraction: PdfDocumentContext['extraction'];
    title?: string;
  };
};

const attachmentCache = new Map<string, StoredAttachment>();

const mediaRoot = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'github-personal-assistant',
  'media',
);

const sanitizeName = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'attachment';

const getAttachmentKind = (mimeType: string): AttachmentKind => {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }

  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  if (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml')
  ) {
    return 'document';
  }

  return 'other';
};

const ownerDirectory = (ownerId: string) => path.join(mediaRoot, ownerId);
const manifestPath = (ownerId: string, attachmentId: string) =>
  path.join(ownerDirectory(ownerId), `${attachmentId}.json`);
const pdfContextPath = (ownerId: string, attachmentId: string) =>
  path.join(ownerDirectory(ownerId), `${attachmentId}.pdf-context.json`);

const toSummary = (attachment: StoredAttachment): AttachmentSummary => ({
  id: attachment.id,
  name: attachment.name,
  mimeType: attachment.mimeType,
  size: attachment.size,
  kind: attachment.kind,
  uploadedAt: attachment.uploadedAt,
});

const loadAttachment = async (ownerId: string, attachmentId: string) => {
  const cached = attachmentCache.get(attachmentId);
  if (cached && cached.ownerId === ownerId) {
    return cached;
  }

  try {
    const raw = await fs.readFile(manifestPath(ownerId, attachmentId), 'utf8');
    const parsed = JSON.parse(raw) as StoredAttachment;
    attachmentCache.set(parsed.id, parsed);
    return parsed;
  } catch {
    return null;
  }
};

const persistAttachment = async (attachment: StoredAttachment) => {
  await fs.writeFile(manifestPath(attachment.ownerId, attachment.id), JSON.stringify(attachment, null, 2), 'utf8');
  attachmentCache.set(attachment.id, attachment);
};

const ensurePdfContext = async (attachment: StoredAttachment) => {
  if (attachment.mimeType !== 'application/pdf') {
    return null;
  }

  if (attachment.pdfContextFilePath) {
    try {
      const raw = await fs.readFile(attachment.pdfContextFilePath, 'utf8');
      return JSON.parse(raw) as PdfDocumentContext;
    } catch {
      // Fall through and rebuild the derived context from the source PDF.
    }
  }

  const context = await extractPdfDocumentContext({
    filePath: attachment.filePath,
  });
  const contextFilePath = attachment.pdfContextFilePath ?? pdfContextPath(attachment.ownerId, attachment.id);

  await fs.writeFile(contextFilePath, JSON.stringify(context, null, 2), 'utf8');

  attachment.pdfContextFilePath = contextFilePath;
  attachment.pdfContext = {
    extractedAt: context.extractedAt,
    pageCount: context.pageCount,
    extraction: context.extraction,
    title: context.title,
  };

  await persistAttachment(attachment);
  return context;
};

export const saveAttachment = async ({
  ownerId,
  originalName,
  mimeType,
  bytes,
}: {
  ownerId: string;
  originalName: string;
  mimeType: string;
  bytes: Buffer;
}) => {
  const attachmentId = crypto.randomUUID();
  const uploadedAt = new Date().toISOString();
  const ownerDir = ownerDirectory(ownerId);
  const storedFileName = `${attachmentId}-${sanitizeName(originalName)}`;
  const filePath = path.join(ownerDir, storedFileName);
  const attachmentManifestPath = manifestPath(ownerId, attachmentId);
  const attachmentPdfContextPath = pdfContextPath(ownerId, attachmentId);

  await fs.mkdir(ownerDir, { recursive: true });
  await fs.writeFile(filePath, bytes);

  const attachment: StoredAttachment = {
    id: attachmentId,
    ownerId,
    name: originalName,
    mimeType,
    size: bytes.byteLength,
    kind: getAttachmentKind(mimeType),
    uploadedAt,
    filePath,
  };

  try {
    if (mimeType === 'application/pdf') {
      const context = await extractPdfDocumentContext({
        filePath,
      });

      await fs.writeFile(attachmentPdfContextPath, JSON.stringify(context, null, 2), 'utf8');
      attachment.pdfContextFilePath = attachmentPdfContextPath;
      attachment.pdfContext = {
        extractedAt: context.extractedAt,
        pageCount: context.pageCount,
        extraction: context.extraction,
        title: context.title,
      };
    }

    await fs.writeFile(attachmentManifestPath, JSON.stringify(attachment, null, 2), 'utf8');
    attachmentCache.set(attachment.id, attachment);
    return toSummary(attachment);
  } catch (error) {
    attachmentCache.delete(attachment.id);
    await Promise.allSettled([
      fs.rm(filePath, { force: true }),
      fs.rm(attachmentManifestPath, { force: true }),
      fs.rm(attachmentPdfContextPath, { force: true }),
    ]);
    throw error;
  }
};

export const getAttachmentSummaries = async (ownerId: string, attachmentIds: string[]) => {
  const attachments = await Promise.all(attachmentIds.map((attachmentId) => loadAttachment(ownerId, attachmentId)));
  return attachments.filter((attachment): attachment is StoredAttachment => Boolean(attachment)).map(toSummary);
};

export const getAttachmentInputs = async (ownerId: string, attachmentIds: string[]) => {
  const attachments = await Promise.all(attachmentIds.map((attachmentId) => loadAttachment(ownerId, attachmentId)));

  if (attachments.some((attachment) => !attachment)) {
    return null;
  }

  const resolvedAttachments = attachments as StoredAttachment[];

  return resolvedAttachments.map((attachment) => ({
    type: 'file' as const,
    path: attachment.filePath,
    displayName: attachment.name,
  }));
};

export const buildAttachmentPromptContext = async ({
  ownerId,
  attachmentIds,
  query,
}: {
  ownerId: string;
  attachmentIds: string[];
  query: string;
}) => {
  const attachments = await Promise.all(attachmentIds.map((attachmentId) => loadAttachment(ownerId, attachmentId)));
  const resolvedAttachments = attachments.filter((attachment): attachment is StoredAttachment => Boolean(attachment));

  if (resolvedAttachments.length !== attachmentIds.length) {
    return null;
  }

  const pdfContexts = await Promise.all(
    resolvedAttachments
      .filter((attachment) => attachment.mimeType === 'application/pdf')
      .map(async (attachment) => {
        const context = await ensurePdfContext(attachment);
        return context
          ? formatPdfContextForPrompt({
              attachmentName: attachment.name,
              context,
              query,
            })
          : null;
      }),
  );

  const promptSections = pdfContexts.filter((section): section is string => Boolean(section));
  return promptSections.length > 0 ? promptSections.join('\n\n---\n\n') : '';
};
