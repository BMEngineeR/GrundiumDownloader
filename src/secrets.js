import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Credentials at rest: AES-256-GCM. The key comes from one of
 *   1. GRUNDIUM_PASSPHRASE (scrypt-derived, salt stored beside the ciphertext) for servers, or
 *   2. a random 32-byte key file with owner-only permissions next to the ciphertext.
 * This stops accidental leaks (commits, backups, shoulder surfing); it does not protect
 * against someone who can already run code as your user.
 */
const KEY_FILE = "key";
const CRED_FILE = "credentials.enc";

function keyFromPassphrase(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1 });
}

function keyFromFile(stateDir, { create = false } = {}) {
  const file = path.join(stateDir, KEY_FILE);
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  if (!create) throw new Error(`Key file missing: ${file}. Run "init" again or set GRUNDIUM_PASSPHRASE.`);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

export function saveCredentials(stateDir, { username, password }) {
  const passphrase = process.env.GRUNDIUM_PASSPHRASE;
  const salt = crypto.randomBytes(16);
  const key = passphrase ? keyFromPassphrase(passphrase, salt) : keyFromFile(stateDir, { create: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ username, password }), "utf8"), cipher.final()]);
  const blob = {
    v: 1, kdf: passphrase ? "scrypt" : "keyfile", salt: salt.toString("base64"),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"),
  };
  fs.writeFileSync(path.join(stateDir, CRED_FILE), JSON.stringify(blob), { mode: 0o600 });
}

export function loadCredentials(stateDir) {
  // Environment always wins, so CI and one-off runs need no files.
  if (process.env.GRUNDIUM_USERNAME && process.env.GRUNDIUM_PASSWORD) {
    return { username: process.env.GRUNDIUM_USERNAME, password: process.env.GRUNDIUM_PASSWORD, source: "env" };
  }
  const file = path.join(stateDir, CRED_FILE);
  if (!fs.existsSync(file)) return null;
  const blob = JSON.parse(fs.readFileSync(file, "utf8"));
  const salt = Buffer.from(blob.salt, "base64");
  let key;
  if (blob.kdf === "scrypt") {
    if (!process.env.GRUNDIUM_PASSPHRASE) throw new Error("Credentials are passphrase-protected; set GRUNDIUM_PASSPHRASE");
    key = keyFromPassphrase(process.env.GRUNDIUM_PASSPHRASE, salt);
  } else {
    key = keyFromFile(stateDir);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const json = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]).toString("utf8");
  return { ...JSON.parse(json), source: blob.kdf };
}

export function hasCredentials(stateDir) {
  return fs.existsSync(path.join(stateDir, CRED_FILE));
}
