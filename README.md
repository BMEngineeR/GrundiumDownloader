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

# 5. Download everything that already has a finished export
GrundiumGrab download

# 6. Check the files on disk
GrundiumGrab verify
```

Chrome for Testing (about 350 MB) is downloaded automatically on the first browser command.

## Everyday use

```bash
GrundiumGrab list --status downloadable     # what is ready right now
GrundiumGrab list --name GBM -f csv         # filter, print CSV
GrundiumGrab download --limit 2             # at most two files this run
GrundiumGrab export --dry-run --limit 5     # preview which scans would be exported
GrundiumGrab export --name N14-JM --limit 1 # ask the scanner to export one scan
GrundiumGrab export --limit 3 --download    # export three, wait, download them, update csv
GrundiumGrab run --interval 0               # one refresh + download cycle, for cron
GrundiumGrab run                            # keep running on the configured interval
GrundiumGrab status                         # counts per status
```

Scan statuses: `not_exported` → `exporting` → `downloadable` → `downloaded`
(plus `failed`, `not_exportable` and `gone`). A scan lives on the scanner in its own format;
**export** asks the scanner to write an SVS/TIFF copy, and only that copy can be downloaded.
`export` starts exports, `download` fetches finished ones, `export --download` does both.

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
