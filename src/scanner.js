import { info, warn, sleep } from "./log.js";

/** Devices the account can see, taken from the AuthDevices reply the portal makes on /scopes. */
export async function listDevices(page, recorder, { timeout = 30000 } = {}) {
  const seen = recorder.find("AuthDevices") || (await recorder.waitFor("AuthDevices", { timeout }).catch(() => null));
  return Array.isArray(seen?.result?.[0]) ? seen.result[0] : [];
}

function pick(devices, filter) {
  if (!filter) return devices[0];
  const f = filter.toLowerCase();
  return devices.find((d) => JSON.stringify(d).toLowerCase().includes(f));
}

/**
 * Get from /scopes into the device UI (/v<ver>/...). With one team and one device the
 * portal connects on its own. Otherwise pick the device by clicking the option whose
 * text matches, then the connect button.
 */
export async function connectDevice(page, recorder, { device, timeout = 60000 } = {}) {
  const inDeviceUi = () => /^\/v\d/.test(new URL(page.url()).pathname);
  if (inDeviceUi()) return page.url();

  const devices = await listDevices(page, recorder);
  const target = pick(devices, device);
  if (device && !target) throw new Error(`No device matches "${device}" among ${JSON.stringify(devices)}`);

  const waitRedirect = (ms) => page.waitForFunction(() => /^\/v\d/.test(location.pathname), { timeout: ms }).then(() => true).catch(() => false);
  if (await waitRedirect(8000)) return page.url();

  const label = target ? String(target.Name || target.UUID || "") : "";
  if (label) {
    for (const sel of await page.$$("mat-select")) {
      await sel.click();
      await sleep(400);
      const clicked = await page.evaluate((needle) => {
        const hit = [...document.querySelectorAll("mat-option")].find((o) => o.textContent.toLowerCase().includes(needle.toLowerCase()));
        if (hit) { hit.click(); return true; }
        document.body.click();
        return false;
      }, label);
      if (clicked) break;
    }
  }
  const btn = await page.$("button[type=submit], button.grund-button-primary");
  if (btn) await btn.click().catch(() => {});
  if (await waitRedirect(timeout)) return page.url();
  throw new Error("Could not reach the device UI from /scopes");
}

/** Origin plus version prefix of the device UI, e.g. https://grundium.net/v7.2 */
export function deviceUiBase(page) {
  const u = new URL(page.url());
  const m = u.pathname.match(/^\/v[\d.]+/);
  return u.origin + (m ? m[0] : "");
}

/** Close the "Device communication routed via cloud" notice if it is showing. */
export async function dismissDialogs(page) {
  for (let i = 0; i < 3; i++) {
    const closed = await page.evaluate(() => {
      const btn = document.querySelector("button.via-cloud-dialog__btn-ok");
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!closed) return;
    await sleep(400);
  }
}

/**
 * Images on the scanner. The archive view issues DStorageQuery; its reply is
 * result[0] = array of records {ImageUUID, DisplayName, TimeStamp, Date, Time, UserName, Size, Status, ...}.
 */
export async function listImages(page, recorder, { timeout = 60000 } = {}) {
  const since = Date.now();
  // Do not wait for network idle: the archive loads hundreds of thumbnails. The listing
  // itself arrives in the first DStorageQuery reply, which is all we need.
  const pending = recorder.waitFor("DStorageQuery", { timeout }).catch(() => null);
  await page.goto(`${deviceUiBase(page)}/archive`, { waitUntil: "domcontentloaded", timeout });
  let entry = recorder.find("DStorageQuery", since) || (await pending);
  await dismissDialogs(page);
  if (!entry) { warn("archive view made no DStorageQuery call"); return []; }
  return Array.isArray(entry.result?.[0]) ? entry.result[0] : [];
}

/** Scanner storage: [imageCount, usedBytes, freeBytes]. */
export function storageStatus(recorder) {
  const r = recorder.find("DStorageStatus")?.result;
  return r ? { images: r[0], usedBytes: r[1], freeBytes: r[2] } : null;
}

/** Scanner state, e.g. "Idle" or "Scanning", from the latest DStateGet reply. */
export function deviceState(recorder) {
  const r = recorder.find("DStateGet")?.result;
  return r ? { previous: r[0], current: r[1] } : null;
}

/**
 * Export queue from the latest DExportStateGet reply:
 * result = [queued, onGoing[], completed[], failed[]], entries {ID, Description, URL, URLNewTab}.
 */
export function exportsState(recorder) {
  const r = recorder.find("DExportStateGet")?.result;
  if (!r) return { queued: 0, ongoing: [], completed: [], failed: [] };
  return { queued: r[0] || 0, ongoing: r[1] || [], completed: r[2] || [], failed: r[3] || [] };
}

/**
 * Trigger an export for one image from the archive page. UNTESTED against a live device:
 * written from the page layout (search box, card checkbox, right-hand "Export" button).
 * Uses whatever export recipe the account last saved (destination WebDL, format SVS/TIFF).
 * Resolves with the DExportStart reply, or throws if no such call was observed.
 */
export async function triggerExport(page, recorder, image, { timeout = 30000 } = {}) {
  await dismissDialogs(page);
  // 1. Filter the grid down to this image.
  const search = await page.$('input[placeholder="Search..."], input[type="search"]');
  if (!search) throw new Error("archive search box not found");
  await search.click({ clickCount: 3 });
  await search.type(image.name, { delay: 5 });
  await sleep(1500);
  // 2. Select exactly that card. Cards show the display name; the checkbox sits at the top left.
  const selected = await page.evaluate((name) => {
    const boxes = [...document.querySelectorAll("mat-checkbox")];
    // clear existing selection
    for (const b of boxes) if (b.classList.contains("mat-checkbox-checked")) b.querySelector("input,label")?.click();
    const cards = [...document.querySelectorAll("mat-checkbox")].map((b) => b.closest("li, .al-grid-li, [class*='grid-li']") || b.parentElement);
    const card = cards.find((c) => c && c.textContent.includes(name));
    if (!card) return false;
    card.querySelector("mat-checkbox input, mat-checkbox label")?.click();
    return true;
  }, image.name);
  if (!selected) throw new Error(`card for "${image.name}" not found after search`);
  await sleep(800);
  // 3. Press Export in the side panel, then confirm if a dialog asks.
  const since = Date.now();
  const pressed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button.grund-button")].find((b) => b.textContent.trim() === "Export" && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!pressed) throw new Error("Export button not found or disabled");
  await sleep(1000);
  await page.evaluate(() => {
    const ok = [...document.querySelectorAll("mat-dialog-container button, .cdk-overlay-container button")]
      .find((b) => /^(ok|export|start|yes)$/i.test(b.textContent.trim()));
    ok?.click();
  });
  const call = recorder.find("DExportStart", since) || (await recorder.waitFor("DExportStart", { timeout }));
  info("export requested", { name: image.name, params: call.params, result: call.result, error: call.error });
  if (call.error) throw new Error(`DExportStart failed: ${call.error.message}`);
  return call.result;
}
