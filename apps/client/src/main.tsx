import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './app.js';
import { registerPwaServiceWorker } from './lib/pwa-updates.js';
import { AuthProvider } from './providers/auth-provider.js';

registerPwaServiceWorker();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found.');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
