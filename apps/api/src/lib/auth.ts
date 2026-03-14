import type { Request, Response } from 'express';

import { getAppSession } from '../store/auth-store';

const extractBearerToken = (request: Request) => {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }

  const sessionToken = request.headers['x-session-token'];
  if (typeof sessionToken === 'string') {
    return sessionToken;
  }

  return undefined;
};

export const getRequestSession = (request: Request) => getAppSession(extractBearerToken(request));

export const requireRequestSession = (request: Request, response: Response) => {
  const sessionToken = extractBearerToken(request);
  if (!sessionToken) {
    response.status(401).json({ error: 'You must sign in to use this product.' });
    return null;
  }

  const session = getAppSession(sessionToken);
  if (!session) {
    response.status(401).json({ error: 'Your session expired. Please sign in again.' });
    return null;
  }

  return session;
};
