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
  const url = await reachDeviceUi(page, recorder, { device, timeout });
  // The device UI must actually talk to the scanner: wait for a DStateGet with a real
  // result. When the relay cannot reach the device, calls come back with a null result.
  const live = (e) => e.method === "DStateGet" && Array.isArray(e.result);
  const first = recorder.entries.slice(-50).find(live) || (await recorder.waitFor(live, { timeout: 30000 }).catch(() => null));
  if (!first) {
    const nulls = recorder.entries.filter((e) => /^D[A-Z]/.test(e.method) && e.result === null).length;
    throw new Error(`device UI loaded (${page.url()}) but the scanner did not answer (${nulls} device calls returned nothing). ` +
      "It may be offline, busy, or another session on this account may be connected. Try again in a minute.");
  }
  return url;
}

async function reachDeviceUi(page, recorder, { device, timeout }) {

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
  // Do not wait for network idle: the archive loads hundreds of thumbnails. The listing
  // itself arrives in the first DStorageQuery reply, which is all we need.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const since = Date.now();
    const pending = recorder.waitFor("DStorageQuery", { timeout: attempt === 1 ? 30000 : timeout }).catch(() => null);
    await dismissDialogs(page);
    // Prefer in-app navigation (the "Scan archive" tab): a full page load re-runs the device
    // login, which the device rejects while someone is using the microscope view. Fall back
    // to loading the archive URL only when the tab is not there.
    const clicked = await page.evaluate(() => {
      const a = [...document.querySelectorAll("a.gs-toolbar-top-nav-item")].find((x) => /scan archive/i.test(x.textContent));
      if (!a) return false; a.click(); return true;
    });
    if (!clicked) await page.goto(`${deviceUiBase(page)}/archive`, { waitUntil: "domcontentloaded", timeout });
    await sleep(500);
    await dismissDialogs(page);
    const entry = recorder.find("DStorageQuery", since) || (await pending);
    if (entry && Array.isArray(entry.result?.[0])) return entry.result[0];
    warn("archive view made no DStorageQuery call", { attempt, clicked, url: page.url() });
  }
  throw new Error("could not read the scan archive (no DStorageQuery reply); manifest left unchanged");
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
 * Trigger an export for one image from the archive page. Flow, with a check at every step:
 *   search the name -> clear any remembered selection -> tick the one card -> confirm the
 *   side panel shows that image -> press Export -> read the "Export image." dialog ->
 *   Cancel if the scanner says it cannot be exported, else Confirm and wait for DExportStart.
 * Uses whatever export recipe the account last saved (destination WebDL, format SVS/TIFF).
 * Resolves {started:true, result} or {started:false, reason}.
 */
export async function triggerExport(page, recorder, image, { timeout = 30000 } = {}) {
  await dismissDialogs(page);
  const header = () => page.evaluate(() => document.querySelector(".al-grid-header-selection-label")?.textContent.trim() || "");
  const panelInputs = () => page.evaluate(() => [...document.querySelectorAll("input")].map((i) => i.value));
  const clickButton = (label) => page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t && !x.disabled && x.offsetParent !== null);
    if (!b) return false; b.click(); return true;
  }, label);

  // 1. Filter the grid to this image.
  const search = await page.$('input[placeholder="Search..."]');
  if (!search) throw new Error("archive search box not found");
  await search.click({ clickCount: 3 });
  await search.type(image.name, { delay: 5 });
  await sleep(1500);

  // 2. Clear the selection the app remembers from earlier sessions. The header checkbox
  //    toggles select-all / select-none, so click until the label reads "0 of N".
  for (let i = 0; i < 3 && !/^0 of/.test(await header()); i++) {
    await page.evaluate(() => document.querySelector(".al-grid-header-selection mat-checkbox label")?.click());
    await sleep(800);
  }
  if (!/^0 of/.test(await header())) throw new Error(`could not clear selection (header: ${await header()})`);

  // 3. Tick the single card left by the search and verify the side panel shows it.
  const ticked = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("mat-checkbox")].filter((b) => !b.closest(".al-grid-header-selection"));
    if (boxes.length !== 1) return boxes.length;
    boxes[0].querySelector("label").click();
    return 1;
  });
  if (ticked !== 1) throw new Error(`expected exactly one card after search, found ${ticked}`);
  await sleep(1200);
  const h = await header();
  if (!/^1 of/.test(h) || !(await panelInputs()).includes(image.name)) {
    throw new Error(`selection check failed (header: ${h}); refusing to press Export`);
  }

  // 4. Press Export. A real scan starts at once (DExportStart goes out, no dialog);
  //    an overview-only capture pops an "Export image." dialog saying it cannot be exported.
  const since = Date.now();
  if (!(await clickButton("Export"))) throw new Error("Export button not found or disabled");
  let dialog = "", call = null;
  for (let i = 0; i < 20 && !dialog && !call; i++) {
    await sleep(500);
    call = recorder.find("DExportStart", since);
    if (call) break;
    dialog = await page.evaluate(() => {
      const el = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && /^Export image\.?$/.test(e.textContent.trim()));
      let card = el;
      for (let i = 0; card && i < 10 && !/Confirm|Cancel/.test(card.innerText || ""); i++) card = card.parentElement;
      return card ? card.innerText.replace(/\s+/g, " ").trim() : "";
    });
  }
  if (!call && !dialog) throw new Error("nothing happened after pressing Export (no DExportStart, no dialog)");
  if (dialog && /can ?not be exported|cannot be exported/i.test(dialog)) {
    await clickButton("Cancel");
    return { started: false, reason: dialog.replace(/^(cancel\s*)?Export image\.?\s*/i, "").replace(/\s*(Confirm|Cancel)\s*/g, " ").trim() };
  }
  if (dialog) {
    if (!(await clickButton("Confirm"))) throw new Error(`export dialog without Confirm button: ${dialog}`);
  }
  call = call || recorder.find("DExportStart", since) || (await recorder.waitFor("DExportStart", { timeout }));
  info("export requested", { name: image.name, params: call.params, result: call.result, error: call.error });
  if (call.error) throw new Error(`DExportStart failed: ${call.error.message}`);
  if (Array.isArray(call.result) && call.result[0] !== 0) throw new Error(`scanner rejected export (code ${call.result[0]})`);
  return { started: true, result: call.result, exportId: call.result?.[1] };
}

/**
 * Wait until the scanner reports a finished export for `name`. The app polls
 * DExportStateGet while exports run; reload the archive if it goes quiet.
 */
export async function waitForExport(page, recorder, name, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  let lastSeen = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const e = recorder.find("DExportStateGet");
    if (e && e.ts > lastSeen) lastSeen = e.ts;
    const st = exportsState(recorder);
    const nameOf = (d) => (d.Description?.match(/^'(.*)' to /) || [])[1];
    const done = st.completed.find((c) => nameOf(c) === name && c.URL);
    if (done) return { done };
    const failed = st.failed.find((c) => nameOf(c) === name);
    if (failed) return { failed };
    if (Date.now() - lastSeen > 60000) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      lastSeen = Date.now();
    }
    await sleep(10000);
  }
  throw new Error(`export of "${name}" did not finish within ${Math.round(timeoutMs / 60000)} min`);
}
