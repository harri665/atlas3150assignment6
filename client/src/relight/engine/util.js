export const COMPACT_QUERY = '(max-width: 768px), (pointer: coarse)';
export const ROOM_MAX_DPR = 2;

export function isCompact() {
  return window.matchMedia?.(COMPACT_QUERY).matches ?? false;
}

export function webglRequested() {
  return new URLSearchParams(window.location.search).get('relight') === 'webgl';
}

export function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
}

export function midLight({ lo, hi, rmin, rmax }) {
  return { pos: lo.map((v, i) => (v + hi[i]) / 2), radius: (rmin + rmax) / 2 };
}

export function fence(gl) {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) {
        channel.port2.postMessage(0);
        return;
      }
      gl.deleteSync(sync);
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}
