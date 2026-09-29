# GrundiumGrab

Download whole-slide scans from a Grundium Ocus scanner from the command line.
Keeps an inventory of every scan on the device, downloads finished exports as SVS/TIFF
with resume and verification, and can run on a schedule on a laptop or a server.

**Full documentation:** https://bmengineer.github.io/GrundiumDownloader/

## Quick start

Requires Node.js 20 or newer.

```bash
# 1. Install the global command
npm install -g github:BMEngineeR/GrundiumDownloader

# 2. Create a project folder and store your grundium.net login (encrypted)
mkdir ~/slides && cd ~/slides
GrundiumGrab init

# 3. Check the login and see your scanner
GrundiumGrab login

# 4. Inventory the scanner -> scans.csv
GrundiumGrab list

# 5. Pick scans in a browser window, export them, wait, download them
GrundiumGrab export

# 6. Later: download anything else that has a finished export
GrundiumGrab download

# 7. Check the files on disk
GrundiumGrab verify
```

Step 5 opens a page in your browser listing every scan with checkboxes, search and a
size total. Tick what you want, press Start, and the terminal does the rest. It is the
step that makes files: a scan can only be downloaded after the scanner has exported it.
Prefer the command line? `GrundiumGrab export --name <text> --download` or `--limit 3`.

Chrome for Testing (about 350 MB) is downloaded automatically on the first browser command.

## Everyday use

```bash
GrundiumGrab list --status downloadable     # what is ready right now
GrundiumGrab list --name GBM -f csv         # filter, print CSV
GrundiumGrab download --limit 2             # at most two files this run
GrundiumGrab export                         # choose scans in a browser window, then export + download
GrundiumGrab export --dry-run --limit 5     # preview which scans would be exported
GrundiumGrab export --name N14-JM --limit 1 # ask the scanner to export one scan
GrundiumGrab export --limit 3 --download    # export three, wait, download them, update csv
GrundiumGrab export --selected --download   # export every row marked with x in scans.csv
GrundiumGrab run --interval 0               # one refresh + download cycle, for cron
GrundiumGrab run                            # keep running on the configured interval
GrundiumGrab status                         # counts per status
```

Scan statuses: `not_exported` → `exporting` → `downloadable` → `downloaded`
(plus `failed`, `not_exportable` and `gone`). A scan lives on the scanner in its own format;
**export** asks the scanner to write an SVS/TIFF copy, and only that copy can be downloaded.
`export` starts exports, `download` fetches finished ones, `export --download` does both.

## Batch export from the CSV

`scans.csv` has a `select` column. Open the file in Excel or Numbers, put an `x` in that
column for every scan you want, save it as CSV, then:

```bash
GrundiumGrab export --selected --download   # export all marked scans, wait, download, update csv
GrundiumGrab list --cached --selected       # see what is marked
```

Marks are matched by the `uuid` column and are kept across refreshes, so editing the
file once is enough. A mark is cleared automatically when the scan is downloaded. The file
can stay open in a spreadsheet while a command runs: each command backs it up to
`.grundium/scans.backup.csv` first and merges your marks back when it finishes.

## How export works

A scan is stored on the scanner as tiles in Grundium's own format. It can only be
downloaded after the scanner writes an SVS/TIFF copy of it: that copy is the export.

1. `export` opens the scan archive in headless Chrome, searches the scan by name, clears
   any selection the web app remembered, ticks the one matching card, and checks that the
   side panel shows that scan. Only then does it press Export.
2. The scanner queues the job and stitches the tiles into one SVS file. Small slides take
   under a minute, large ones many minutes. Overview-only captures have no scanned area,
   so the scanner refuses them; they are marked `not_exportable`.
3. When the job finishes, the scanner serves the file at a plain HTTPS URL on the device.
   `download` (or `export --download`) fetches it with resume and verifies size and TIFF
   header before moving it into `downloads/`.

Exported files stay on the scanner's disk until deleted from its Exports menu, so export a
few at a time. Full details: https://bmengineer.github.io/GrundiumDownloader/#export-mechanism

## Scheduling

```
*/15 * * * * cd ~/slides && GrundiumGrab run --interval 0 >> grab.log 2>&1
```

For systemd, launchd, passphrase-protected credentials on servers, and the full command
reference, see the [documentation](https://bmengineer.github.io/GrundiumDownloader/).

## Notes

- The tool only reads from the scanner unless you run `export` or set `autoExport: true`.
- Credentials are stored AES-256-GCM encrypted in `.grundium/`. Never commit that folder.
- Each export is a full copy on the scanner's disk. Export a few at a time and clear old
  exports on the device now and then.
- Overview-only captures (named like "20260610 Scanned Image 2627") have no scanned area;
  the scanner refuses to export them and they are marked `not_exportable`.
- Not affiliated with Grundium. Relies on the grundium.net web app's internal protocol.

## Development

```bash
git clone https://github.com/BMEngineeR/GrundiumDownloader.git
cd GrundiumDownloader && npm install && npm link
```

Docs live in `docs/index.html` and are served with GitHub Pages.
