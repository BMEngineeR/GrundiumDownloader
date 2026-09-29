#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { PROJECT_FILE, initProject, loadProject, credentialsFor } from "./config.js";
import { saveCredentials, hasCredentials } from "./secrets.js";
import { launchBrowser, closeBrowser, RpcRecorder, login, screenshot, ensureChrome } from "./browser.js";
import { listDevices, connectDevice, listImages, exportsState, storageStatus, deviceState, triggerExport, waitForExport } from "./scanner.js";
import { fetchExport, verifyFile, probe, abortDownloads } from "./download.js";
import { spawn } from "node:child_process";
import { Manifest } from "./manifest.js";
import { toCsv, toTable, COLUMNS } from "./csv.js";
import { info, warn, error, sleep, notify } from "./log.js";
import { ask } from "./prompt.js";
import { pickScans } from "./picker.js";

const program = new Command();
program.name("GrundiumGrab").description("Grab / check / download loop for Grundium Ocus scans").version("0.2.0");

// ---------- helpers ----------

/** Open a browser, log in, and connect to the configured scanner. Caller must close(). */
async function openScanner(cfg, { capture = true } = {}) {
  const creds = credentialsFor(cfg);
  const recorder = new RpcRecorder({ file: capture ? path.join(cfg.captureDir, `rpc-${Date.now()}.jsonl`) : null });
  const browser = await launchBrowser({ headless: cfg.headless });
  const page = await browser.newPage();
  recorder.attach(page);
  // The device UI can raise a "leave this page?" prompt (beforeunload) and other dialogs;
  // accept them all, otherwise closing the browser hangs forever.
  page.on("dialog", (d) => d.accept().catch(() => {}));
  const close = async () => { recorder.close(); await closeBrowser(browser); };
  try {
    await login(page, { baseUrl: cfg.baseUrl, ...creds }, { recorder });
    await connectDevice(page, recorder, { device: cfg.device });
  } catch (e) {
    await screenshot(page, cfg.captureDir, "error").catch(() => {});
    await close();
    throw e;
  }
  return { page, recorder, close };
}

/** Refresh the manifest from the live archive. Returns the scanner session (still open). */
async function refresh(cfg, manifest) {
  backupCsv(cfg);
  const s = await openScanner(cfg);
  const images = await listImages(s.page, s.recorder);
  const exports = exportsState(s.recorder);
  manifest.merge(images, exports, cfg.dest);
  writeCsv(cfg, manifest);
  info("archive refreshed", { images: images.length, exports: { queued: exports.queued, ongoing: exports.ongoing.length, completed: exports.completed.length, failed: exports.failed.length }, storage: storageStatus(s.recorder), state: deviceState(s.recorder) });
  return s;
}

function csvPath(cfg) { return path.join(cfg.root, "scans.csv"); }
function csvBackupPath(cfg) { return path.join(cfg.stateDir, "scans.backup.csv"); }

/**
 * Keep a copy of scans.csv while a command runs. The user may have the file open in a
 * spreadsheet at the same time; if it is later missing or unreadable, the marks are
 * recovered from this copy. Called once at the start of every command that rewrites the CSV.
 */
function backupCsv(cfg) {
  const file = csvPath(cfg);
  if (!fs.existsSync(file)) return;
  fs.copyFileSync(file, csvBackupPath(cfg));
}

/**
 * Rewrite scans.csv: merge the "select" marks from the file on disk (the user's latest
 * edits), falling back to the backup copy when the file is gone or unparsable, then
 * write the tool's current statuses. The backup is kept until the next command.
 */
function writeCsv(cfg, manifest, { merge = true } = {}) {
  const file = csvPath(cfg);
  let n = 0, source = "scans.csv";
  if (!merge) { fs.writeFileSync(file + ".tmp", toCsv(manifest.rows())); fs.renameSync(file + ".tmp", file); return file; }
  try { n = manifest.syncSelectionFromCsv(file); }
  catch (e) { warn("scans.csv unreadable, using backup marks", { err: String(e.message || e) }); source = "backup"; n = manifest.syncSelectionFromCsv(csvBackupPath(cfg)); }
  if (!fs.existsSync(file) && fs.existsSync(csvBackupPath(cfg))) { source = "backup"; n = manifest.syncSelectionFromCsv(csvBackupPath(cfg)); }
  if (n) info("selection marks merged", { from: source, changed: n, selected: manifest.selected().length });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, toCsv(manifest.rows()));
  fs.renameSync(tmp, file);
  return file;
}

