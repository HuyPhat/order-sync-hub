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
