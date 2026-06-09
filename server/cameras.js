// Agent DVR cameras for the home dashboard.
// Agent DVR runs locally (default http://localhost:8090). It serves an embeddable
// MJPEG stream per camera at /video.mjpg?oids=<oid> and a single JPEG at
// /grab.jpg?oid=<oid>. We never hand the browser the raw localhost URL — the
// server exposes proxy routes (see index.js: /api/cameras/:oid/stream + /snapshot)
// so streams/snapshots also work from a phone on the LAN.
//
// Cameras are AUTO-DISCOVERED from Agent DVR's `command.cgi?cmd=getObjects`
// (objectList entries with typeID === 2 are cameras; their `id` is the oid). The
// config `cameras.list` is used only as a fallback (if discovery fails) and to
// optionally override a camera's display name by oid.
import config from './config.js';

const CAM = config.cameras || {};
const configList = Array.isArray(CAM.list) ? CAM.list : [];
// Hide specific Agent DVR oids (e.g. a leftover test camera) — cameras.exclude.
const excludeSet = new Set((Array.isArray(CAM.exclude) ? CAM.exclude : []).map(String));
const notExcluded = (oid) => !excludeSet.has(String(oid));

let discovered = []; // [{ oid, name }] from Agent DVR
let status = { enabled: false, reachable: false, count: 0, ts: 0 };

export function enabled() {
  return Boolean(CAM.enabled && CAM.host);
}

function host() {
  return CAM.host.replace(/\/$/, '');
}
function authQuery() {
  const { user, pass } = CAM.auth || {};
  if (!user) return '';
  return `&un=${encodeURIComponent(user)}&pwd=${encodeURIComponent(pass || '')}`;
}

// Upstream Agent DVR URLs. SERVER-SIDE ONLY — may contain credentials.
export function upstreamStreamUrl(oid, size) {
  const sz = size || CAM.snapshotSize || '';
  const sizeQ = sz ? `&size=${encodeURIComponent(sz)}` : '';
  return `${host()}/video.mjpg?oids=${encodeURIComponent(oid)}${sizeQ}${authQuery()}`;
}
export function upstreamSnapshotUrl(oid, size) {
  const sz = size || CAM.snapshotSize || '';
  const sizeQ = sz ? `&size=${encodeURIComponent(sz)}` : '';
  return `${host()}/grab.jpg?oid=${encodeURIComponent(oid)}${sizeQ}${authQuery()}`;
}

// Active camera set: discovered cameras (real oids + names from Agent DVR) when
// available, otherwise the config list as a fallback.
function activeCameras() {
  const base = discovered.length ? discovered : configList;
  return base.filter((c) => notExcluded(c.oid)).map((c) => ({ oid: c.oid, name: c.name || `Camera ${c.oid}` }));
}

export function find(oid) {
  return activeCameras().find((c) => String(c.oid) === String(oid)) || null;
}

// Camera metadata for the browser — proxy URLs only, never the credentialed URL.
export function listCameras() {
  if (!enabled()) return [];
  return activeCameras().map((c) => ({
    oid: c.oid,
    name: c.name,
    stream: `/api/cameras/${c.oid}/stream`,
    snapshot: `/api/cameras/${c.oid}/snapshot`,
  }));
}

// One call doubles as reachability probe + camera discovery.
export async function refreshStatus() {
  if (!enabled()) {
    status = { enabled: false, reachable: false, count: 0, ts: Date.now() };
    return status;
  }
  let reachable = false;
  try {
    const r = await fetch(`${host()}/command.cgi?cmd=getObjects${authQuery()}`, {
      signal: AbortSignal.timeout(CAM.timeoutMs || 5000),
    });
    if (r.ok) {
      const j = await r.json();
      const objs = Array.isArray(j.objectList) ? j.objectList : [];
      const cams = objs
        .filter((o) => o.typeID === 2 && notExcluded(o.id)) // typeID 2 = camera, 1 = microphone
        .map((o) => ({ oid: o.id, name: o.name }));
      if (cams.length) discovered = cams;
      reachable = true;
    }
  } catch { reachable = false; }
  status = { enabled: true, reachable, count: activeCameras().length, ts: Date.now() };
  return status;
}

export function getStatus() {
  return status;
}

export default {
  enabled, listCameras, find, upstreamStreamUrl, upstreamSnapshotUrl, refreshStatus, getStatus,
};
