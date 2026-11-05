// Thrown by auth code, mapped to HTTP in error-handler.ts. Messages are fixed text, safe to send.
export class UnauthorizedError extends Error {
  override name = 'UnauthorizedError';
}

export class ForbiddenError extends Error {
  override name = 'ForbiddenError';
  constructor() {
    super('Forbidden');
  }
}

// The Retry-After header is set by the rate limiter before this is raised.
export class TooManyRequestsError extends Error {
  override name = 'TooManyRequestsError';
  constructor() {
    super('Too many login attempts');
  }
}
