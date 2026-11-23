'use strict';
/** Locate and launch a Chromium-based browser (Chrome or Edge) under the app's control. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CDPConnection } = require('./cdp');

function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((r) => [
      path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(r, 'Chromium', 'Application', 'chrome.exe'),
      path.join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ]);
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

function findBrowser() {
  const forced = process.env.WALLED_BROWSER;
  if (forced) return fs.existsSync(forced) ? forced : null;
  return candidates().find((p) => fs.existsSync(p)) || null;
}

/**
 * Launch the browser with a dedicated profile and a CDP pipe.
 * @returns {{proc: import('child_process').ChildProcess, conn: CDPConnection, executable: string}}
 */
function launchBrowser({ executable, userDataDir, headless = false, extraArgs = [] } = {}) {
  const exe = executable || findBrowser();
  if (!exe) throw new Error('No Chrome/Edge installation found. Set WALLED_BROWSER to the browser executable.');
  const dir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'walled-dlp-'));
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate,MediaRouter',
    ...(headless ? ['--headless=new', '--window-size=1280,900'] : ['--new-window']),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false });
  const conn = new CDPConnection(proc.stdio[3], proc.stdio[4]);
  proc.on('exit', () => conn._onClose());
  return { proc, conn, executable: exe, userDataDir: dir };
}

module.exports = { findBrowser, launchBrowser };
