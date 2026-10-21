import { apiUrl } from './api';

let current = Promise.resolve(null);

export function setVisit(idPromise) {
  current = idPromise.catch(() => null);
}

export function visitId() {
  return current;
}

// sent as text so sendBeacon can go cross-origin without a preflight, and still sends on close
export function sendReport(kind, data, idPromise = current) {
  idPromise.then((id) => {
    if (!id) {
      return;
    }
    const body = JSON.stringify({ ...data, id, kind });
    const url = apiUrl('/load/report');
    try {
      if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) {
        return;
      }
    } catch {
      // fall back to fetch
    }
    fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
  });
}
