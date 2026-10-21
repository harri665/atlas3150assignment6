import { apiUrl } from './api';

let notified = false;

// only the first report of a page view, not the one sent again as the page goes
export function notifyDiscord(report) {
  if (notified) {
    return;
  }
  notified = true;
  fetch(apiUrl('/discord/dm'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: summary(report) }),
    keepalive: true,
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
