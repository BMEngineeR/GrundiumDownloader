# GrundiumGrab

A command-line tool that watches a [Grundium Ocus](https://www.grundium.com/) slide scanner
through the grundium.net portal, keeps a local inventory of every scan, and downloads
finished exports as SVS/TIFF files. It can run once by hand, or as a scheduled job on a
laptop or a server.

```
GrundiumGrab init          # one-time setup, stores credentials encrypted
GrundiumGrab list          # inventory of all scans -> scans.csv
GrundiumGrab download      # fetch every finished export, verify, resume if interrupted
GrundiumGrab run           # do the above on a schedule
```

## How it works

Scans are stored on the scanner itself, not in the cloud. grundium.net is a login portal
plus a relay that forwards commands to the device. To get a file out, the scanner must
first **export** it; the export is then served at a plain HTTPS URL on the device host.

GrundiumGrab therefore has two halves:

1. **Browser half.** Headless Chrome (Puppeteer) logs in to grundium.net, opens the scanner's
   web UI, and reads the archive listing and the export queue from the app's own network
   traffic. Nothing about the signed protocol is reimplemented.
2. **HTTP half.** Finished exports are downloaded with ordinary HTTP requests. Downloads
   resume from a `.part` file, are checked against the server's size, and must start with a
   TIFF or BigTIFF header before they are moved into the destination folder.

State lives in a JSON manifest keyed by the scanner's image UUID. `scans.csv` is a
human-readable view of that manifest and is rewritten after every refresh.

## Requirements

- Node.js 20 or newer
- A grundium.net account with access to at least one scanner
- About 400 MB of disk for the bundled Chrome, plus room for the slide files
- Optional: `tiffinfo` (libtiff) for the deeper `verify --deep` check

## Install

One command, straight from GitHub:

```bash
npm install -g github:BMEngineeR/GrundiumDownloader
```

That gives you the global `GrundiumGrab` command. The package has no install scripts;
Chrome for Testing (about 350 MB) is downloaded into `~/.cache/puppeteer` on first use, or
explicitly with `GrundiumGrab setup`. Set `PUPPETEER_CACHE_DIR` to put it elsewhere.

Requires Node.js 20 or newer. On Linux servers also install `unzip` and the usual Chrome
runtime libraries (`apt-get install -y unzip libnss3 libatk-bridge2.0-0 libgbm1 libasound2`).

For development, clone the repo and run `npm install && npm link` instead.

## Quick start

```bash
mkdir ~/slides && cd ~/slides
GrundiumGrab init                  # asks for email + password, writes grundium.json
GrundiumGrab login                 # confirms the credentials and lists your scanners
GrundiumGrab list                  # reads the archive, writes scans.csv
GrundiumGrab download              # downloads whatever already has a finished export
GrundiumGrab verify                # checks the files on disk
```

`init` creates a project folder. Every other command finds the project by walking up from
the current directory to the nearest `grundium.json`, so run them from inside that folder.

## Commands

### `init [dir]`

Creates `grundium.json`, the `.grundium/` state folder, the download folder, and a
`.gitignore` that keeps secrets and data out of version control. Prompts for the
grundium.net email and password unless they are given with `--username` / `--password` or
present as `GRUNDIUM_USERNAME` / `GRUNDIUM_PASSWORD` in the environment.

Options: `--device <name>` (substring of the scanner name when the account has several),
`--dest <dir>` (download folder, default `downloads`), `--format SVS|TIFF`.

### `setup`

Downloads Chrome for Testing into `~/.cache/puppeteer` if it is missing or incomplete.
Every browser command does this check on its own, so `setup` is only for doing it up front.

### `login`

Logs in once, prints the account and the scanners it can see, and exits.

### `list`

Refreshes the inventory from the scanner and writes `scans.csv`. Read-only.

```bash
GrundiumGrab list                          # table, newest first
GrundiumGrab list --status downloadable    # only scans with a finished export
GrundiumGrab list --name GBM -f csv        # filter by name, print CSV
GrundiumGrab list --cached -f json         # no scanner contact, use the manifest
```

`scans.csv` columns: `status, name, date, time, size_bytes, size_gb, user, uuid,
local_path, downloaded_at, verified_at, export_url, export_id, last_error`.

| Status | Meaning |
|---|---|
| `not_exported` | On the scanner, no export exists yet. Cannot be downloaded until one is made. |
| `exporting` | Export queued or running on the scanner. |
| `downloadable` | A finished export URL exists. `download` will fetch it. |
| `downloaded` | File on disk passed verification. |
| `failed` | Last download or verification failed. Retried on the next `download`. |
| `gone` | No longer listed on the scanner. Kept for history. |

### `download`

Fetches every `downloadable` scan (and retries `failed` ones). Refreshes the inventory
first unless `--cached` is given. Read-only on the scanner.

```bash
GrundiumGrab download                      # everything that is ready
GrundiumGrab download --name 15-2502       # only names containing this text
GrundiumGrab download --limit 2            # at most two files this run
```

Files are written as `<name>.svs.part` and renamed only after the size matches the
server's `Content-Length` and the header is TIFF or BigTIFF. An interrupted run resumes
from the partial file. A file already present and valid is adopted without downloading.

### `verify`

Checks every `downloaded` entry against the disk: missing files go back to
`downloadable`, corrupt files go to `failed`, and the rest get a fresh `verified_at`.
Prints counts of what is still not downloaded, by status. `--deep` also runs `tiffinfo`.

### `export`

Asks the scanner to export scans that have no export yet. **This changes scanner state
and uses its disk**, so it is a separate command and off by default in `run`.

```bash
GrundiumGrab export --dry-run --limit 5    # show what would be exported
GrundiumGrab export --name N14-JM --limit 1
```

The click flow was written from the archive page layout but has not yet been exercised
against a live device. Start with one small scan and check the result with `list`.

### `run`

The scheduled loop: refresh, export if `autoExport` is on, download, record.

```bash
GrundiumGrab run                 # forever, every intervalMinutes from grundium.json
GrundiumGrab run --interval 0    # one cycle, for cron
```

A lock file in `.grundium/run.lock` prevents two instances from overlapping.

### `config` and `status`

```bash
GrundiumGrab config show
GrundiumGrab config set intervalMinutes 30
GrundiumGrab config set autoExport true
GrundiumGrab config credentials          # replace the stored password
GrundiumGrab status                      # manifest counts
```

## Configuration

`grundium.json` in the project folder:

| Key | Default | Purpose |
|---|---|---|
| `device` | `""` | Substring of the scanner name or UUID. Empty picks the only one. |
| `dest` | `downloads` | Where verified files go, relative to the project. |
| `format` | `SVS` | Export format requested by `export`. |
| `intervalMinutes` | `15` | Cycle interval for `run`. |
| `autoExport` | `false` | Let `run` trigger exports on its own. |
| `maxExportsPerCycle` | `2` | Cap on exports in flight when `autoExport` is on. |
| `headless` | `true` | Set `false` to watch the browser. `GRUNDIUM_HEADLESS` overrides. |

## Credentials and security

The password is stored in `.grundium/credentials.enc`, encrypted with AES-256-GCM.

- **Default:** the key is a random 32-byte file at `.grundium/key` with mode 600.
- **Servers:** set `GRUNDIUM_PASSPHRASE` before `init`. The key is then derived from the
  passphrase with scrypt and no key file is written. Export the same variable in the
  service unit or cron environment.
- **Override:** `GRUNDIUM_USERNAME` and `GRUNDIUM_PASSWORD` in the environment take
  precedence over the stored file, for CI and one-off runs.

This protects against accidental commits, backups and casual reading. It does not
protect against someone who can already run code as your user. Never commit `.grundium/`.

The tool only reads from the scanner unless you run `export` or enable `autoExport`. It
never claims the scanner's control lock and never deletes anything on the device.

## Running on a schedule

**cron** (one cycle every 15 minutes):

```
*/15 * * * * cd /path/to/project && /usr/local/bin/GrundiumGrab run --interval 0 >> grab.log 2>&1
```

**systemd** (`/etc/systemd/system/grundiumgrab.service`):

```ini
[Unit]
Description=GrundiumGrab
After=network-online.target

[Service]
WorkingDirectory=/path/to/project
Environment=GRUNDIUM_PASSPHRASE=change-me
ExecStart=/usr/bin/GrundiumGrab run
Restart=always
User=slides

[Install]
WantedBy=multi-user.target
```

**launchd** on macOS: a `LaunchAgents` plist with `ProgramArguments` of
`GrundiumGrab run` and `WorkingDirectory` set to the project. Keep the Mac awake or use
`caffeinate`.

Logs are one JSON object per line on stdout (errors on stderr), easy to grep or ship.

## Project layout

```
grundium.json          settings (safe to commit)
scans.csv              inventory view, rewritten on every refresh (contains user emails)
downloads/             verified slide files
.grundium/
  credentials.enc      encrypted login
  key                  encryption key (absent in passphrase mode)
  manifest.json        source of truth for every scan's state
  captures/            RPC traffic and screenshots from each session, for debugging
  run.lock             present while "run" is active
src/
  cli.js               commands
  browser.js           Chrome launch, login, RPC recorder
  scanner.js           device connect, archive listing, export queue, export trigger
  download.js          HTTP download with resume and TIFF verification
  manifest.js          state merge and CSV rows
  secrets.js           AES-256-GCM credential store
  config.js            project discovery and settings
```

## Troubleshooting

**Chrome fails to launch with `dlopen ... Framework`.** The browser bundle is incomplete.
Delete `~/.cache/puppeteer/chrome` and run `GrundiumGrab setup`, which re-downloads and
extracts it with the system unzip.

**`Login failed: Function returned non-zero`.** Wrong email or password. Run
`GrundiumGrab config credentials`.

**`No device matches`.** Check the names printed by `GrundiumGrab login` and set
`config set device <substring>`.

**Something else looks wrong.** Run with `GRUNDIUM_HEADLESS=false` to watch the browser,
and look in `.grundium/captures/` for the recorded RPC calls and screenshots.

## Status and limitations

- Tested against a live scanner: `init`, `login`, `list`, `download` (including abort,
  resume, verification and adoption of existing files), `verify`, `export --dry-run`.
- Not yet exercised on a live device: `export` without `--dry-run`, and `run` with
  `autoExport` enabled.
- The tool relies on the grundium.net web app's internal protocol, which is not a
  published API. A portal update can break the listing or export steps; the captures
  folder is the first place to look when that happens.
- Exports occupy disk on the scanner. Keep `maxExportsPerCycle` small and clean up
  finished exports on the device from time to time.
