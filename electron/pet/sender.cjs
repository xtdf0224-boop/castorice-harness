// Who is talking: the shell's check that a message comes from the app's own page (identity, not a URL compared as text).
// No Electron in here, so main.cjs, ai/index.cjs and scripts/pet-check.ts can all load it. See docs/PET-PLAN.md §2.1.
'use strict';
const path = require('node:path');
const { pathToFileURL, format: formatUrl } = require('node:url');

/**
 * Every spelling a bundled page's address can take. win.loadFile hands Chromium url.format's file URL, and Chromium keeps
 * ~ [ ] and a bare % in it as written, where pathToFileURL writes %7E %5B %5D %25: under C:\Users\ADMINI~1\… (a long user
 * name in its 8.3 form, where the portable build unpacks) the two never compare equal as text.
 */
function pageUrls(file) {
  return new Set([new URL(formatUrl({ protocol: 'file', slashes: true, pathname: path.resolve(file) })).href, pathToFileURL(file).href]);
}

/**
 * Only the app's own page may talk to the shell: the sender is the main window's web contents, in its top frame (nothing it
 * embeds), and that frame is still on the bundled page. Who it is is decided by identity (`getWin()` is the main window);
 * the address check only says it was not navigated elsewhere.
 * @param {() => { webContents: object } | null | undefined} getWin
 * @param {Set<string>} urls  pageUrls(dist/index.html)
 * @returns {(e: { sender?: object, senderFrame?: { url?: string } }) => boolean}
 */
function appSenderCheck(getWin, urls) {
  return (e) => {
    try {
      const w = getWin();
      const wc = e && e.sender;
      const frame = e && e.senderFrame;
      return !!w && !!wc && wc === w.webContents && !!frame && frame === wc.mainFrame && typeof frame.url === 'string' && urls.has(frame.url.split('#')[0]);
    } catch { return false; }
  };
}

module.exports = { pageUrls, appSenderCheck };
