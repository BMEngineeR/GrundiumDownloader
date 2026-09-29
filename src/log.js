export function log(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}
export const info = (msg, extra) => log("info", msg, extra);
export const warn = (msg, extra) => log("warn", msg, extra);
export const error = (msg, extra) => log("error", msg, extra);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
