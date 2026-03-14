import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

const loadEnv = () => {
  let currentDir = process.cwd();

  while (true) {
    const envPath = path.join(currentDir, '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return envPath;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
};

loadEnv();

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseNumber(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? '*',
  copilotCliUrl: process.env.COPILOT_CLI_URL,
  copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN,
  defaultModel: process.env.DEFAULT_MODEL ?? 'gpt-5-mini',
  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  githubCallbackUrl: process.env.GITHUB_CALLBACK_URL,
};

export const isCopilotConfigured = () =>
  Boolean(env.copilotCliUrl || env.copilotGithubToken);

export const canUseCopilot = (githubToken?: string) =>
  Boolean(githubToken || env.copilotCliUrl || env.copilotGithubToken);

export const isDeviceOAuthConfigured = () =>
  Boolean(env.githubClientId);

export const isOAuthConfigured = () =>
  Boolean(env.githubClientId && env.githubClientSecret && env.githubCallbackUrl);
