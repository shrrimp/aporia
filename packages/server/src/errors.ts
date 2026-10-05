import type { ErrorCode } from './protocol.ts';

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly data: unknown;
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
