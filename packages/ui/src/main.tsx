import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import '@fontsource/pixelify-sans/700.css';
import './styles.css';
import { z } from 'zod';
import { brand } from '@app/brand';
import { App } from './App.tsx';
import { RpcClient, connectionFromLocation } from './rpc.ts';
import { RpcProvider } from './hooks.tsx';

declare global {
  interface Window {
    /** Set by the desktop shell's preload script. */
    __APP_CONNECTION__?: { url: string; token: string };
    /** Set by the desktop shell: which OS draws window controls over the app's bar. */
    __APP_SHELL__?: { platform: string };
  }
}

// The UI's CSP forbids eval; tell zod not to probe for it.
z.config({ jitless: true });
document.title = brand.displayName;
if (window.__APP_SHELL__) document.documentElement.dataset['shell'] = window.__APP_SHELL__.platform;
const root = createRoot(document.getElementById('root')!);
const url = connectionFromLocation(window.location, window.__APP_CONNECTION__);
if (!url) {
  root.render(<p className="error">Missing connection token. Start the app from the desktop launcher or use the URL printed by the server.</p>);
} else {
  const client = new RpcClient(url);
  root.render(
    <StrictMode>
      <RpcProvider client={client}>
        <App />
      </RpcProvider>
    </StrictMode>,
  );
}
