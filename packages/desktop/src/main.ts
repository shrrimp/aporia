import { BrowserWindow, Menu, app, ipcMain, shell } from 'electron';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brand } from '@app/brand';
import { dataRoot } from '@app/core';
import { AppService, serve, type Served } from '@app/server';

const here = path.dirname(fileURLToPath(import.meta.url));
app.setName(brand.displayName);

let served: Served | undefined;
let service: AppService | undefined;

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
  await win.loadURL(`${served.url}/`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => BrowserWindow.getAllWindows()[0]?.focus());
  app.whenReady().then(start, (err: unknown) => {
    console.error(err);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
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
