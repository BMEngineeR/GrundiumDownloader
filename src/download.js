import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { info, progress, progressDone } from "./log.js";

/** HEAD an export URL. Returns {ok, size} without downloading. */
export async function probe(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow" });
    return { ok: r.ok, status: r.status, size: Number(r.headers.get("content-length")) || 0 };
  } catch (e) {
    return { ok: false, status: 0, size: 0, error: String(e) };
  }
}

/**
 * Stream `url` to `target`, resuming from `<target>.part` if it exists.
 * The export URLs on the scanner need no cookies, so plain fetch is enough.
 */
export async function httpDownload(url, target, { onProgress } = {}) {
  const part = target + ".part";
  let offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const headers = offset ? { Range: `bytes=${offset}-` } : {};
  const res = await fetch(url, { headers, redirect: "follow" });
  if (res.status === 416) { offset = 0; fs.rmSync(part, { force: true }); return httpDownload(url, target, { onProgress }); }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (offset && res.status !== 206) { offset = 0; fs.rmSync(part, { force: true }); }
  const total = offset + (Number(res.headers.get("content-length")) || 0);
  let received = offset, lastLog = Date.now(), lastBytes = offset;
  const out = fs.createWriteStream(part, { flags: offset ? "a" : "w" });
  const src = Readable.fromWeb(res.body);
  src.on("data", (chunk) => {
    received += chunk.length;
    const dt = Date.now() - lastLog;
    if (onProgress && dt > 1000) { onProgress(received, total, ((received - lastBytes) * 1000) / dt); lastLog = Date.now(); lastBytes = received; }
  });
  await pipeline(src, out);
  onProgress?.(received, total, 0, true);
  const size = fs.statSync(part).size;
  if (total && size !== total) throw new Error(`incomplete: ${size} of ${total} bytes (rerun to resume)`);
  return { part, size, resumedFrom: offset };
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

/** Download + verify + atomic move into `dest`. Returns the final path. */
export async function fetchExport(url, dest, name, expectedSize = 0) {
  const target = path.join(dest, safeName(name));
  const existing = verifyFile(target, expectedSize);
  if (existing.ok) return { file: target, size: existing.size, kind: existing.kind, skipped: true };
  const dl = await httpDownload(url, target, {
    onProgress: (got, total, speed, done) => (done ? progressDone() : progress(name, got, total, speed)),
  });
  const v = verifyFile(dl.part, expectedSize);
  if (!v.ok) { fs.rmSync(dl.part, { force: true }); throw new Error(`verification failed: ${v.reason}`); }
  fs.renameSync(dl.part, target);
  return { file: target, size: v.size, kind: v.kind, skipped: false };
}
