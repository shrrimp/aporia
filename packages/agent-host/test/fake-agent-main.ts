// Stdio entry point so tests can spawn the fake agent as a real subprocess.
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { fakeAgent } from './fake-agent.ts';

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
fakeAgent().connect(stream);
