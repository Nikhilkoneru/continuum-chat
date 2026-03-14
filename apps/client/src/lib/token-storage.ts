import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const SESSION_KEY = 'github-personal-assistant.session-token';

export const tokenStorage = {
  async get() {
    if (Platform.OS === 'web') {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(SESSION_KEY);
    }

    return SecureStore.getItemAsync(SESSION_KEY);
  },
  async set(value: string) {
    if (Platform.OS === 'web') {
      window.localStorage.setItem(SESSION_KEY, value);
      return;
    }

    await SecureStore.setItemAsync(SESSION_KEY, value);
  },
  async clear() {
    if (Platform.OS === 'web') {
      window.localStorage.removeItem(SESSION_KEY);
      return;
    }

    await SecureStore.deleteItemAsync(SESSION_KEY);
  },
};
