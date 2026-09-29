# Grundium downloader

Periodic grab / check / download loop for whole-slide images on a Grundium Ocus scanner,
driven through the grundium.net web portal with Puppeteer.

## How it works

grundium.net is a login portal plus a relay. Scans live on the scanner and reach you only
as **exports**: the scanner writes an SVS/TIFF file and serves it at a plain HTTPS URL.
The CLI drives the real web app in headless Chrome to list scans and read the export
queue, then downloads finished exports with normal HTTP (resumable, no cookies needed).

Local state lives in `.grundium/` (encrypted credentials, manifest, captured traffic) and
a human-readable `scans.csv` is rewritten after every refresh.

## Setup

```bash
npm install
node src/cli.js init            # asks for grundium.net email + password, creates grundium.json
node src/cli.js login           # checks the credentials, lists your scanners
```

Credentials are AES-256-GCM encrypted in `.grundium/credentials.enc`. The key is a random
`.grundium/key` file (mode 600). For servers, set `GRUNDIUM_PASSPHRASE` before `init` to
derive the key from a passphrase instead, then export the same variable in the service
unit. `GRUNDIUM_USERNAME` / `GRUNDIUM_PASSWORD` in the environment override the store.

Settings are in `grundium.json` (`node src/cli.js config show` / `config set <key> <value>`):
`device`, `dest`, `format`, `intervalMinutes`, `autoExport`, `maxExportsPerCycle`, `headless`.

## Commands

| Command | What it does | Touches scanner? |
|---|---|---|
| `list [--cached] [-f csv\|json\|table] [-s status] [-n name]` | Refresh from the scanner, write `scans.csv`, print | read-only |
| `download [--cached] [-n name] [--uuid id] [-l n]` | Download every finished export, resume `.part` files, verify, move into `dest` | read-only |
| `verify [--deep]` | Check files on disk against the manifest; `--deep` also runs `tiffinfo` | no |
| `export [-n name] [-l n] [--dry-run]` | Ask the scanner to export scans that have none yet | **yes** (untested flow) |
| `run [-i minutes]` | Loop: refresh, export if `autoExport`, download | yes if `autoExport` |
| `status` | Manifest counts | no |

Statuses in `scans.csv`: `downloadable` (finished export URL exists), `downloaded`
(verified on disk), `not_exported`, `exporting`, `failed`, `gone` (removed from scanner).

## Deploying

```bash
node src/cli.js run --interval 0      # one cycle, for cron
node src/cli.js run                   # keep running, interval from grundium.json
```

`.grundium/run.lock` prevents overlapping instances.

## Troubleshooting

Chrome fails with `dlopen ... Framework`: the bundled browser was not extracted.
```bash
cd ~/.cache/puppeteer/chrome && rm -rf mac_arm-* && mkdir mac_arm-<ver> && unzip -q *.zip -d mac_arm-<ver>
```
Set `GRUNDIUM_HEADLESS=false` to watch the browser. RPC traffic and screenshots of each
session are in `.grundium/captures/`.

## Status

Tested live: init, login, list, verify, download (abort/resume/verify/adopt), export dry-run.
Not yet run against the device: `export` without `--dry-run` and `run` with `autoExport`.