function matches(rec, opts) {
  if (opts.selected && !rec.selected) return false;
  if (opts.uuids && !opts.uuids.has(rec.uuid)) return false;
  if (opts.uuid && rec.uuid !== opts.uuid) return false;
  if (opts.name && !rec.name?.toLowerCase().includes(opts.name.toLowerCase())) return false;
  return true;
}

/** Refuse to touch local files while the download folder looks unavailable. */
function assertStore(cfg, manifest) {
  if (!fs.existsSync(cfg.dest)) {
    throw new Error(`download folder ${cfg.dest} does not exist. If it is on an external drive, mount it; ` +
      `otherwise create it (mkdir) or run "GrundiumGrab init" again.`);
  }
  if (!manifest.localStoreAvailable(cfg.dest)) {
    throw new Error(`download folder ${cfg.dest} has no .grundium-store marker, so it looks like an unmounted drive. ` +
      `Mount the drive and try again. If this really is the right folder, run "GrundiumGrab init" in the project to mark it.`);
  }
}

/** Keep a Mac awake while transfers run; no-op elsewhere. Returns a stop function. */
function keepAwake() {
  if (process.platform !== "darwin") return () => {};
  const p = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }).on("error", () => {});
  return () => { try { p.kill(); } catch {} };
}

/** Fresh export URL for a scan, by re-reading the scanner's export list. */
async function freshExportUrl(cfg, manifest, rec) {
  const s = await refresh(cfg, manifest);
  await s.close();
  return manifest.get(rec.uuid)?.export_url || null;
}

async function downloadReady(cfg, manifest, opts = {}) {
  assertStore(cfg, manifest);
  // downloadable scans, failed ones with a URL, and deleted scans whose export file survived
  const todo = manifest.byStatus("downloadable")
    .concat(manifest.byStatus("failed").filter((r) => r.export_url))
    .concat(manifest.byStatus("gone").filter((r) => r.export_url))
    .filter((r) => matches(r, opts)).slice(0, opts.limit || Infinity);
  const summary = { downloaded: 0, skipped: 0, failed: 0 };
  const stopAwake = keepAwake();
  let stop = false;
  const onSignal = () => { if (!stop) { stop = true; warn("interrupted: finishing up, partial file kept for the next run"); abortDownloads(); } };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try {
  for (const rec of todo) {
    if (stop) break;
    try {
      const head = await probe(rec.export_url);
      if (!head.ok && head.status !== 403 && head.status !== 404) throw new Error(`export URL not reachable (HTTP ${head.status})`);
      const fname = rec.export_url.split("/").pop() || rec.name + ".svs";
      const out = await fetchExport(rec.export_url, cfg.dest, decodeURIComponent(fname), head.size, { refreshUrl: () => freshExportUrl(cfg, manifest, rec) });
      manifest.upsert(rec.uuid, { status: "downloaded", local_path: out.file, size_on_disk: out.size, tiff: out.kind, downloaded_at: new Date().toISOString(), verified_at: new Date().toISOString(), last_error: "", selected: false, lost_local_path: "", gone_at: "" });
      out.skipped ? summary.skipped++ : summary.downloaded++;
      info(out.skipped ? "already on disk, adopted" : "downloaded", { name: rec.name, file: out.file, size: out.size });
    } catch (e) {
      if (e.interrupted) { manifest.save(); break; }
      summary.failed++;
      manifest.upsert(rec.uuid, { status: "failed", attempts: (rec.attempts || 0) + 1, last_error: String(e.message || e) });
      error("download failed", { name: rec.name, err: String(e.message || e) });
    }
    manifest.save();
  }
  } finally {
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    stopAwake();
  }
  writeCsv(cfg, manifest);
  if (stop) process.exit(130);
  return summary;
}

// ---------- commands ----------

program.command("init [dir]")
  .description("Create a project: grundium.json, encrypted credentials, downloads folder")
  .option("-u, --username <email>").option("-p, --password <pw>")
  .option("--device <name>", "scanner name/UUID substring").option("--dest <dir>", "download folder", "downloads")
  .option("--format <fmt>", "SVS or TIFF", "SVS")
  .action(async (dir, opts) => {
    const root = path.resolve(dir || ".");
    const cfg = initProject(root, { device: opts.device || "", dest: opts.dest, format: opts.format.toUpperCase() });
    let { username, password } = opts;
    const stored = hasCredentials(cfg.stateDir);
    if (!username && !stored) username = process.env.GRUNDIUM_USERNAME || (await ask("grundium.net email: "));
    if (username && !password) password = process.env.GRUNDIUM_PASSWORD || (await ask("password (not echoed): ", { hidden: true }));
    if (username) {
      if (!password) throw new Error("No password entered; credentials not saved. Run \"GrundiumGrab init\" again.");
      saveCredentials(cfg.stateDir, { username, password });
      info("credentials saved", { username, file: path.join(cfg.stateDir, "credentials.enc"), protection: process.env.GRUNDIUM_PASSPHRASE ? "passphrase" : "key file" });
    } else if (stored) {
      info("keeping existing credentials", { file: path.join(cfg.stateDir, "credentials.enc") });
    }
    info("project ready", { root, config: path.join(root, PROJECT_FILE), dest: cfg.dest });
  });

