export const COLUMNS = [
  "select", "status", "name", "date", "time", "size_bytes", "size_gb", "user", "uuid",
  "local_path", "downloaded_at", "verified_at", "export_url", "export_id", "last_error",
  "GrundiumFileDeleted", "GrundiumFileDeletedAt", "GrundiumCacheDeleted", "GrundiumCacheDeletedAt",
];

function cell(v) {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns = COLUMNS) {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/** Minimal RFC 4180 parser: quotes, doubled quotes, CRLF, optional BOM. Returns objects keyed by header. */
export function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), (r[i] ?? "").trim()])));
}

/** Truthy CSV mark: x, yes, y, true, 1 (case-insensitive). */
export const isMarked = (v) => /^(x|yes|y|true|1)$/i.test(String(v ?? "").trim());

export function toTable(rows, columns = ["select", "status", "date", "time", "size_gb", "name"]) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(columns.map((c) => r[c])))].join("\n");
}
