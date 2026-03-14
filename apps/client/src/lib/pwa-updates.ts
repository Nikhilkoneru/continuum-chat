export const PWA_UPDATE_EVENT = 'github-personal-assistant:pwa-update';

let waitingWorker: ServiceWorker | null = null;
let isReloadingForUpdate = false;

const emitPwaUpdate = (available: boolean) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(PWA_UPDATE_EVENT, { detail: { available } }));
};

const rememberWaitingWorker = (worker: ServiceWorker | null | undefined) => {
  if (!worker) {
    return;
  }

  waitingWorker = worker;
  emitPwaUpdate(true);
};

export const registerPwaServiceWorker = () => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (isReloadingForUpdate) {
      return;
    }

    isReloadingForUpdate = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('./service-worker.js')
      .then((registration) => {
        if (registration.waiting) {
          rememberWaitingWorker(registration.waiting);
        }

        registration.addEventListener('updatefound', () => {
          const installingWorker = registration.installing;
          if (!installingWorker) {
            return;
          }

          installingWorker.addEventListener('statechange', () => {
            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
              rememberWaitingWorker(registration.waiting ?? installingWorker);
            }
          });
        });
      })
      .catch(() => undefined);
  });
};

export const applyPwaUpdate = async () => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  if (!waitingWorker) {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration?.waiting) {
      waitingWorker = registration.waiting;
    }
  }

  if (!waitingWorker) {
    return false;
  }

  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  return true;
};
