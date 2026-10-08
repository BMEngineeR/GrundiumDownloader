# GrundiumGrab

Download whole-slide scans from a Grundium Ocus scanner from the command line.
Keeps an inventory of every scan on the device, downloads finished exports as SVS/TIFF
with resume and verification, and can run on a schedule on a laptop or a server.

**Full documentation:** https://bmengineer.github.io/GrundiumDownloader/

## Quick start

Requires Node.js 20 or newer.

```bash
# 0. Check the Node.js version: it must print v20 or higher
node -v
#    Older (e.g. v10 or v18)? Install a newer one without root, then open a new shell:
#    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
#    nvm install 20 && nvm use 20

# 1. Install the global command
npm install -g github:BMEngineeR/GrundiumDownloader

# 2. Create a project folder and store your grundium.net login (encrypted)
mkdir ~/slides && cd ~/slides
GrundiumGrab init

# 3. Check the login and see your scanner
GrundiumGrab login

# 4. Inventory the scanner -> scans.csv
GrundiumGrab list

# 5. Pick scans in a browser window and export them (tick "also download" to fetch them too)
GrundiumGrab export

# 6. Later: download anything else that has a finished export
GrundiumGrab download

# 7. Check the files on disk
GrundiumGrab verify

# 8. Free scanner space: delete the export copies of downloaded scans (scans stay)
GrundiumGrab clean --downloaded --dry-run   # show the list only
GrundiumGrab clean --downloaded             # asks you to type "yes", then deletes
```

Step 5 opens a page in your browser listing every scan with checkboxes, search and a
size total. Tick what you want, press Start, and the terminal does the rest. It is the
step that makes files: a scan can only be downloaded after the scanner has exported it.
Prefer the command line? `GrundiumGrab export --name <text> --download` or `--limit 3`.

Chrome for Testing (about 350 MB) is downloaded automatically on the first browser command.

## Everyday use

```bash
GrundiumGrab list --status downloadable     # what is ready right now
GrundiumGrab list --name biopsy -f csv         # filter, print CSV
GrundiumGrab download --limit 2             # at most two files this run
GrundiumGrab export                         # choose scans in a browser window, then export them
GrundiumGrab export --dry-run --limit 5     # preview which scans would be exported
GrundiumGrab export --name "H&E" --limit 1 # export one scan, wait, announce on the terminal when done
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

## Free scanner space: delete export copies

Every export is a full SVS copy on the scanner's disk. Once a scan is downloaded, its export
copy (the cache) can go; the scan itself stays on the scanner and can be exported again.

```bash
GrundiumGrab clean --downloaded --dry-run   # list the export copies that would be deleted
GrundiumGrab clean --downloaded             # same list, asks you to type "yes", then deletes them
GrundiumGrab clean --selected               # only rows marked with x in scans.csv
GrundiumGrab clean --name "H&E"             # only scans whose name contains the text
```

`clean` only touches rows whose status is `downloaded` and whose local file passes the size
and TIFF-header check. It presses the "Remove" button of each export copy in the scanner's
Exports menu (`DExportCancel`) and never deletes a scan. Each deletion is logged in
`.grundium/deletions.jsonl`.

Every refresh (`list`, `download`, `export`, `clean`, `run`) reads the scanner and records
in `scans.csv`:

| Column | Meaning |
|---|---|
| `GrundiumFileDeleted` | `true` when the scan is no longer on the scanner |
| `GrundiumFileDeletedAt` | when that was first seen |
| `GrundiumCacheDeleted` | `true` when the scan had an export copy and the scanner no longer has it |
| `GrundiumCacheDeletedAt` | when that was first seen, or when `clean` deleted it |

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

Refreshes only notice missing files. Check file contents once a day too:

```
0 3 * * * cd ~/slides && GrundiumGrab verify >> verify.log 2>&1
```

For systemd, launchd, passphrase-protected credentials on servers, and the full command
reference, see the [documentation](https://bmengineer.github.io/GrundiumDownloader/).

## Notes

- The tool only reads from the scanner unless you run `export` or set `autoExport: true`.
- Downloads resume after stalls, network errors, Ctrl-C or a fresh export URL; on a Mac the
  tool keeps the machine awake while transferring.
- Credentials are stored AES-256-GCM encrypted in `.grundium/`. Never commit that folder.
- Each export is a full copy on the scanner's disk. Export a few at a time and clear old
  exports on the device now and then.
- Overview-only captures (named like "20260610 Scanned Image 1234") have no scanned area;
  the scanner refuses to export them and they are marked `not_exportable`.
- Not affiliated with Grundium. Relies on the grundium.net web app's internal protocol.

## Uninstall

```bash
npm uninstall -g grundium-grab   # the command
rm -rf ~/.cache/puppeteer        # the downloaded Chrome
rm -rf ~/slides/.grundium        # a project's credentials and state; keep downloads/ if you want the files
```

## Code review

Pull requests are reviewed automatically by Claude (`.github/workflows/claude-code-review.yml`),
and `@claude` in an issue or PR comment asks Claude to answer or make changes
(`.github/workflows/claude.yml`). Both need the [Claude GitHub App](https://github.com/apps/claude)
installed on the repo and one repository secret: `CLAUDE_CODE_OAUTH_TOKEN` (from
`claude setup-token`, uses a Claude subscription) or `ANTHROPIC_API_KEY` (from the Claude Console).

## Development

```bash
git clone https://github.com/BMEngineeR/GrundiumDownloader.git
cd GrundiumDownloader && npm install && npm link
```

Docs live in `docs/index.html` and are served with GitHub Pages.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Grundium.
