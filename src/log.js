export function log(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}
export const info = (msg, extra) => log("info", msg, extra);
export const warn = (msg, extra) => log("warn", msg, extra);
export const error = (msg, extra) => log("error", msg, extra);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Transfer progress. On a terminal: one line updated in place. Otherwise (log file, cron):
 * a JSON line at most every 30 seconds.
 */
let lastJsonProgress = 0, progressShown = false;
export function progress(name, received, total, speedBps) {
  const mb = (b) => (b / 1e6).toFixed(0);
  if (process.stdout.isTTY) {
    const pct = total ? Math.round((received / total) * 100) : 0;
    const bar = "#".repeat(Math.round(pct / 5)).padEnd(20, "-");
    const line = `  ${name.slice(0, 50).padEnd(50)} [${bar}] ${String(pct).padStart(3)}%  ${mb(received)}/${mb(total)} MB  ${(speedBps / 1e6).toFixed(1)} MB/s`;
    process.stdout.write("\r" + line.padEnd(process.stdout.columns || 120).slice(0, process.stdout.columns || 120));
    progressShown = true;
  } else if (Date.now() - lastJsonProgress > 30000) {
    lastJsonProgress = Date.now();
    info("downloading", { name, pct: total ? Math.round((received / total) * 100) : null, mb: Number(mb(received)) });
  }
}
export function progressDone() {
  if (progressShown) { process.stdout.write("\n"); progressShown = false; }
}
