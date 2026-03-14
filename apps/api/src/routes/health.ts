import { Router } from 'express';
import type { ApiHealth } from '@github-personal-assistant/shared';

import { isCopilotConfigured, isDeviceOAuthConfigured } from '../config';

const router = Router();

router.get('/api/health', (_request, response) => {
  const payload: ApiHealth = {
    status: 'ok',
    copilotConfigured: isCopilotConfigured(),
    authConfigured: isDeviceOAuthConfigured(),
  };

  response.json(payload);
});

export default router;
