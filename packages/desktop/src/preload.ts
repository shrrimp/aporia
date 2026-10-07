// Sandboxed preload: hands the page its connection, nothing else.
import { contextBridge, ipcRenderer } from 'electron';

const connection = ipcRenderer.sendSync('app:connection') as { url: string; token: string } | null;
if (connection) contextBridge.exposeInMainWorld('__APP_CONNECTION__', connection);

// Lets the UI make room for window controls drawn over its own bar, and choose a folder with the
// system's own dialog (it only returns the path the learner picked).
contextBridge.exposeInMainWorld('__APP_SHELL__', {
  platform: process.platform,
  pickFolder: (start?: string) => ipcRenderer.invoke('app:pickFolder', typeof start === 'string' ? start : undefined) as Promise<string | null>,
});
