let isReloadingForUpdate = false;

const reloadForFreshShell = () => {
  if (typeof window === 'undefined' || isReloadingForUpdate) {
    return;
  }

  isReloadingForUpdate = true;
  window.location.reload();
};

export const registerPwaServiceWorker = () => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  navigator.serviceWorker.addEventListener('controllerchange', reloadForFreshShell);
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'FORCE_RELOAD') {
      reloadForFreshShell();
    }
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./service-worker.js').catch(() => undefined);
  });
};