const config = program.command("config").description("Show or change project settings");
config.command("show").action(() => {
  const cfg = loadProject();
  const { root, stateDir, captureDir, ...rest } = cfg;
  console.log(JSON.stringify({ ...rest, credentials: hasCredentials(stateDir) ? "stored (encrypted)" : "none" }, null, 2));
});
config.command("credentials").description("Replace the stored username/password").action(async () => {
  const cfg = loadProject();
  const username = process.env.GRUNDIUM_USERNAME || (await ask("grundium.net email: "));
  const password = process.env.GRUNDIUM_PASSWORD || (await ask("password (not echoed): ", { hidden: true }));
  if (!username || !password) throw new Error("Email and password are both required; nothing saved.");
  saveCredentials(cfg.stateDir, { username, password });
  info("credentials saved");
});
config.command("set <key> <value>").description("Set a grundium.json key (device, dest, format, intervalMinutes, autoExport, maxExportsPerCycle, headless)").action((key, value) => {
  const cfg = loadProject();
  const file = path.join(cfg.root, PROJECT_FILE);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw[key] = /^(true|false)$/.test(value) ? value === "true" : /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  info("updated", { [key]: raw[key] });
});

program.command("setup").description("Download the Chrome build the tool needs (runs automatically on first use)").action(async () => {
  console.log(await ensureChrome());
});

program.command("login").description("Check credentials and list scanners on the account").action(async () => {
  const cfg = loadProject();
  const creds = credentialsFor(cfg);
  const recorder = new RpcRecorder();
  const browser = await launchBrowser({ headless: cfg.headless });
  const page = await browser.newPage();
  recorder.attach(page);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  try {
    await login(page, { baseUrl: cfg.baseUrl, ...creds }, { recorder });
    console.log(JSON.stringify({ username: creds.username, credentialSource: creds.source, devices: await listDevices(page, recorder) }, null, 2));
  } finally { await closeBrowser(browser); }
});

program.command("list")
  .description("List scans on the scanner with download status; writes scans.csv")
  .option("--cached", "do not contact the scanner, use the manifest")
  .option("-f, --format <fmt>", "table | csv | json", "table")
  .option("-s, --status <status>", "filter: downloadable | downloaded | not_exported | exporting | failed | gone")
  .option("-n, --name <substring>", "filter by name")
  .option("--selected", "only rows marked with x in the select column")
  .action(async (opts) => {
    const cfg = loadProject();
    const manifest = new Manifest(cfg.stateDir);
    if (!opts.cached) { const s = await refresh(cfg, manifest); await s.close(); }
    else manifest.syncSelectionFromCsv(csvPath(cfg));
    let rows = manifest.rows().filter((r) => matches(r, opts));
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);
    if (opts.format === "json") console.log(JSON.stringify(rows, null, 2));
    else if (opts.format === "csv") process.stdout.write(toCsv(rows));
    else { console.log(toTable(rows)); console.log(); console.log(JSON.stringify(manifest.summary())); }
    if (!opts.cached) info("csv written", { file: path.join(cfg.root, "scans.csv") });
  });

program.command("download")
  .description("Download every scan that has a finished export (resumable, verified)")
  .option("--cached", "skip the refresh, use the manifest as-is")
  .option("-s, --selected", "only rows marked with x in the select column of scans.csv")
  .option("-n, --name <substring>").option("--uuid <uuid>").option("-l, --limit <n>", "max files this run", (v) => parseInt(v, 10))
  .action(async (opts) => {
    const cfg = loadProject();
    const manifest = new Manifest(cfg.stateDir);
    if (!opts.cached) { const s = await refresh(cfg, manifest); await s.close(); }
    const summary = await downloadReady(cfg, manifest, opts);
    info("download finished", summary);
    console.log(JSON.stringify(manifest.summary()));
  });

