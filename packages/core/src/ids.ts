import { randomBytes } from 'node:crypto';

export type RandomSource = (size: number) => Uint8Array;

const ID_PATTERN = /^[a-z]{2,8}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * RFC 9562 UUIDv7: 48-bit Unix-ms timestamp followed by random bits.
 * Lexicographic order follows creation time, which keeps append-only logs readable.
 */
export function uuidv7(now: number = Date.now(), random: RandomSource = randomBytes): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError(`uuidv7: timestamp out of range: ${now}`);
  }
  const bytes = new Uint8Array(16);
  bytes.set(random(10).subarray(0, 10), 6);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Prefixed id such as `ev_0192…`. Prefix: 2–8 lowercase letters. */
export function newId(prefix: string, now?: number, random?: RandomSource): string {
  if (!/^[a-z]{2,8}$/.test(prefix)) throw new TypeError(`newId: invalid prefix "${prefix}"`);
  return `${prefix}_${uuidv7(now, random)}`;
}

export function isId(value: unknown, prefix?: string): value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}
