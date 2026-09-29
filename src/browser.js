import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import puppeteer from "puppeteer-core";
import { install, Browser, computeExecutablePath } from "@puppeteer/browsers";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";
import { info, warn } from "./log.js";

// puppeteer-core ships no browser and has no install script, so the CLI manages Chrome itself.
export const CHROME_BUILD = PUPPETEER_REVISIONS.chrome;
export const CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), ".cache", "puppeteer");
export const CHROME_EXE = computeExecutablePath({ browser: Browser.CHROME, buildId: CHROME_BUILD, cacheDir: CACHE_DIR });

/** True when the Chrome build is fully extracted (on macOS the app bundle must carry its framework). */
function chromeComplete(exe) {
  if (!fs.existsSync(exe)) return false;
  if (process.platform === "darwin") {
    return fs.existsSync(path.resolve(exe, "../../Frameworks/Google Chrome for Testing Framework.framework"));
  }
  return true;
}

function hasSystemUnzip() {
  const { spawnSync } = childProcess;
  return spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;
}

/**
 * Make sure the pinned Chrome for Testing build is present and complete.
 * The JavaScript unzip used by @puppeteer/browsers mishandles the symlinks inside the
 * macOS app bundle and leaves a 400 KB stub, so: download the archive, extract it with
 * the system unzip when one exists, and verify the result before letting Chrome launch.
 */
export async function ensureChrome() {
  const exe = CHROME_EXE, cacheDir = CACHE_DIR, buildId = CHROME_BUILD;
  if (chromeComplete(exe)) return exe;
  const versionDir = path.resolve(exe, process.platform === "darwin" ? "../../../../.." : "../..");
  if (fs.existsSync(versionDir)) {
    warn("removing incomplete Chrome folder", { dir: versionDir });
    fs.rmSync(versionDir, { recursive: true, force: true });
  }
  const useSystemUnzip = hasSystemUnzip();
  info("downloading Chrome for Testing", { buildId, cacheDir, extractor: useSystemUnzip ? "unzip" : "built-in" });
  let last = 0;
  const progress = (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct >= last + 25) { last = pct; info("chrome download", { pct }); }
  };
  if (useSystemUnzip) {
    const archive = await install({ browser: Browser.CHROME, buildId, cacheDir, unpack: false, downloadProgressCallback: progress });
    fs.mkdirSync(versionDir, { recursive: true });
    childProcess.execFileSync("unzip", ["-q", "-o", archive, "-d", versionDir], { stdio: "inherit" });
    fs.rmSync(archive, { force: true });
  } else {
    await install({ browser: Browser.CHROME, buildId, cacheDir, downloadProgressCallback: progress });
  }
  if (!chromeComplete(exe)) throw new Error(`Chrome is incomplete at ${exe}. Delete ${versionDir} and run "GrundiumGrab setup" again, or install unzip.`);
  info("chrome ready", { exe });
  return exe;
}

export async function launchBrowser({ headless = true } = {}) {
  const executablePath = await ensureChrome();
  return puppeteer.launch({
    executablePath,
    headless,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    defaultViewport: { width: 1400, height: 900 },
  });
}

/**
 * Close the browser without ever hanging: give the graceful close a few seconds, then
 * kill the Chrome process. Pages with beforeunload handlers can otherwise block forever.
 */
export async function closeBrowser(browser, { graceMs = 8000 } = {}) {
  const proc = browser.process();
  const timer = new Promise((r) => setTimeout(() => r("timeout"), graceMs));
  // Closing pages without running their beforeunload handlers avoids the prompt entirely.
  try { for (const p of await browser.pages()) await Promise.race([p.close({ runBeforeUnload: false }), timer]); } catch {}
  const result = await Promise.race([browser.close().then(() => "closed", () => "error"), timer]);
  if (result !== "closed") {
    warn("browser did not close in time, killing it", { result });
    try { proc?.kill("SIGKILL"); } catch {}
  }
}

/**
 * Records every JSON-RPC exchange the Grundium web app makes, plus console output.
 * The app posts bodies like {method, params, id, auth, source, destination} and
 * gets back {result | error, id}. Every entry is appended to a JSONL file when
 * `file` is given, and kept in memory for waitFor()/find().
 */
export class RpcRecorder {
  constructor({ file } = {}) {
    this.entries = [];
    this.console = [];
    this.waiters = [];
    this.stream = file ? fs.createWriteStream(file, { flags: "a" }) : null;
  }