program.command("export")
  .description("Ask the scanner to export scans that have no export yet, then update scans.csv (uses scanner disk)")
  .option("-n, --name <substring>").option("--uuid <uuid>")
  .option("-s, --selected", "rows marked with x in the select column of scans.csv (batch)")
  .option("-l, --limit <n>", "max exports to start (default 1, or all marked rows with --selected)", (v) => parseInt(v, 10))
  .option("--dry-run", "only show what would be exported")
  .option("--no-wait", "return as soon as the scanner has accepted the jobs instead of waiting for them to finish")
  .option("-d, --download", "also download the files once they are ready (off by default)")
  .option("--pick", "choose scans in a browser window (default when no filter is given)")
  .option("--no-browser", "with --pick: print the picker URL instead of opening a browser")
  .action(async (opts) => {
    const cfg = loadProject();
    const manifest = new Manifest(cfg.stateDir);
    const noFilter = !opts.name && !opts.uuid && !opts.selected && opts.limit === undefined && !opts.dryRun;
    if (opts.pick || noFilter) {
      // Pick from the cached inventory so no scanner session is held open while the user thinks.
      if (!manifest.all().length) { const s0 = await refresh(cfg, manifest); await s0.close(); }
      else manifest.syncSelectionFromCsv(csvPath(cfg));
      backupCsv(cfg);
      const choice = await pickScans(manifest.rows(), { openBrowser: opts.browser !== false });
      if (!choice || !choice.uuids.length) { writeCsv(cfg, manifest); info("nothing chosen; no export started"); return; }
      for (const r of manifest.all()) r.selected = choice.uuids.includes(r.uuid);
      manifest.save();
      writeCsv(cfg, manifest, { merge: false });   // the picker's choice wins over stale marks in the file
      opts.selected = true;
      if (choice.download) opts.download = true;
      info("chosen in picker", { scans: choice.uuids.length, download: !!choice.download });
    }
    if (opts.download) assertStore(cfg, manifest);
    const s = await refresh(cfg, manifest);
    const started = [];
    try {
      const limit = opts.limit ?? (opts.selected ? Infinity : 1);
      const todo = manifest.rows().filter((r) => r.status === "not_exported" && matches(r, opts)).slice(0, limit);
      if (opts.selected) {
        const other = manifest.selected().filter((r) => r.status !== "not_exported");
        if (other.length) info("marked rows that need no export", Object.fromEntries(other.map((r) => [r.name, r.status])));
      }
      console.log(toTable(todo));
      if (opts.dryRun || !todo.length) return;
      for (const rec of todo) {
        try {
          const r = await triggerExport(s.page, s.recorder, rec);
          if (r.started) { manifest.upsert(rec.uuid, { status: "exporting", export_id: r.exportId || "", last_error: "" }); started.push(rec); }
          else { manifest.upsert(rec.uuid, { status: "not_exportable", last_error: r.reason }); warn("not exportable", { name: rec.name, reason: r.reason }); }
        } catch (e) {
          await screenshot(s.page, cfg.captureDir, "export-error").catch(() => {});
          manifest.upsert(rec.uuid, { last_error: String(e.message || e) });
          error("export failed", { name: rec.name, err: String(e.message || e) });
        }
        manifest.save();
      }
      const finished = [];
      if ((opts.wait !== false || opts.download) && started.length) {
        for (const rec of started) {
          info("waiting for the scanner to finish the export", { name: rec.name });
          const r = await waitForExport(s.page, s.recorder, rec.name);
          if (r.done) {
            manifest.upsert(rec.uuid, { status: "downloadable", export_url: r.done.URL, export_id: r.done.ID });
            finished.push(rec);
            notify(`Export finished: ${rec.name}  (${rec.size_gb} GB, now downloadable)`, { name: rec.name, url: r.done.URL });
          } else {
            manifest.upsert(rec.uuid, { status: "not_exported", last_error: "export failed on scanner: " + JSON.stringify(r.failed) });
            notify(`Export FAILED on the scanner: ${rec.name}`, { name: rec.name, failed: r.failed });
          }
          manifest.save();
        }
      }
      writeCsv(cfg, manifest);
      if (started.length && opts.wait === false) notify(`${started.length} export(s) requested; the scanner is working. Check later with: GrundiumGrab list --status downloadable`);
      else if (finished.length) notify(`All done: ${finished.length} of ${started.length} export(s) finished.` + (opts.download ? "" : ` Fetch them with: GrundiumGrab download${opts.selected ? " --selected" : ""}`));
    } finally { await s.close(); }
    if (opts.download) {
      // Only the scans this command exported (plus, with --selected, marked ones already
      // downloadable). Never everything that happens to be downloadable.
      const uuids = new Set(started.map((r) => r.uuid));
      if (opts.selected) manifest.selected().filter((r) => r.status === "downloadable" || r.status === "failed").forEach((r) => uuids.add(r.uuid));
      if (uuids.size) info("download finished", await downloadReady(cfg, manifest, { uuids }));
    }
    console.log(JSON.stringify(manifest.summary()));
  });

