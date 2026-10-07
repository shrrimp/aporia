import './zod-config.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import '@fontsource/pixelify-sans/700.css';
import './styles.css';
import { brand } from '@app/brand';
import { App } from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { RpcClient, connectionFromLocation } from './rpc.ts';
import { RpcProvider } from './hooks.tsx';

declare global {
  interface Window {
    /** Set by the desktop shell's preload script. */
    __APP_CONNECTION__?: { url: string; token: string };
    /** Set by the desktop shell: which OS draws window controls over the app's bar. */
    __APP_SHELL__?: { platform: string; pickFolder?: (start?: string) => Promise<string | null> };
  }
}

document.title = brand.displayName;
if (window.__APP_SHELL__) document.documentElement.dataset['shell'] = window.__APP_SHELL__.platform;
// A file dropped outside a drop zone must not replace the app with that file.
for (const type of ['dragover', 'drop'] as const) window.addEventListener(type, (e) => e.preventDefault());
const root = createRoot(document.getElementById('root')!);
const url = connectionFromLocation(window.location, window.__APP_CONNECTION__);
if (!url) {
  root.render(<p className="error">Missing connection token. Start the app from the desktop launcher or use the URL printed by the server.</p>);
} else {
  const client = new RpcClient(url);
  root.render(
    <StrictMode>
      <ErrorBoundary area="the app">
        <RpcProvider client={client}>
          <App />
        </RpcProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}
