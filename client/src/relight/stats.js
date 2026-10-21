
const API = 'https://harrison-martin.com/api';
const PAGE = 'atlas3150-assignment6';

// the visit's log id, or null if the server can't be reached
const visit = fetch(`${API}/load?page=${PAGE}`)
  .then((response) => response.json())
  .then((data) => data.id || null)
  .catch(() => null);

// sent as text so sendBeacon can go cross-origin without a preflight, and still sends on close
export function sendRelightReport(report) {
  visit.then((id) => {
    if (!id) {
      return;
    }
    const body = JSON.stringify({ ...report, id, kind: 'relight' });
    const url = `${API}/load/report`;
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

let notified = false;

// only the first report of a page view, not the one sent again as the page goes
export function notifyDiscord(report) {
  if (notified) {
    return;
  }
  notified = true;
  fetch(`${API}/discord/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: summary(report) }),
  }).catch(() => {});
}

function summary(r) {
  const head = 'Relight (ATLS 3150 page): ';
  if (r.phase === 'failed') {
    return `${head}failed: ${r.reason} (${r.gpu || 'unknown GPU'}, ${r.screen})`;
  }
  return (
    `${head}${r.backend} on ${r.gpu || 'unknown GPU'}, ${r.size}px ${r.network}, ` +
    `${r.frameRate ?? '?'} fps, ${r.latePct ?? '?'}% late, ${r.runningSec ?? '?'}s, ` +
    `${r.cores} cores, ${r.screen}`
  );
}
