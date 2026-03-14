import crypto from 'node:crypto';

import { Router, type Response } from 'express';
import { z } from 'zod';

import type { ChatStreamEvent } from '@github-personal-assistant/shared';

import { env } from '../config';
import { requireRequestSession } from '../lib/auth';
import { getOrCreateSession } from '../services/copilot';
import { buildAttachmentPromptContext, getAttachmentInputs } from '../store/attachment-store';
import { getProject } from '../store/project-store';

const router = Router();

const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'error']),
  content: z.string(),
});

const chatSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).max(8000),
  model: z.string().trim().optional(),
  sessionId: z.string().trim().optional(),
  attachments: z.array(z.string().trim().min(1)).max(5).optional(),
  history: z.array(historyMessageSchema).optional(),
});

type SessionLike = {
  on: (eventName: string, listener: (event: unknown) => void) => () => void;
  send: (input: {
    prompt: string;
    attachments?: Array<{ type: 'file'; path: string; displayName?: string }>;
  }) => Promise<unknown>;
  disconnect: () => Promise<void>;
};

const flushResponse = (response: Response) => {
  const maybeFlush = (response as Response & { flush?: () => void }).flush;
  if (typeof maybeFlush === 'function') {
    maybeFlush.call(response);
  }
};

const writeEvent = (response: Response, payload: ChatStreamEvent) => {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  flushResponse(response);
};

const waitForIdle = (session: SessionLike) =>
  new Promise<void>((resolve, reject) => {
    const unsubscribeIdle = session.on('session.idle', () => {
      unsubscribeIdle();
      unsubscribeError();
      resolve();
    });

    const unsubscribeError = session.on('session.error', (event: unknown) => {
      unsubscribeIdle();
      unsubscribeError();
      const message =
        typeof event === 'object' && event && 'data' in event && typeof (event as { data?: { message?: string } }).data?.message === 'string'
          ? (event as { data?: { message?: string } }).data!.message!
          : 'Unknown Copilot session error.';
      reject(new Error(message));
    });
  });

router.post('/api/chat/stream', async (request, response) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const userSession = requireRequestSession(request, response);
  if (!userSession) {
    return;
  }

  const ownerId = String(userSession.user.id);
  const project = parsed.data.projectId ? getProject(ownerId, parsed.data.projectId) : null;

  if (parsed.data.projectId && !project) {
    response.status(404).json({ error: 'Project not found.' });
    return;
  }

  const sessionId =
    parsed.data.sessionId ??
    `user-${ownerId}-${project ? `project-${project.id}` : 'chat'}-${Date.now()}`;

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.socket?.setNoDelay(true);
  response.flushHeaders();

  writeEvent(response, { type: 'session', sessionId });

  let session: SessionLike | null = null;
  let unsubscribeDelta: (() => void) | null = null;
  let unsubscribeMessage: (() => void) | null = null;
  let streamedContent = '';

  try {
    const attachments =
      parsed.data.attachments && parsed.data.attachments.length > 0
        ? await getAttachmentInputs(ownerId, parsed.data.attachments)
        : [];

    if (parsed.data.attachments && !attachments) {
      writeEvent(response, { type: 'error', message: 'One or more attachments could not be found.' });
      response.end();
      return;
    }

    const attachmentPromptContext =
      parsed.data.attachments && parsed.data.attachments.length > 0
        ? await buildAttachmentPromptContext({
            ownerId,
            attachmentIds: parsed.data.attachments,
            query: parsed.data.prompt,
          })
        : '';

    if (parsed.data.attachments && attachmentPromptContext === null) {
      writeEvent(response, { type: 'error', message: 'One or more attachments could not be found.' });
      response.end();
      return;
    }

    const enrichedPrompt = attachmentPromptContext
      ? [
          parsed.data.prompt,
          'The attached PDF files were preprocessed locally. Use the extracted page text below as grounding context, and cite page numbers when they support your answer.',
          attachmentPromptContext,
        ].join('\n\n')
      : parsed.data.prompt;

    const promptWithHistory = [
      ...(parsed.data.history ?? []).map((message) => `${message.role}: ${message.content}`),
      `user: ${enrichedPrompt}`,
    ].join('\n');

    session = (await getOrCreateSession({
      sessionId,
      githubToken: userSession.githubAccessToken,
      model: parsed.data.model ?? project?.defaultModel ?? env.defaultModel,
      systemMessage: project?.instructions,
    })) as unknown as SessionLike;

    unsubscribeDelta = session.on('assistant.message_delta', (event: unknown) => {
      const delta =
        typeof event === 'object' && event && 'data' in event && typeof (event as { data?: { deltaContent?: string } }).data?.deltaContent === 'string'
          ? (event as { data?: { deltaContent?: string } }).data!.deltaContent!
          : '';

      if (delta) {
        streamedContent += delta;
        writeEvent(response, { type: 'chunk', delta });
      }
    });

    unsubscribeMessage = session.on('assistant.message', (event: unknown) => {
      const content =
        typeof event === 'object' && event && 'data' in event && typeof (event as { data?: { content?: string } }).data?.content === 'string'
          ? (event as { data?: { content?: string } }).data!.content!
          : '';

      if (!content) {
        return;
      }

      const remainingContent =
        streamedContent && content.startsWith(streamedContent)
          ? content.slice(streamedContent.length)
          : !streamedContent
            ? content
            : '';

      if (remainingContent) {
        streamedContent += remainingContent;
        writeEvent(response, { type: 'chunk', delta: remainingContent });
      }
    });

    await session.send({ prompt: promptWithHistory, attachments: attachments ?? [] });
    await waitForIdle(session);
    writeEvent(response, { type: 'done' });
  } catch (error) {
    writeEvent(response, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown streaming error.',
    });
  } finally {
    unsubscribeDelta?.();
    unsubscribeMessage?.();
    await session?.disconnect().catch(() => undefined);
    response.end();
  }
});

export default router;
