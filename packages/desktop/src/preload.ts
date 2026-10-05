// Sandboxed preload: hands the page its connection, nothing else.
import { contextBridge, ipcRenderer } from 'electron';

const connection = ipcRenderer.sendSync('app:connection') as { url: string; token: string } | null;
if (connection) contextBridge.exposeInMainWorld('__APP_CONNECTION__', connection);

// Lets the UI make room for window controls drawn over its own bar.
contextBridge.exposeInMainWorld('__APP_SHELL__', { platform: process.platform });
