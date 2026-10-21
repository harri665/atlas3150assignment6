import { useSyncExternalStore } from 'react';

let snapshot = { phase: 'idle' };
let snapshotKey = JSON.stringify(snapshot);
const listeners = new Set();

export function setRelightStatus(next) {
  const nextKey = JSON.stringify(next);
  if (nextKey === snapshotKey) {
    return;
  }
  snapshot = next;
  snapshotKey = nextKey;
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

export function useRelightStatus() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
