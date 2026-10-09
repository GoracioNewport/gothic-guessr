/**
 * Domain error carrying a machine-readable {@link ApiErrorCode} (shared/api.ts). Core services throw it; the HTTP layer
 * (server/app.ts) maps the code to a status and the `{error, message?}` body, the WebSocket layer to `{t:'error'}`.
 */
import type { ApiErrorCode } from '../../shared/api';

export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  /** Seconds the client should wait (rate limits); becomes a `Retry-After` header. */
  readonly retryAfterS?: number;

  constructor(code: ApiErrorCode, message?: string, retryAfterS?: number) {
    super(message ?? code);
    this.name = 'ApiFailure';
    this.code = code;
    if (retryAfterS !== undefined) this.retryAfterS = retryAfterS;
  }
}

/** HTTP status for an error code. */
export function statusForCode(code: ApiErrorCode): number {
  switch (code) {
    case 'auth':
      return 401;
    case 'forbidden':
    case 'banned':
    case 'not_host':
      return 403;
    case 'not_found':
      return 404;
    case 'already_played':
    case 'room_full':
    case 'room_started':
    case 'round_over':
    case 'conflict':
      return 409;
    case 'room_closed':
      return 410;
    case 'nickname_rejected':
      return 422;
    case 'rate_limited':
      return 429;
    case 'bad_request':
      return 400;
    case 'internal':
      return 500;
  }
}

/** Shorthands. */
export const fail = {
  badRequest: (message?: string): never => {
    throw new ApiFailure('bad_request', message);
  },
  notFound: (message?: string): never => {
    throw new ApiFailure('not_found', message);
  },
  forbidden: (message?: string): never => {
    throw new ApiFailure('forbidden', message);
  },
  conflict: (message?: string): never => {
    throw new ApiFailure('conflict', message);
  },
};
