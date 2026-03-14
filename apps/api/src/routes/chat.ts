import { Router, type Response } from 'express';
import { z } from 'zod';

import type { ChatRole, ChatStreamEvent } from '@github-personal-assistant/shared';

import { env } from '../config';
import { requireRequestSession } from '../lib/auth';
import { getOrCreateSession } from '../services/copilot';
import { buildKnowledgePromptContext } from '../services/retrieval';
import { buildAttachmentPromptContext, getAttachmentInputs } from '../store/attachment-store';
import { getCopilotPreferences } from '../store/copilot-preferences-store';
import {
  createMessage,
  getThread,
  getThreadDetail,
  linkMessageAttachments,
  renameThreadIfPlaceholder,
  updateMessage,
  updateThreadModel,
  updateThreadSession,
} from '../store/thread-store';
import { getProject } from '../store/project-store';

const router = Router();
const SEND_AND_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

const chatSchema = z.object({
  threadId: z.string().trim().min(1),
  prompt: z.string().trim().min(1).max(8000),
  model: z.string().trim().optional(),
  attachments: z.array(z.string().trim().min(1)).max(5).optional(),
});

const abortSchema = z.object({
  threadId: z.string().trim().min(1),
});

type SessionLike = {
  on: (eventName: string, listener: (event: unknown) => void) => () => void;
  sendAndWait: (input: {
    prompt: string;
    attachments?: Array<{ type: 'file'; path: string; displayName?: string }>;
  }, timeout?: number) => Promise<unknown>;
  abort: () => Promise<void>;
  disconnect: () => Promise<void>;
};

type ActiveSessionEntry = {
  session: SessionLike;
  aborted: boolean;
};

const activeSessions = new Map<string, ActiveSessionEntry>();
const pendingAborts = new Set<string>();

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

const summarizeTitle = (prompt: string) => {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  return singleLine.length > 42 ? `${singleLine.slice(0, 42)}...` : singleLine;
};

const historyToPrompt = (messages: Array<{ role: ChatRole; content: string }>) =>
  messages
    .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');

router.post('/api/chat/abort', async (request, response) => {
  const parsed = abortSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const userSession = requireRequestSession(request, response);
  if (!userSession) {
    return;
  }

  const ownerId = String(userSession.user.id);
  const thread = getThread(ownerId, parsed.data.threadId);
  if (!thread) {
    response.status(404).json({ error: 'Thread not found.' });
    return;
  }

  const entry = activeSessions.get(thread.id);
  if (!entry) {
    pendingAborts.add(thread.id);
    response.json({ aborted: true });
    return;
  }

  entry.aborted = true;
  await entry.session.abort().catch(() => undefined);
  response.json({ aborted: true });
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
  const thread = getThread(ownerId, parsed.data.threadId);
  if (!thread) {
    response.status(404).json({ error: 'Thread not found.' });
    return;
  }

  const project = thread.projectId ? getProject(ownerId, thread.projectId) : null;
  const sessionId = thread.copilotSessionId ?? `thread-${thread.id}`;

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
  let assistantMessageId: string | null = null;

  try {
    const historicalThread = getThreadDetail(ownerId, thread.id);
    const priorMessages = historicalThread ? historicalThread.messages : [];
    const attachmentInputs = parsed.data.attachments && parsed.data.attachments.length > 0 ? await getAttachmentInputs(ownerId, parsed.data.attachments) : [];

    if (parsed.data.attachments && !attachmentInputs) {
      writeEvent(response, { type: 'error', message: 'One or more attachments could not be found.' });
      response.end();
      return;
    }

    const attachmentPromptContext = parsed.data.attachments?.length
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

    const knowledgePromptContext = await buildKnowledgePromptContext({
      ownerId,
      threadId: thread.id,
      query: parsed.data.prompt,
    });

    const enrichedPrompt = [
      parsed.data.prompt,
      knowledgePromptContext
        ? ['Use the following project knowledge retrieved from RagFlow before answering.', knowledgePromptContext].join('\n\n')
        : null,
      attachmentPromptContext
        ? ['Use the following locally extracted attachment context when it helps answer the latest request.', attachmentPromptContext].join('\n\n')
        : null,
    ]
      .filter((section): section is string => Boolean(section))
      .join('\n\n');

    const promptWithHistory = [historyToPrompt(priorMessages), `user: ${enrichedPrompt}`].filter(Boolean).join('\n');

    const userMessageId = createMessage(thread.id, 'user', parsed.data.prompt);
    if (parsed.data.attachments?.length) {
      linkMessageAttachments(userMessageId, parsed.data.attachments);
    }

    assistantMessageId = createMessage(thread.id, 'assistant', '');

    renameThreadIfPlaceholder(thread.id, summarizeTitle(parsed.data.prompt));

    const model = parsed.data.model ?? thread.model ?? project?.defaultModel ?? env.defaultModel;
    updateThreadModel(thread.id, model);
    updateThreadSession(thread.id, sessionId);

    session = (await getOrCreateSession({
      sessionId,
      githubToken: userSession.githubAccessToken,
      ownerId,
      threadId: thread.id,
      model,
      approvalMode: getCopilotPreferences().approvalMode,
      systemMessage: project?.instructions,
    })) as unknown as SessionLike;
    activeSessions.set(thread.id, { session, aborted: false });
    if (pendingAborts.has(thread.id)) {
      pendingAborts.delete(thread.id);
      if (assistantMessageId) {
        updateMessage(assistantMessageId, { content: 'Response stopped.', role: 'error' });
      }
      writeEvent(response, { type: 'aborted', message: 'Response stopped.' });
      return;
    }

    unsubscribeDelta = session.on('assistant.message_delta', (event: unknown) => {
      const delta =
        typeof event === 'object' && event && 'data' in event && typeof (event as { data?: { deltaContent?: string } }).data?.deltaContent === 'string'
          ? (event as { data?: { deltaContent?: string } }).data!.deltaContent!
          : '';

      if (!delta) {
        return;
      }

      streamedContent += delta;
      if (!assistantMessageId) {
        return;
      }
      updateMessage(assistantMessageId, { content: streamedContent });
      writeEvent(response, { type: 'chunk', delta });
    });

    unsubscribeMessage = session.on('assistant.message', (event: unknown) => {
      const content =
        typeof event === 'object' && event && 'data' in event && typeof (event as { data?: { content?: string } }).data?.content === 'string'
          ? (event as { data?: { content?: string } }).data!.content!
          : '';

      if (!content) {
        return;
      }

      streamedContent = content;
      if (!assistantMessageId) {
        return;
      }
      updateMessage(assistantMessageId, { content });
    });

    await session.sendAndWait({ prompt: promptWithHistory, attachments: attachmentInputs ?? [] }, SEND_AND_WAIT_TIMEOUT_MS);
    if (activeSessions.get(thread.id)?.aborted) {
      writeEvent(response, { type: 'aborted', message: 'Response stopped.' });
      return;
    }
    writeEvent(response, { type: 'done' });
  } catch (error) {
    const wasAborted = activeSessions.get(thread.id)?.aborted ?? false;
    if (wasAborted) {
      writeEvent(response, { type: 'aborted', message: 'Response stopped.' });
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown streaming error.';
    if (assistantMessageId) {
      updateMessage(assistantMessageId, { content: message, role: 'error' });
    }
    writeEvent(response, { type: 'error', message });
  } finally {
    activeSessions.delete(thread.id);
    pendingAborts.delete(thread.id);
    unsubscribeDelta?.();
    unsubscribeMessage?.();
    await session?.disconnect().catch(() => undefined);
    response.end();
  }
});

export default router;
