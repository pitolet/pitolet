import { api } from './api.js';

type ClientEvent = Parameters<typeof api.event>[0];

export function trackProductEvent(event: ClientEvent, dedupeKey?: string): void {
  const storageKey = dedupeKey ? `pitolet.event.${dedupeKey}` : null;
  if (storageKey) {
    try {
      if (window.sessionStorage.getItem(storageKey)) return;
      window.sessionStorage.setItem(storageKey, '1');
    } catch {
      // A blocked storage API should not prevent the app from working.
    }
  }

  void api.event(event).catch(() => {
    // Product analytics must never interrupt the user's work.
  });
}