  attach(page) {
    page.on("console", (m) => {
      const text = m.text();
      this.console.push({ ts: Date.now(), type: m.type(), text });
      if (this.stream) this.stream.write(JSON.stringify({ kind: "console", ts: Date.now(), text }) + "\n");
    });
    page.on("response", async (res) => {
      const req = res.request();
      if (req.method() !== "POST") return;
      let body;
      try { body = JSON.parse(req.postData() || ""); } catch { return; }
      if (!body || typeof body.method !== "string") return;
      let reply = null;
      try { reply = await res.json(); } catch { /* binary or empty */ }
      const entry = {
        kind: "rpc", ts: Date.now(), url: res.url(), status: res.status(),
        method: body.method, params: body.params, id: body.id, destination: body.destination,
        result: reply?.result, error: reply?.error,
      };
      this.entries.push(entry);
      if (this.stream) this.stream.write(JSON.stringify(entry) + "\n");
      for (const w of [...this.waiters]) {
        if (w.match(entry)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(entry); }
      }
    });
  }

  /** Last recorded call of a given method, optionally after a timestamp. */
  find(method, after = 0) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.method === method && e.ts >= after) return e;
    }
    return null;
  }

  /** Resolve with the next call matching `method` (or a predicate). */
  waitFor(method, { timeout = 30000 } = {}) {
    const match = typeof method === "function" ? method : (e) => e.method === method;
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (e) => { clearTimeout(timer); resolve(e); } };
      this.waiters.push(w);
      // unref so a pending wait never keeps the process alive after the browser is closed
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`Timed out waiting for RPC ${method}`)); }
      }, timeout);
      timer.unref?.();
    });
  }

  methods() {
    const counts = {};
    for (const e of this.entries) counts[e.method] = (counts[e.method] || 0) + 1;
    return counts;
  }

  close() { this.stream?.end(); }
}

export async function screenshot(page, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/**
 * Log in to grundium.net. The form is an Angular Material form with
 * input[name=username] (email) and a gs-password-field component wrapping input[type=password].
 * Success is a navigation to /scopes (device picker) or to /v<ver>/ (device UI).
 */
export async function login(page, { baseUrl, username, password }, { recorder, timeout = 45000 } = {}) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout });
  await page.waitForSelector('input[name="username"]', { visible: true, timeout });
  await page.click('input[name="username"]', { clickCount: 3 });
  await page.type('input[name="username"]', username, { delay: 10 });
  await page.type('gs-password-field input[type="password"]', password, { delay: 10 });

  const inApp = () => /^\/(scopes|v\d)/.test(new URL(page.url()).pathname);
  const navigated = page
    .waitForFunction(() => /^\/(scopes|v\d)/.test(location.pathname), { timeout })
    .then(() => ({ ok: true }), () => ({ ok: false, reason: "timed out waiting for /scopes" }));
  // The AuthLogin reply carries the real reason on failure; the DOM only shows a transient snackbar.
  const rpc = recorder
    ? recorder.waitFor("AuthLogin", { timeout }).then(
        (e) => (e.error ? { ok: false, reason: e.error.message || JSON.stringify(e.error) } : null),
        () => null)
    : Promise.resolve(null);
  await page.click('button[type="submit"]');

  const outcome = await Promise.race([navigated, rpc.then((r) => r ?? navigated)]);
  if (!outcome.ok && !inApp()) throw new Error(`Login failed: ${outcome.reason}`);
  info("logged in", { url: page.url() });
  return page.url();
}

/**
 * Route browser downloads to `dir` and resolve download events.
 * Returns an object whose `next()` resolves with {guid, file, url} when a download completes.
 */
export async function enableDownloads(page, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
  const pending = new Map();
  const waiters = [];
  cdp.on("Browser.downloadWillBegin", (ev) => {
    pending.set(ev.guid, { guid: ev.guid, url: ev.url, suggested: ev.suggestedFilename, received: 0, total: 0 });
    info("download started", { url: ev.url, file: ev.suggestedFilename });
  });
  cdp.on("Browser.downloadProgress", (ev) => {
    const p = pending.get(ev.guid);
    if (!p) return;
    p.received = ev.receivedBytes; p.total = ev.totalBytes;
    if (ev.state === "completed") {
      pending.delete(ev.guid);
      const done = { ...p, file: path.join(dir, p.guid) };
      // Chrome saves as <guid> when eventsEnabled; fall back to the suggested name if present.
      if (!fs.existsSync(done.file) && fs.existsSync(path.join(dir, p.suggested))) done.file = path.join(dir, p.suggested);
      waiters.splice(0).forEach((w) => w(done));
    } else if (ev.state === "canceled") {
      pending.delete(ev.guid);
      warn("download canceled", { url: p.url });
    }
  });
  return {
    next: (timeout = 30 * 60 * 1000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for a download to finish")), timeout);
      waiters.push((d) => { clearTimeout(timer); resolve(d); });
    }),
    pending,
  };
}
