import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { info, warn, progress, progressDone } from "./log.js";

/** HEAD an export URL. Returns {ok, size} without downloading. */
export async function probe(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow" });
    return { ok: r.ok, status: r.status, size: Number(r.headers.get("content-length")) || 0 };
  } catch (e) {
    return { ok: false, status: 0, size: 0, error: String(e) };
  }
}

let current = null;           // AbortController of the transfer in progress
let interrupted = false;

/** Ctrl-C support: abort the running transfer; the .part file is kept for the next run. */
export function abortDownloads() { interrupted = true; current?.abort(); }

/**
 * Stream `url` to `target`, resuming from `<target>.part` if it exists.
 * Aborts when no bytes arrive for `stallMs`. The export URLs need no cookies.
 */
export async function httpDownload(url, target, { onProgress, stallMs = 60000 } = {}) {
  const part = target + ".part";
  let offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const ctrl = new AbortController();
  current = ctrl;
  let stall = setTimeout(() => ctrl.abort(new Error(`no data for ${stallMs / 1000}s`)), stallMs);
  const touch = () => { clearTimeout(stall); stall = setTimeout(() => ctrl.abort(new Error(`no data for ${stallMs / 1000}s`)), stallMs); };
  try {
    const headers = offset ? { Range: `bytes=${offset}-` } : {};
    const res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
    if (res.status === 416) { fs.rmSync(part, { force: true }); offset = 0; throw Object.assign(new Error("range not satisfiable, restarting"), { retry: true }); }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retry: res.status >= 500 || res.status === 429 });
    if (offset && res.status !== 206) { offset = 0; fs.rmSync(part, { force: true }); }
    // Resume sanity: the server must continue exactly where our file ends.
    if (res.status === 206) {
      const m = /bytes (\d+)-\d+\/(\d+)/.exec(res.headers.get("content-range") || "");
      if (!m || Number(m[1]) !== offset) { fs.rmSync(part, { force: true }); throw Object.assign(new Error("server resumed at a different offset, restarting"), { retry: true }); }
    }
    const total = offset + (Number(res.headers.get("content-length")) || 0);
    let received = offset, lastLog = Date.now(), lastBytes = offset;
    const out = fs.createWriteStream(part, { flags: offset ? "a" : "w" });
    const src = Readable.fromWeb(res.body);
    src.on("data", (chunk) => {
      received += chunk.length; touch();
      const dt = Date.now() - lastLog;
      if (onProgress && dt > 1000) { onProgress(received, total, ((received - lastBytes) * 1000) / dt); lastLog = Date.now(); lastBytes = received; }
    });
    await pipeline(src, out);
    onProgress?.(received, total, 0, true);
    const size = fs.statSync(part).size;
    if (total && size !== total) throw Object.assign(new Error(`incomplete: ${size} of ${total} bytes`), { retry: true });
    return { part, size, resumedFrom: offset };
  } catch (e) {
    onProgress?.(0, 0, 0, true);
    if (interrupted) throw Object.assign(new Error("interrupted; partial file kept, the next run resumes it"), { interrupted: true });
    const cause = e?.name === "AbortError" ? (ctrl.signal.reason?.message || "aborted") : (e.cause?.message || e.message);
    throw Object.assign(new Error(cause), { retry: e.retry ?? !e.status, status: e.status });
  } finally { clearTimeout(stall); current = null; }
}

/** Header check: classic TIFF (42) or BigTIFF (43) in either byte order. Aperio SVS is one of these. */
export function tiffKind(file) {
  const fd = fs.openSync(file, "r");
  const h = Buffer.alloc(4);
  fs.readSync(fd, h, 0, 4, 0);
  fs.closeSync(fd);
  const bo = h.toString("latin1", 0, 2);
  const magic = bo === "II" ? h.readUInt16LE(2) : bo === "MM" ? h.readUInt16BE(2) : 0;
  return magic === 42 ? "TIFF" : magic === 43 ? "BigTIFF" : null;
}

/** Verify a file on disk. `expectedSize` of 0 means unknown. */
export function verifyFile(file, expectedSize = 0) {
  if (!fs.existsSync(file)) return { ok: false, reason: "missing" };
  const size = fs.statSync(file).size;
  if (expectedSize && size !== expectedSize) return { ok: false, reason: `size ${size} != ${expectedSize}`, size };
  const kind = tiffKind(file);
  if (!kind) return { ok: false, reason: "not a TIFF/SVS header", size };
  return { ok: true, size, kind };
}

export function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim() || "unnamed";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download + verify + atomic move into `dest`, with retries that resume the partial file.
 * Network errors, stalls and 5xx are retried after `delays`; 403/404 ask `refreshUrl()`
 * for a fresh export URL once. Returns the final path.
 */
export async function fetchExport(url, dest, name, expectedSize = 0, { refreshUrl, delays = [10000, 30000, 90000], stallMs } = {}) {
  const target = path.join(dest, safeName(name));
  const existing = verifyFile(target, expectedSize);
  if (existing.ok) return { file: target, size: existing.size, kind: existing.kind, skipped: true };
  let refreshed = false, attempt = 0;
  for (;;) {
    // A partial file bigger than the server's file means the export changed: start over.
    const part = target + ".part";
    if (fs.existsSync(part) && expectedSize && fs.statSync(part).size > expectedSize) fs.rmSync(part, { force: true });
    try {
      const dl = await httpDownload(url, target, { stallMs, onProgress: (got, total, speed, done) => (done ? progressDone() : progress(name, got, total, speed)) });
      const v = verifyFile(dl.part, expectedSize);
      if (!v.ok) { fs.rmSync(dl.part, { force: true }); throw Object.assign(new Error(`verification failed: ${v.reason}`), { retry: true }); }
      fs.renameSync(dl.part, target);
      return { file: target, size: v.size, kind: v.kind, skipped: false, attempts: attempt + 1 };
    } catch (e) {
      if (e.interrupted) throw e;
      if ((e.status === 403 || e.status === 404) && refreshUrl && !refreshed) {
        refreshed = true;
        const fresh = await refreshUrl();
        if (fresh) { warn("export URL expired, got a fresh one", { name }); url = fresh; continue; }
      }
      if (!e.retry || attempt >= delays.length) throw e;
      warn("download failed, will retry", { name, attempt: attempt + 1, of: delays.length, in_s: delays[attempt] / 1000, err: e.message });
      await sleep(delays[attempt++]);
    }
  }
}
