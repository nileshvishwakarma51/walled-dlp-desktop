'use strict';
/**
 * Walled DLP Guard: Electron main process.
 *  - launches a Chrome/Edge window under its control (dedicated profile, CDP pipe)
 *  - runs the Guard engine (interception, inspection, recolouring)
 *  - shows native Continue/Cancel dialogs (Win32 TaskDialog / NSAlert / GTK)
 *  - shows a small control window with status and an activity log
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, shell, screen } = require('electron');
const { launchBrowser } = require('../core/browser');
const { Guard, preview } = require('../core/guard');
const { sites, DEFAULT_RESPONSE_COLOR } = require('../core/sites');
const extract = require('../core/extract');

const MARKER = process.env.WALLED_MARKER || 'WALLED_SENSITIVE';
const COLOR = process.env.WALLED_RESPONSE_COLOR || DEFAULT_RESPONSE_COLOR;

let controlWin = null;
let dialogHost = null;
let browser = null;
let guard = null;
let quitting = false;
const events = [];
let logStream = null;

if (!app.requestSingleInstanceLock()) app.quit();

function send(channel, payload) {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send(channel, payload);
}

function record(evt) {
  events.push(evt);
  if (events.length > 500) events.shift();
  send('event', evt);
  if (logStream) logStream.write(JSON.stringify(evt) + '\n');
}

function setStatus(status) { send('status', status); }

/** Native confirmation dialog. Returns 'continue' or 'cancel'. */
async function confirm(req) {
  const kb = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  let message;
  let detail;
  if (req.kind === 'file') {
    const names = req.files.map((f) => `  - ${f.name} (${f.kind.toUpperCase()}, ${kb(f.size)}${f.truncated ? ', first 25 MB inspected' : ''})`).join('\n');
    message = `Sensitive content detected in a FILE upload on ${req.site}.`;
    detail = `The marker ${MARKER} was found in:\n${names}\n\nSource: ${req.source}.\n\n`
      + 'Continue: upload the file unchanged.\nCancel: block this upload (you can select files again).';
  } else {
    message = `Sensitive content detected in a TEXT PROMPT on ${req.site}.`;
    detail = `Prompt: "${preview(req.text).replace(/"/g, "'")}"\n\nThe prompt contains the marker ${MARKER}.`
      + (req.via === 'network' ? '\n(Caught by the network backstop.)' : '')
      + '\n\nContinue: send the prompt unchanged.\nCancel: do not send it (the text stays in the box so you can edit it).';
  }

  // A tiny always-on-top owner window brings the dialog in front of the
  // browser window, which has focus at the moment the user hits Send.
  if (!dialogHost || dialogHost.isDestroyed()) {
    dialogHost = new BrowserWindow({ width: 1, height: 1, x: 0, y: 0, frame: false, transparent: true, skipTaskbar: true, alwaysOnTop: true, show: false, focusable: true, resizable: false });
  }
  // Centre the (invisible) owner so the dialog opens in the middle of the screen.
  const wa = screen.getPrimaryDisplay().workArea;
  dialogHost.setBounds({ x: Math.round(wa.x + wa.width / 2 - 220), y: Math.round(wa.y + wa.height / 2 - 160), width: 1, height: 1 });
  dialogHost.setAlwaysOnTop(true, 'screen-saver');
  dialogHost.show();
  dialogHost.focus();
  try {
    const { response } = await dialog.showMessageBox(dialogHost, {
      type: 'warning',
      title: 'Walled DLP Guard: sensitive content',
      message,
      detail,
      buttons: ['&Continue', 'C&ancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      normalizeAccessKeys: true,
    });
    return response === 0 ? 'continue' : 'cancel';
  } finally {
    if (!dialogHost.isDestroyed()) dialogHost.hide();
  }
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 380,
    height: 820,
    x: 0,
    y: 0,
    title: 'Walled DLP Guard',
    autoHideMenuBar: true,
    backgroundColor: '#0f1222',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  controlWin.removeMenu();
  controlWin.loadFile(path.join(__dirname, 'ui', 'index.html'));
  controlWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  controlWin.on('closed', () => { controlWin = null; app.quit(); });
}

async function startGuard() {
  const userData = app.getPath('userData');
  logStream = fs.createWriteStream(path.join(userData, 'activity.log'), { flags: 'a' });
  setStatus({ state: 'starting', text: 'Starting protected browser...' });
  const profile = path.join(userData, 'browser-profile');
  const extraArgs = ['--window-position=380,0', '--window-size=1156,830'];
  // Development/automation only: also expose a TCP debugging port.
  if (process.env.WALLED_DEBUG_PORT) extraArgs.push(`--remote-debugging-port=${Number(process.env.WALLED_DEBUG_PORT)}`);
  browser = launchBrowser({ userDataDir: profile, extraArgs });
  browser.proc.on('exit', () => {
    if (quitting) return;
    browser = null;
    setStatus({ state: 'stopped', text: 'Protected browser closed. Use "Open" to start it again.' });
  });
  guard = new Guard({
    conn: browser.conn,
    sites: sites(COLOR),
    confirm,
    marker: MARKER,
    recolor: true,
    ocrCachePath: userData,
  });
  guard.on('event', record);
  await guard.start();
  setStatus({ state: 'running', text: `Protecting ChatGPT and Perplexity in ${path.basename(browser.executable)}`, browser: browser.executable, marker: MARKER, color: COLOR });
}

async function ensureRunning() {
  if (!browser || browser.conn.closed) await startGuard();
}

ipcMain.handle('open-site', async (_e, id) => {
  await ensureRunning();
  const site = guard.sites.find((s) => s.id === id);
  if (site) await guard.open(site.url);
});
ipcMain.handle('set-recolor', async (_e, on) => { if (guard) await guard.setRecolor(on); return !!on; });
ipcMain.handle('get-state', () => ({ events, marker: MARKER, color: COLOR }));
ipcMain.handle('open-log', () => shell.openPath(path.join(app.getPath('userData'), 'activity.log')));

app.whenReady().then(async () => {
  createControlWindow();
  try {
    await startGuard();
    // Open both supported apps in tabs of the protected browser.
    for (const s of guard.sites) await guard.open(s.url);
    await guard.closeBlankTabs();
  } catch (e) {
    setStatus({ state: 'error', text: e.message });
    dialog.showErrorBox('Walled DLP Guard', e.message);
  }
});

app.on('second-instance', () => { if (controlWin) { controlWin.show(); controlWin.focus(); } });

app.on('before-quit', async () => {
  quitting = true;
  if (browser) {
    // Ask the browser to close gracefully so the profile (logins) is saved.
    browser.conn.send('Browser.close').catch(() => {});
    setTimeout(() => { try { browser.proc.kill(); } catch { /* already gone */ } }, 1500);
  }
  extract.shutdown();
  if (logStream) logStream.end();
});

app.on('window-all-closed', () => app.quit());
