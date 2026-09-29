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
GrundiumGrab run --interval 0               # one refresh + download cycle, for cron
GrundiumGrab run                            # keep running on the configured interval
GrundiumGrab status                         # counts per status
```

Scan statuses: `not_exported` → `exporting` → `downloadable` → `downloaded`
(plus `failed` and `gone`). Scans must be exported on the scanner before they can be
downloaded; `download` only fetches, `export` asks the scanner to make the file.

## Scheduling

```
*/15 * * * * cd ~/slides && GrundiumGrab run --interval 0 >> grab.log 2>&1
```

For systemd, launchd, passphrase-protected credentials on servers, and the full command
reference, see the [documentation](https://bmengineer.github.io/GrundiumDownloader/).

## Notes

- The tool only reads from the scanner unless you run `export` or set `autoExport: true`.
- Credentials are stored AES-256-GCM encrypted in `.grundium/`. Never commit that folder.
- `export` without `--dry-run` has not yet been exercised on a live device. Start with one
  small scan.
- Not affiliated with Grundium. Relies on the grundium.net web app's internal protocol.

## Development

```bash
git clone https://github.com/BMEngineeR/GrundiumDownloader.git
cd GrundiumDownloader && npm install && npm link
```

Docs live in `docs/index.html` and are served with GitHub Pages.
