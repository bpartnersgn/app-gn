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
  | 'conflict';

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
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}
