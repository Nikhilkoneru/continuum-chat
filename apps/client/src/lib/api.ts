import Constants from 'expo-constants';

import type {
  AttachmentSummary,
  ApiHealth,
  ChatStreamInput,
  ChatStreamEvent,
  GitHubDeviceAuthPoll,
  GitHubDeviceAuthStart,
  ModelOption,
  ProjectDetail,
  ProjectSummary,
  UserSession,
} from '@github-personal-assistant/shared';

const defaultApiUrl = Constants.expoConfig?.hostUri
  ? `http://${Constants.expoConfig.hostUri.split(':')[0]}:4000`
  : 'http://localhost:4000';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? defaultApiUrl;

const buildUrl = (path: string) => `${API_URL}${path}`;

const parseErrorMessage = (raw: string, status: number) => {
  if (!raw) {
    return `Request failed with status ${status}`;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Fall back to the raw response body.
  }

  return raw;
};

const parseNetworkError = (error: unknown) => {
  if (error instanceof Error) {
    if (error.message === 'Failed to fetch') {
      return 'The API is unavailable right now. Start the backend and try again.';
    }

    return error.message;
  }

  return 'The API is unavailable right now. Start the backend and try again.';
};

let unauthorizedHandler: (() => void | Promise<void>) | null = null;

export const registerUnauthorizedHandler = (handler: (() => void | Promise<void>) | null) => {
  unauthorizedHandler = handler;
};

const notifyUnauthorized = () => {
  void unauthorizedHandler?.();
};

export const fetchJson = async <T>(path: string, options?: RequestInit, sessionToken?: string): Promise<T> => {
  let response: Response;

  try {
    response = await fetch(buildUrl(path), {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        ...(options?.headers ?? {}),
      },
    });
  } catch (error) {
    throw new Error(parseNetworkError(error));
  }

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 && sessionToken) {
      notifyUnauthorized();
    }
    throw new Error(parseErrorMessage(text, response.status));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};

export const getHealth = () => fetchJson<ApiHealth>('/api/health');

export const getProjects = (sessionToken?: string) =>
  fetchJson<{ projects: ProjectSummary[] }>('/api/projects', undefined, sessionToken);

export const getProject = (projectId: string, sessionToken?: string) =>
  fetchJson<{ project: ProjectDetail }>(`/api/projects/${projectId}`, undefined, sessionToken);

export const createProject = (payload: { name: string; description?: string }, sessionToken?: string) =>
  fetchJson<{ project: ProjectDetail }>(
    '/api/projects',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    sessionToken,
  );

export const getModels = (sessionToken?: string) =>
  fetchJson<{ models: ModelOption[] }>('/api/models', undefined, sessionToken);

export const getGitHubAuthUrl = (redirectUri: string) =>
  fetchJson<{ authorizeUrl: string }>(`/api/auth/github/url?redirectUri=${encodeURIComponent(redirectUri)}`);

export const startGitHubDeviceAuth = () =>
  fetchJson<GitHubDeviceAuthStart>('/api/auth/github/device/start', {
    method: 'POST',
  });

export const pollGitHubDeviceAuth = (flowId: string) =>
  fetchJson<GitHubDeviceAuthPoll>(`/api/auth/github/device/${encodeURIComponent(flowId)}`);

export const getSession = (sessionToken: string) =>
  fetchJson<{ session: UserSession | null }>('/api/auth/session', undefined, sessionToken);

export const logout = (sessionToken: string) =>
  fetchJson<void>(
    '/api/auth/logout',
    {
      method: 'POST',
    },
    sessionToken,
  );

type UploadableAttachment = {
  uri: string;
  name: string;
  mimeType?: string;
  file?: File;
};

export const uploadAttachment = async (attachment: UploadableAttachment, sessionToken: string) => {
  const body = new FormData();

  if (attachment.file) {
    body.append('file', attachment.file, attachment.name);
  } else {
    body.append('file', {
      uri: attachment.uri,
      name: attachment.name,
      type: attachment.mimeType ?? 'application/octet-stream',
    } as unknown as Blob);
  }

  let response: Response;

  try {
    response = await fetch(buildUrl('/api/attachments'), {
      method: 'POST',
      headers: {
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body,
    });
  } catch (error) {
    throw new Error(parseNetworkError(error));
  }

  if (!response.ok) {
    if (response.status === 401 && sessionToken) {
      notifyUnauthorized();
    }

    throw new Error(parseErrorMessage(await response.text(), response.status));
  }

  return response.json() as Promise<{ attachment: AttachmentSummary }>;
};

export async function streamChat(
  input: ChatStreamInput,
  sessionToken: string | undefined,
  onEvent: (event: ChatStreamEvent) => void,
) {
  let response: Response;

  try {
    response = await fetch(buildUrl('/api/chat/stream'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new Error(parseNetworkError(error));
  }

  if (!response.ok) {
    if (response.status === 401 && sessionToken) {
      notifyUnauthorized();
    }
    throw new Error(parseErrorMessage(await response.text(), response.status));
  }

  if (!response.body || !('getReader' in response.body)) {
    throw new Error('This runtime does not support streaming fetch responses yet.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = rawEvent
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('data: '));

      if (dataLine) {
        onEvent(JSON.parse(dataLine.slice(6)) as ChatStreamEvent);
      }

      boundary = buffer.indexOf('\n\n');
    }
  }
}
