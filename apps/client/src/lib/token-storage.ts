const SESSION_PREFIX = 'continuum-chat.session-token';
const LEGACY_SESSION_PREFIX = 'github-personal-assistant.session-token';

const canUseStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const toOriginKey = (apiUrl: string) => {
  try {
    return new URL(apiUrl).origin;
  } catch {
    return apiUrl;
  }
};

const buildSessionKey = (prefix: string, apiUrl: string, authMode: string, authVersion: string) =>
  `${prefix}:${toOriginKey(apiUrl)}:${authMode}:${authVersion}`;

export const tokenStorage = {
  async get(apiUrl: string, authMode: string, authVersion: string) {
    if (!canUseStorage()) {
      return null;
    }

    const currentKey = buildSessionKey(SESSION_PREFIX, apiUrl, authMode, authVersion);
    const current = window.localStorage.getItem(currentKey);
    if (current) {
      return current;
    }

    const legacyKey = buildSessionKey(LEGACY_SESSION_PREFIX, apiUrl, authMode, authVersion);
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy) {
      window.localStorage.setItem(currentKey, legacy);
      window.localStorage.removeItem(legacyKey);
      return legacy;
    }

    return null;
  },
  async set(apiUrl: string, authMode: string, authVersion: string, value: string) {
    if (canUseStorage()) {
      window.localStorage.setItem(buildSessionKey(SESSION_PREFIX, apiUrl, authMode, authVersion), value);
      window.localStorage.removeItem(buildSessionKey(LEGACY_SESSION_PREFIX, apiUrl, authMode, authVersion));
    }
  },
  async clear(apiUrl: string, authMode: string, authVersion: string) {
    if (canUseStorage()) {
      window.localStorage.removeItem(buildSessionKey(SESSION_PREFIX, apiUrl, authMode, authVersion));
      window.localStorage.removeItem(buildSessionKey(LEGACY_SESSION_PREFIX, apiUrl, authMode, authVersion));
    }
  },
};
