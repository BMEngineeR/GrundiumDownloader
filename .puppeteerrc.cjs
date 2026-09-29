/**
 * Puppeteer install-time config. The CLI launches full Chrome in headless mode,
 * so the separate chrome-headless-shell build is never needed.
 */
module.exports = {
  skipChromeHeadlessShellDownload: true,
};
