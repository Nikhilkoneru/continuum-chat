import type { CopilotClient, CopilotSession, ResumeSessionConfig, SessionConfig } from '@github/copilot-sdk';
import type { ModelOption } from '@github-personal-assistant/shared';

import { env, canUseCopilot } from '../config';

type CopilotSdkModule = typeof import('@github/copilot-sdk');

const clients = new Map<string, Promise<CopilotClient>>();
let sdkModulePromise: Promise<CopilotSdkModule> | null = null;

const makeKey = (githubToken?: string) => (githubToken ? `user:${githubToken.slice(-12)}` : 'service');

const loadSdkModule = () => {
  sdkModulePromise ??= import('@github/copilot-sdk');
  return sdkModulePromise;
};

export const getCopilotClient = async (githubToken?: string) => {
  const key = makeKey(githubToken);
  const existing = clients.get(key);
  if (existing) {
    return existing;
  }

  const clientPromise = (async () => {
    const { CopilotClient } = await loadSdkModule();
    const client = new CopilotClient({
      ...(env.copilotCliUrl ? { cliUrl: env.copilotCliUrl, useStdio: false } : {}),
      ...(githubToken
        ? { githubToken, useLoggedInUser: false }
        : env.copilotGithubToken
          ? { githubToken: env.copilotGithubToken, useLoggedInUser: false }
          : {}),
    });
    await client.start();
    return client;
  })();

  clients.set(key, clientPromise);

  try {
    return await clientPromise;
  } catch (error) {
    clients.delete(key);
    throw error;
  }
};

type ModelInfoLike = {
  id?: string;
  name?: string;
  capabilities?: {
    supports?: {
      reasoningEffort?: boolean;
    };
  };
};

export const listModels = async (githubToken?: string): Promise<ModelOption[]> => {
  if (!canUseCopilot(githubToken)) {
    throw new Error('Copilot is not configured for this session.');
  }

  const client = await getCopilotClient(githubToken);
  const result = await client.listModels();

  return (result as ModelInfoLike[]).map((model) => ({
    id: model.id ?? model.name ?? 'unknown-model',
    name: model.name ?? model.id ?? 'Unknown model',
    source: 'sdk',
    supportsReasoning: Boolean(model.capabilities?.supports?.reasoningEffort),
  }));
};

export const getOrCreateSession = async ({
  sessionId,
  githubToken,
  model,
  systemMessage,
}: {
  sessionId: string;
  githubToken?: string;
  model: string;
  systemMessage?: string;
}): Promise<CopilotSession> => {
  const [{ approveAll }, client] = await Promise.all([
    loadSdkModule(),
    getCopilotClient(githubToken),
  ]);
  const config: Omit<SessionConfig, 'sessionId'> & ResumeSessionConfig = {
    model,
    streaming: true,
    onPermissionRequest: approveAll,
    ...(systemMessage
      ? {
          systemMessage: {
            mode: 'append',
            content: systemMessage,
          },
        }
      : {}),
  };

  try {
    return await client.resumeSession(sessionId, config);
  } catch {
    return client.createSession({
      sessionId,
      ...config,
    });
  }
};
