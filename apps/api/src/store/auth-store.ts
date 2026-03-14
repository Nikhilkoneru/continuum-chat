import crypto from 'node:crypto';

import type {
  AppSessionUser,
  GitHubDeviceAuthPoll,
  GitHubDeviceAuthStart,
  UserSession,
} from '@github-personal-assistant/shared';

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type PendingState = {
  createdAt: number;
  redirectUri?: string;
};

type StoredSession = UserSession & {
  githubAccessToken: string;
  createdAt: number;
};

type DeviceAuthStatus = 'pending' | 'complete' | 'denied' | 'expired';

type PendingDeviceAuth = GitHubDeviceAuthStart & {
  createdAt: number;
  deviceCode: string;
  expiresAtMs: number;
  nextPollAt: number;
  status: DeviceAuthStatus;
  session?: UserSession;
  error?: string;
};

const pendingStates = new Map<string, PendingState>();
const sessions = new Map<string, StoredSession>();
const pendingDeviceAuths = new Map<string, PendingDeviceAuth>();

const prune = () => {
  const now = Date.now();

  for (const [state, value] of pendingStates.entries()) {
    if (now - value.createdAt > STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }

  for (const [token, value] of sessions.entries()) {
    if (now - value.createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
    }
  }

  for (const [flowId, value] of pendingDeviceAuths.entries()) {
    if (value.status === 'pending' && now >= value.expiresAtMs) {
      pendingDeviceAuths.set(flowId, {
        ...value,
        status: 'expired',
        error: 'GitHub device code expired. Start sign-in again.',
      });
      continue;
    }

    if (now - value.createdAt > STATE_TTL_MS) {
      pendingDeviceAuths.delete(flowId);
    }
  }
};

export const createOAuthState = (redirectUri?: string) => {
  prune();
  const state = crypto.randomUUID();
  pendingStates.set(state, { createdAt: Date.now(), redirectUri });
  return state;
};

export const consumeOAuthState = (state: string) => {
  prune();
  const value = pendingStates.get(state);
  pendingStates.delete(state);
  return value;
};

export const createAppSession = (githubAccessToken: string, user: AppSessionUser): UserSession => {
  prune();
  const sessionToken = crypto.randomUUID();
  sessions.set(sessionToken, {
    sessionToken,
    user,
    githubAccessToken,
    createdAt: Date.now(),
  });
  return { sessionToken, user };
};

export const getAppSession = (sessionToken: string | undefined) => {
  if (!sessionToken) return null;
  prune();
  return sessions.get(sessionToken) ?? null;
};

export const destroyAppSession = (sessionToken: string | undefined) => {
  if (!sessionToken) return;
  sessions.delete(sessionToken);
};

export const createDeviceAuth = (input: {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}): GitHubDeviceAuthStart => {
  prune();
  const flowId = crypto.randomUUID();
  const expiresAtMs = Date.now() + input.expiresIn * 1000;
  const deviceAuth: PendingDeviceAuth = {
    flowId,
    userCode: input.userCode,
    verificationUri: input.verificationUri,
    verificationUriComplete: input.verificationUriComplete,
    expiresAt: new Date(expiresAtMs).toISOString(),
    interval: input.interval,
    createdAt: Date.now(),
    deviceCode: input.deviceCode,
    expiresAtMs,
    nextPollAt: Date.now() + input.interval * 1000,
    status: 'pending',
  };

  pendingDeviceAuths.set(flowId, deviceAuth);
  return {
    flowId: deviceAuth.flowId,
    userCode: deviceAuth.userCode,
    verificationUri: deviceAuth.verificationUri,
    verificationUriComplete: deviceAuth.verificationUriComplete,
    expiresAt: deviceAuth.expiresAt,
    interval: deviceAuth.interval,
  };
};

export const getDeviceAuthRecord = (flowId: string) => {
  prune();
  return pendingDeviceAuths.get(flowId) ?? null;
};

export const scheduleDeviceAuthPoll = (flowId: string, interval?: number) => {
  const deviceAuth = getDeviceAuthRecord(flowId);
  if (!deviceAuth || deviceAuth.status !== 'pending') return null;

  if (interval) {
    deviceAuth.interval = interval;
  }

  deviceAuth.nextPollAt = Date.now() + deviceAuth.interval * 1000;
  return deviceAuth;
};

export const completeDeviceAuth = (flowId: string, session: UserSession) => {
  const deviceAuth = getDeviceAuthRecord(flowId);
  if (!deviceAuth) return null;

  deviceAuth.status = 'complete';
  deviceAuth.session = session;
  deviceAuth.error = undefined;
  return deviceAuth;
};

export const failDeviceAuth = (flowId: string, status: Extract<DeviceAuthStatus, 'denied' | 'expired'>, error: string) => {
  const deviceAuth = getDeviceAuthRecord(flowId);
  if (!deviceAuth) return null;

  deviceAuth.status = status;
  deviceAuth.error = error;
  return deviceAuth;
};

export const getDeviceAuthPollPayload = (flowId: string): GitHubDeviceAuthPoll | null => {
  const deviceAuth = getDeviceAuthRecord(flowId);
  if (!deviceAuth) return null;

  if (deviceAuth.status === 'complete' && deviceAuth.session) {
    return {
      status: 'complete',
      session: deviceAuth.session,
    };
  }

  if (deviceAuth.status === 'pending') {
    return {
      status: 'pending',
      flowId: deviceAuth.flowId,
      userCode: deviceAuth.userCode,
      verificationUri: deviceAuth.verificationUri,
      verificationUriComplete: deviceAuth.verificationUriComplete,
      expiresAt: deviceAuth.expiresAt,
      interval: deviceAuth.interval,
    };
  }

  return {
    status: deviceAuth.status === 'denied' ? 'denied' : 'expired',
    error: deviceAuth.error ?? 'GitHub device authorization ended unexpectedly.',
  };
};
