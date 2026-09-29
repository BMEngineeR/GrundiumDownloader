import fs from "node:fs";
import path from "node:path";
import { verifyFile, safeName } from "./download.js";
import { parseCsv, isMarked } from "./csv.js";

/**
 * Local source of truth, keyed by ImageUUID. Statuses:
 *   not_exported  on the scanner, no export yet
 *   exporting     export queued or running on the scanner
 *   downloadable  a finished export URL exists
 *   downloaded    file on disk passed verification
 *   failed        last download/verification attempt failed (retried next time)
 *   not_exportable the scanner refused to export it (no scanned area, e.g. overview-only captures)
 *   gone          no longer listed on the scanner (kept for history)
 */
export class Manifest {
  constructor(stateDir) {
    this.file = path.join(stateDir, "manifest.json");
    this.data = { images: {}, updatedAt: null };
    if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
  }

  get(uuid) { return this.data.images[uuid]; }
  all() { return Object.values(this.data.images); }
  byStatus(status) { return this.all().filter((i) => i.status === status); }

  upsert(uuid, patch) {
    const cur = this.data.images[uuid] || { uuid, status: "not_exported", attempts: 0, first_seen: new Date().toISOString() };
    this.data.images[uuid] = { ...cur, ...patch, updated_at: new Date().toISOString() };
    return this.data.images[uuid];
  }

  /**
   * Merge a live archive listing and the scanner's export state.
   * `images` come from DStorageQuery; `exports` is {ongoing:[], completed:[], failed:[]}
   * where each entry has {ID, Description, URL}. Descriptions look like "'<name>' to WebDL".
   */
  merge(images, exports, dest) {
    // An empty listing on a scanner that had images means the read failed; never mark everything gone.
    if (!images.length && this.all().some((r) => r.status !== "gone")) throw new Error("refusing to merge an empty archive listing");
    const nameOf = (d) => (d.Description?.match(/^'(.*)' to /) || [])[1];
    const readyByName = new Map();
    for (const c of exports.completed || []) if (c.URL && nameOf(c)) readyByName.set(nameOf(c), c);
    const busyNames = new Set([...(exports.ongoing || [])].map(nameOf).filter(Boolean));
    const seen = new Set();
    for (const img of images) {
      const uuid = img.ImageUUID;
      seen.add(uuid);
      const cur = this.get(uuid);
      const patch = {
        name: img.DisplayName, date: img.Date, time: img.Time, timestamp: img.TimeStamp,
        user: img.UserName, size_bytes: img.Size, size_gb: (img.Size / 1e9).toFixed(2),
      };
      const ready = readyByName.get(img.DisplayName);
      if (cur?.status === "downloaded") {
        // keep, but refresh URL in case a later export replaced it
        if (ready) Object.assign(patch, { export_url: ready.URL, export_id: ready.ID });
      } else if (ready) {
        Object.assign(patch, { status: "downloadable", export_url: ready.URL, export_id: ready.ID });
      } else if (busyNames.has(img.DisplayName)) {
        patch.status = "exporting";
      } else if (cur?.status === "not_exportable") {
        // keep
      } else if (!cur || cur.status === "downloadable" || cur.status === "exporting" || cur.status === "gone") {
        patch.status = "not_exported";
        patch.export_url = "";
      }
      // Adopt files already sitting in dest under the expected name.
      if (patch.status !== "downloaded" && cur?.status !== "downloaded" && dest) {
        const guess = path.join(dest, safeName(img.DisplayName) + ".svs");
        const v = verifyFile(guess);
        if (v.ok) Object.assign(patch, { status: "downloaded", local_path: guess, verified_at: new Date().toISOString(), downloaded_at: cur?.downloaded_at || new Date().toISOString() });
      }
      this.upsert(uuid, patch);
    }
    for (const rec of this.all()) if (!seen.has(rec.uuid) && rec.status !== "gone" && rec.status !== "downloaded") rec.status = "gone";
    this.data.updatedAt = new Date().toISOString();
    this.save();
  }

  rows() {
    return this.all()
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .map((r) => ({ ...r, select: r.selected ? "x" : "" }));
  }

  /**
   * Read the "select" column the user edited in scans.csv back into the manifest, so a
   * refresh never wipes their marks. Rows are matched by uuid; anything else in the CSV
   * is ignored (spreadsheets reformat numbers and dates).
   */
  syncSelectionFromCsv(file) {
    if (!fs.existsSync(file)) return 0;
    let changed = 0;
    for (const row of parseCsv(fs.readFileSync(file, "utf8"))) {
      const rec = row.uuid && this.data.images[row.uuid];
      if (!rec) continue;
      const sel = isMarked(row.select);
      if (!!rec.selected !== sel) { rec.selected = sel; changed++; }
    }
    if (changed) this.save();
    return changed;
  }

  selected() { return this.rows().filter((r) => r.selected); }

  summary() {
    const counts = {};
    for (const i of this.all()) counts[i.status] = (counts[i.status] || 0) + 1;
    return { total: this.all().length, counts, updatedAt: this.data.updatedAt };
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
