const API_URL_KEY = 'continuum-chat.api-url';
const LEGACY_API_URL_KEY = 'github-personal-assistant.api-url';
export const API_URL_CHANGE_EVENT = 'continuum-chat:api-url-change';

declare global {
  interface Window {
    __CONTINUUM_DEFAULT_API_URL__?: string;
  }
}

const canUseStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const notifyApiUrlChanged = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(API_URL_CHANGE_EVENT));
  }
};

export const getDefaultApiUrl = () => {
  if (typeof window !== 'undefined') {
    const configuredDefault = window.__CONTINUUM_DEFAULT_API_URL__?.trim();
    if (configuredDefault) {
      return configuredDefault.replace(/\/+$/, '');
    }

    const { hostname, port, protocol, origin } = window.location;
    if (protocol === 'http:' || protocol === 'https:') {
      if ((hostname === 'localhost' || hostname === '127.0.0.1') && port !== '4000') {
        return 'http://127.0.0.1:4000';
      }

      return origin.replace(/\/+$/, '');
    }

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://127.0.0.1:4000';
    }

    if (hostname.endsWith('.ts.net') && protocol === 'https:') {
      return `${protocol}//${hostname}`;
    }
  }

  return 'http://127.0.0.1:4000';
};

export const getApiUrlOverride = async () => {
  if (!canUseStorage()) {
    return null;
  }

  const current = window.localStorage.getItem(API_URL_KEY);
  if (current) {
    return current;
  }

  const legacy = window.localStorage.getItem(LEGACY_API_URL_KEY);
  if (legacy) {
    window.localStorage.setItem(API_URL_KEY, legacy);
    window.localStorage.removeItem(LEGACY_API_URL_KEY);
    return legacy;
  }

  return null;
};
export const setApiUrlOverride = async (value: string) => {
  if (canUseStorage()) {
    window.localStorage.setItem(API_URL_KEY, value);
    window.localStorage.removeItem(LEGACY_API_URL_KEY);
    notifyApiUrlChanged();
  }
};
export const clearApiUrlOverride = async () => {
  if (canUseStorage()) {
    window.localStorage.removeItem(API_URL_KEY);
    window.localStorage.removeItem(LEGACY_API_URL_KEY);
    notifyApiUrlChanged();
  }
};
export const resolveApiUrl = async () => (await getApiUrlOverride()) || getDefaultApiUrl();