program.command("verify")
  .description("Check downloaded files on disk and report what is still missing")
  .option("--deep", "also run tiffinfo when available")
  .action(async (opts) => {
    const cfg = loadProject();
    const manifest = new Manifest(cfg.stateDir);
    assertStore(cfg, manifest);
    backupCsv(cfg);
    const report = { ok: [], broken: [], missing: [], not_downloaded: [] };
    for (const rec of manifest.rows()) {
      if (rec.status !== "downloaded") { report.not_downloaded.push(rec); continue; }
      const v = verifyFile(rec.local_path, rec.size_on_disk || 0);
      if (v.ok) {
        if (opts.deep) {
          const { execFileSync } = await import("node:child_process");
          try { execFileSync("tiffinfo", ["-D", rec.local_path], { stdio: "ignore" }); } catch { v.ok = false; v.reason = "tiffinfo failed"; }
        }
      }
      if (v.ok) { report.ok.push(rec); manifest.upsert(rec.uuid, { verified_at: new Date().toISOString() }); }
      else if (v.reason === "missing") { report.missing.push(rec); manifest.upsert(rec.uuid, { status: rec.export_url ? "downloadable" : "not_exported", local_path: "", last_error: "file missing on disk" }); }
      else { report.broken.push(rec); manifest.upsert(rec.uuid, { status: rec.export_url ? "failed" : "not_exported", last_error: v.reason }); }
    }
    manifest.save();
    writeCsv(cfg, manifest);
    const line = (r) => `${r.date} ${r.time}  ${r.size_gb} GB  ${r.name}`;
    console.log(`verified ok: ${report.ok.length}`); report.ok.forEach((r) => console.log("  ", line(r), "->", r.local_path));
    console.log(`broken: ${report.broken.length}`); report.broken.forEach((r) => console.log("  ", line(r), "-", r.last_error));
    console.log(`missing on disk: ${report.missing.length}`); report.missing.forEach((r) => console.log("  ", line(r)));
    const byStatus = {};
    for (const r of report.not_downloaded) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    console.log(`not downloaded: ${report.not_downloaded.length}`, JSON.stringify(byStatus));
  });

program.command("run")
  .description("Loop: refresh, (optionally) export, download, verify")
  .option("-i, --interval <minutes>", "override intervalMinutes; 0 = once")
  .action(async (opts) => {
    const cfg = loadProject();
    const minutes = opts.interval !== undefined ? parseFloat(opts.interval) : cfg.intervalMinutes;
    const lock = path.join(cfg.stateDir, "run.lock");
    if (fs.existsSync(lock)) { error("another instance holds the lock", { lock }); process.exit(2); }
    fs.writeFileSync(lock, String(process.pid));
    const release = () => { try { fs.unlinkSync(lock); } catch {} };
    process.on("SIGINT", () => { release(); process.exit(130); });
    process.on("SIGTERM", () => { release(); process.exit(143); });
    try {
      for (;;) {
        const manifest = new Manifest(cfg.stateDir);
        try {
          // Check the download folder before anything that would start work on the scanner.
          assertStore(cfg, manifest);
          const s = await refresh(cfg, manifest);
          try {
            if (cfg.autoExport) {
              const busy = manifest.byStatus("exporting").length + manifest.byStatus("downloadable").length;
              const room = Math.max(0, cfg.maxExportsPerCycle - busy);
              for (const rec of manifest.rows().filter((r) => r.status === "not_exported").slice(0, room)) {
                try {
                  const r = await triggerExport(s.page, s.recorder, rec);
                  manifest.upsert(rec.uuid, r.started ? { status: "exporting", export_id: r.exportId || "" } : { status: "not_exportable", last_error: r.reason });
                } catch (e) { error("export failed", { name: rec.name, err: String(e.message || e) }); }
              }
              manifest.save();
            }
          } finally { await s.close(); }
          const summary = await downloadReady(cfg, manifest);
          info("cycle done", { ...summary, ...manifest.summary() });
        } catch (e) {
          error("cycle failed", { err: String(e.message || e) });
        }
        if (!minutes) break;
        await sleep(minutes * 60 * 1000);
      }
    } finally { release(); }
  });

program.command("status").description("Manifest summary").action(() => {
  const cfg = loadProject();
  console.log(JSON.stringify(new Manifest(cfg.stateDir).summary(), null, 2));
});

program.parseAsync(process.argv).catch((e) => { error(e?.message || String(e)); process.exit(1); });
