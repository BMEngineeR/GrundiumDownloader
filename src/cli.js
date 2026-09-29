#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { PROJECT_FILE, initProject, loadProject, credentialsFor } from "./config.js";
import { saveCredentials, hasCredentials } from "./secrets.js";
import { launchBrowser, RpcRecorder, login, screenshot, ensureChrome } from "./browser.js";
import { listDevices, connectDevice, listImages, exportsState, storageStatus, deviceState, triggerExport } from "./scanner.js";
import { fetchExport, verifyFile, probe } from "./download.js";
import { Manifest } from "./manifest.js";
import { toCsv, toTable, COLUMNS } from "./csv.js";
import { info, warn, error, sleep } from "./log.js";

const program = new Command();
program.name("GrundiumGrab").description("Grab / check / download loop for Grundium Ocus scans").version("0.2.0");

// ---------- helpers ----------

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      process.stdout.write(question);
      const onData = (ch) => { const c = String(ch); if (c === "\n" || c === "\r") process.stdin.removeListener("data", onData); };
      rl._writeToOutput = () => {};
      process.stdin.on("data", onData);
    }
    rl.question(hidden ? "" : question, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a.trim()); });
  });
}

/** Open a browser, log in, and connect to the configured scanner. Caller must close(). */
async function openScanner(cfg, { capture = true } = {}) {
  const creds = credentialsFor(cfg);
  const recorder = new RpcRecorder({ file: capture ? path.join(cfg.captureDir, `rpc-${Date.now()}.jsonl`) : null });
  const browser = await launchBrowser({ headless: cfg.headless });
  const page = await browser.newPage();
  recorder.attach(page);
  const close = async () => { recorder.close(); await browser.close(); };
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
  const s = await openScanner(cfg);
  const images = await listImages(s.page, s.recorder);
  const exports = exportsState(s.recorder);
  manifest.merge(images, exports, cfg.dest);
  writeCsv(cfg, manifest);
  info("archive refreshed", { images: images.length, exports: { queued: exports.queued, ongoing: exports.ongoing.length, completed: exports.completed.length, failed: exports.failed.length }, storage: storageStatus(s.recorder), state: deviceState(s.recorder) });
  return s;
}

function writeCsv(cfg, manifest) {
  const file = path.join(cfg.root, "scans.csv");
  fs.writeFileSync(file, toCsv(manifest.rows()));
  return file;
}

function matches(rec, opts) {
  if (opts.uuid && rec.uuid !== opts.uuid) return false;
  if (opts.name && !rec.name?.toLowerCase().includes(opts.name.toLowerCase())) return false;
  return true;
}

async function downloadReady(cfg, manifest, opts = {}) {
  const todo = manifest.byStatus("downloadable").concat(manifest.byStatus("failed").filter((r) => r.export_url))
    .filter((r) => matches(r, opts)).slice(0, opts.limit || Infinity);
  const summary = { downloaded: 0, skipped: 0, failed: 0 };
  for (const rec of todo) {
    try {
      const head = await probe(rec.export_url);
      if (!head.ok) throw new Error(`export URL not reachable (HTTP ${head.status})`);
      const fname = rec.export_url.split("/").pop() || rec.name + ".svs";
      const out = await fetchExport(rec.export_url, cfg.dest, decodeURIComponent(fname), head.size);
      manifest.upsert(rec.uuid, { status: "downloaded", local_path: out.file, size_on_disk: out.size, tiff: out.kind, downloaded_at: new Date().toISOString(), verified_at: new Date().toISOString(), last_error: "" });
      out.skipped ? summary.skipped++ : summary.downloaded++;
      info(out.skipped ? "already on disk, adopted" : "downloaded", { name: rec.name, file: out.file, size: out.size });
    } catch (e) {
      summary.failed++;
      manifest.upsert(rec.uuid, { status: "failed", attempts: (rec.attempts || 0) + 1, last_error: String(e.message || e) });
      error("download failed", { name: rec.name, err: String(e.message || e) });
    }
    manifest.save();
  }
  writeCsv(cfg, manifest);
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
    if (!username && !hasCredentials(cfg.stateDir)) username = process.env.GRUNDIUM_USERNAME || (await ask("grundium.net email: "));
    if (username && !password) password = process.env.GRUNDIUM_PASSWORD || (await ask("password: ", { hidden: true }));
    if (username && password) { saveCredentials(cfg.stateDir, { username, password }); info("credentials saved", { file: path.join(cfg.stateDir, "credentials.enc"), protection: process.env.GRUNDIUM_PASSPHRASE ? "passphrase" : "key file" }); }
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
  const password = process.env.GRUNDIUM_PASSWORD || (await ask("password: ", { hidden: true }));
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
  try {
    await login(page, { baseUrl: cfg.baseUrl, ...creds }, { recorder });
    console.log(JSON.stringify({ username: creds.username, credentialSource: creds.source, devices: await listDevices(page, recorder) }, null, 2));
  } finally { await browser.close(); }
});

program.command("list")
  .description("List scans on the scanner with download status; writes scans.csv")
  .option("--cached", "do not contact the scanner, use the manifest")
  .option("-f, --format <fmt>", "table | csv | json", "table")
  .option("-s, --status <status>", "filter: downloadable | downloaded | not_exported | exporting | failed | gone")
  .option("-n, --name <substring>", "filter by name")
  .action(async (opts) => {
    const cfg = loadProject();
    const manifest = new Manifest(cfg.stateDir);
    if (!opts.cached) { const s = await refresh(cfg, manifest); await s.close(); }
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
  .description("Ask the scanner to export scans that have no export yet (changes scanner state; UNTESTED flow)")
  .option("-n, --name <substring>").option("--uuid <uuid>").option("-l, --limit <n>", "max exports to start", (v) => parseInt(v, 10), 1)
  .option("--dry-run", "only show what would be exported")
  .action(async (opts) => {
    const cfg = loadProject();
    const manifest = new Manifest(cfg.stateDir);
    const s = await refresh(cfg, manifest);
    try {
      const todo = manifest.rows().filter((r) => r.status === "not_exported" && matches(r, opts)).slice(0, opts.limit);
      console.log(toTable(todo));
      if (opts.dryRun || !todo.length) return;
      for (const rec of todo) {
        try {
          const result = await triggerExport(s.page, s.recorder, rec);
          manifest.upsert(rec.uuid, { status: "exporting", export_id: result?.[1] || "", last_error: "" });
        } catch (e) {
          await screenshot(s.page, cfg.captureDir, "export-error").catch(() => {});
          manifest.upsert(rec.uuid, { last_error: String(e.message || e) });
          error("export failed", { name: rec.name, err: String(e.message || e) });
        }
        manifest.save();
      }
      writeCsv(cfg, manifest);
    } finally { await s.close(); }
  });

program.command("verify")
  .description("Check downloaded files on disk and report what is still missing")
  .option("--deep", "also run tiffinfo when available")
  .action(async (opts) => {
    const cfg = loadProject();
    const manifest = new Manifest(cfg.stateDir);
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
          const s = await refresh(cfg, manifest);
          try {
            if (cfg.autoExport) {
              const busy = manifest.byStatus("exporting").length + manifest.byStatus("downloadable").length;
              const room = Math.max(0, cfg.maxExportsPerCycle - busy);
              for (const rec of manifest.rows().filter((r) => r.status === "not_exported").slice(0, room)) {
                try { await triggerExport(s.page, s.recorder, rec); manifest.upsert(rec.uuid, { status: "exporting" }); }
                catch (e) { error("export failed", { name: rec.name, err: String(e.message || e) }); }
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
