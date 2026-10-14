export type ErrorCode =
  | 'unauthenticated'
  | 'not_a_member'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'idempotency_conflict'
  | 'insufficient_funds'
  | 'invalid_state'
  | 'separation_of_duties'
  | 'channel_not_allowed'
  | 'rate_limited'
  | 'conflict'
  | 'confirmation_required';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  not_a_member: 403,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  idempotency_conflict: 409,
  insufficient_funds: 422,
  invalid_state: 409,
  separation_of_duties: 403,
  channel_not_allowed: 403,
  rate_limited: 429,
  conflict: 409,
  confirmation_required: 428,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Ce que l'appelant doit savoir pour continuer (le défi d'une confirmation forte). */
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    if (details) this.details = details;
  }
}
