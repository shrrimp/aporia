import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brand } from '@app/brand';
import { dataRoot } from '@app/core';
import { AppService, serve, type Served } from '@app/server';
import { crashLog } from './crash-log.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
app.setName(brand.displayName);

let served: Served | undefined;
let service: AppService | undefined;
const log = crashLog(dataRoot({ platform: process.platform, env: process.env, home: homedir() }));
// The core runs in this process: an error in it is logged, and the window stays up.
process.on('uncaughtException', (err) => log(`core error: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => log(`core error (promise): ${(err as Error)?.stack ?? String(err)}`));

/** Only our own page may ask for the connection token. */
function isOwnPage(url: string): boolean {
  return served !== undefined && (url === served.url || url.startsWith(`${served.url}/`));
}

async function start(): Promise<void> {
  const root = dataRoot({ platform: process.platform, env: process.env, home: homedir() });
  service = new AppService({ dataRoot: root });
  served = await serve({
    app: service,
    staticDir: process.env[`${brand.envPrefix}_UI_DIR`] ?? path.join(here, '..', '..', 'ui', 'dist'),
  });

  ipcMain.on('app:connection', (event) => {
    event.returnValue = isOwnPage(event.senderFrame?.url ?? '') ? { url: served!.url, token: served!.token } : null;
  });
  ipcMain.handle('app:pickFolder', async (event, start: unknown) => {
    if (!isOwnPage(event.senderFrame?.url ?? '')) return null;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory' as const, 'createDirectory' as const], ...(typeof start === 'string' && path.isAbsolute(start) ? { defaultPath: start } : {}) };
    const r = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  // No native menu bar: the app has its own bar. macOS keeps a minimal menu so the standard
  // shortcuts (copy, paste, quit, hide) keep working.
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null,
  );
  // On Windows and macOS the title bar merges into the app's bar; on Linux the window manager decides.
  const integratedTitleBar =
    process.platform === 'win32'
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#070708', symbolColor: '#9399a3', height: 50 } }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const }
        : {};

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: brand.displayName,
    backgroundColor: '#070708',
    autoHideMenuBar: true,
    ...integratedTitleBar,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  // Tests drive a hidden window (headless Chromium is not reliable on every GPU driver).
  if (process.env[`${brand.envPrefix}_HIDDEN_WINDOW`] !== '1') win.once('ready-to-show', () => win.show());
  // Links open in the system browser; the app window never leaves the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !isOwnPage(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOwnPage(url)) event.preventDefault();
  });
  watch(win);
  await win.loadURL(`${served.url}/`);
}

/** Recent page reloads after a crash: more than a few in a minute and the app stops trying. */
const recoveries: number[] = [];

/**
 * Keep the window alive (roadmap: "no state is lost across restarts", and a crash is a restart).
 * Everything the learner did is saved by the core as they go, so a reloaded page comes back where
 * it was. Every incident is logged with what was done about it.
 */
function watch(win: BrowserWindow): void {
  const contents = win.webContents;
  const recover = (why: string) => {
    const now = Date.now();
    while (recoveries.length > 0 && now - recoveries[0]! > 60_000) recoveries.shift();
    if (recoveries.length >= 3) {
      log(`${why}; not reloading again (3 times in a minute). Close and reopen the app; your work is saved.`);
      return;
    }
    recoveries.push(now);
    log(`${why}; reloading the page`);
    if (!win.isDestroyed()) contents.reload();
  };
  contents.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') recover(`the page's process stopped (${d.reason}, exit code ${d.exitCode})`);
  });
  contents.on('unresponsive', () => log('the page is not responding'));
  contents.on('responsive', () => log('the page responds again'));
  contents.on('preload-error', (_e, file, err) => log(`preload error in ${file}: ${err.stack ?? err.message}`));
  contents.on('did-fail-load', (_e, code, description, url, mainFrame) => {
    if (mainFrame) log(`the page did not load (${code} ${description}) from ${url}`);
  });
  contents.on('console-message', (e) => {
    if (e.level === 'error') log(`page error: ${e.message}${e.sourceId ? ` (${e.sourceId}:${e.lineNumber})` : ''}`);
  });
  // A learner with a blank window needs a way back that does not lose anything: Ctrl+R or F5
  // reloads the page (there is no menu bar on Linux and Windows to offer it).
  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (input.key === 'F5' || (mod && !input.shift && input.key.toLowerCase() === 'r')) {
      e.preventDefault();
      log('page reloaded by the learner');
      contents.reload();
    } else if (mod && input.shift && input.key.toLowerCase() === 'i') {
      e.preventDefault();
      contents.toggleDevTools();
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => BrowserWindow.getAllWindows()[0]?.focus());
  app.whenReady().then(start).catch((err: unknown) => {
    log(`could not start: ${(err as Error)?.stack ?? String(err)}`);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  // The GPU process draws every window. Chromium restarts it after a crash; the window is
  // repainted so it does not stay blank.
  app.on('child-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    log(`${d.type} process stopped (${d.reason}, exit code ${d.exitCode})${d.type === 'GPU' ? '; repainting the window' : ''}`);
    if (d.type === 'GPU') setTimeout(() => BrowserWindow.getAllWindows().forEach((w) => w.webContents.invalidate()), 500);
  });
  let stopping = false;
  app.on('before-quit', (event) => {
    if (stopping) return;
    stopping = true;
    event.preventDefault();
    void (async () => {
      await served?.close();
      await service?.close(); // releases the profile lock and stops the agent
      app.exit(0);
    })();
  });
}
