/**
 * Custom error classes for Facebook API interactions.
 *
 * Using typed errors allows callers to catch specific error types
 * and respond accordingly (e.g., retry on rate limit, abort on auth failure).
 */

/** Base class for all Facebook API errors */
export class FacebookApiError extends Error {
  constructor(
    message: string,
    public readonly code: number | undefined,
    public readonly subcode: number | undefined
  ) {
    super(message);
    this.name = "FacebookApiError";
  }
}

/**
 * Thrown when the API returns a rate-limit error.
 * Contains the recommended wait time so the caller can decide how to retry.
 */
export class RateLimitError extends FacebookApiError {
  constructor(
    message: string,
    code: number | undefined,
    subcode: number | undefined,
    public readonly retryAfterMs: number
  ) {
    super(message, code, subcode);
    this.name = "RateLimitError";
  }
}

/**
 * Thrown when the API returns an authentication/authorization error
 * (e.g., expired token, insufficient permissions).
 *
 * Facebook uses error codes 190 (expired/invalid token) and
 * 10 (permission denied) for auth-related issues.
 */
export class AuthenticationError extends FacebookApiError {
  constructor(message: string, code: number | undefined, subcode: number | undefined) {
    super(message, code, subcode);
    this.name = "AuthenticationError";
  }
}

/**
 * Thrown when input validation fails (bad date, invalid account ID, etc.).
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
