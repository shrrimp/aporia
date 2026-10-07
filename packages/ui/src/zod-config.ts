import { z } from 'zod';

// The UI's CSP forbids eval; tell zod not to probe for it. Imported first by main.tsx: modules
// run in import order, and some build their schemas as they load.
z.config({ jitless: true });
