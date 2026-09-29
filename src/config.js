import fs from "node:fs";
import path from "node:path";
import { loadCredentials } from "./secrets.js";

export const PROJECT_FILE = "grundium.json";
export const STATE_DIR = ".grundium";

const DEFAULTS = {
  baseUrl: "https://grundium.net",
  device: "",              // substring of the scanner name or UUID; empty = the only/first one
  dest: "downloads",       // where verified files go, relative to the project root
  format: "SVS",           // export format used by the "export" command
  intervalMinutes: 15,     // for "run"
  autoExport: false,       // let "run" trigger exports on its own (changes scanner state)
  maxExportsPerCycle: 2,
  headless: true,
};

/** Walk up from `start` to find the project root (directory containing grundium.json). */
export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, PROJECT_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function initProject(root, overrides = {}) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, PROJECT_FILE);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const cfg = { ...DEFAULTS, ...existing, ...overrides };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  const stateDir = path.join(root, STATE_DIR);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, cfg.dest), { recursive: true });
  const gi = path.join(root, ".gitignore");
  const lines = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8").split("\n") : [];
  for (const l of [STATE_DIR + "/", cfg.dest + "/", "node_modules/"]) if (!lines.includes(l)) lines.push(l);
  fs.writeFileSync(gi, lines.filter((l, i, a) => l || i === a.length - 1).join("\n").replace(/\n*$/, "\n"));
  return loadProject(root);
}

export function loadProject(root = findProjectRoot()) {
  if (!root) throw new Error(`No ${PROJECT_FILE} found here or above. Run "GrundiumGrab init" first.`);
  const raw = JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILE), "utf8"));
  const cfg = { ...DEFAULTS, ...raw };
  cfg.root = root;
  cfg.stateDir = path.join(root, STATE_DIR);
  cfg.dest = path.resolve(root, cfg.dest);
  cfg.captureDir = path.join(cfg.stateDir, "captures");
  if (process.env.GRUNDIUM_HEADLESS) cfg.headless = process.env.GRUNDIUM_HEADLESS.toLowerCase() !== "false";
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.mkdirSync(cfg.captureDir, { recursive: true });
  // Do not recreate the download folder here: if it lives on a drive that is not mounted,
  // creating it would hide that fact and make every downloaded file look lost. "init"
  // creates it; "download" refuses to run while it is missing.
  cfg.destExists = fs.existsSync(cfg.dest);
  return cfg;
}

export function credentialsFor(cfg) {
  const creds = loadCredentials(cfg.stateDir);
  if (!creds) throw new Error('No credentials. Run "GrundiumGrab init" or "GrundiumGrab config credentials".');
  return creds;
}
