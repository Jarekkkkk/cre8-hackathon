/**
 * HTTP-shaped errors. Domain code throws these, server.ts turns them into a JSON body.
 * Keeping the status/code here means the domain layer stays free of node:http types.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

/** Request body / query string failed validation (HTTP 400). */
export class ValidationError extends AppError {
  constructor(code: string, message: string) {
    super(400, code, message);
    this.name = 'ValidationError';
  }
}

/** The requested resource does not exist (HTTP 404). */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

/** The login nonce is unknown or was already redeemed (HTTP 400, INVALID_NONCE). */
export class InvalidNonceError extends ValidationError {
  constructor(message = 'nonce is unknown or was already used') {
    super('INVALID_NONCE', message);
    this.name = 'InvalidNonceError';
  }
}

/** The login nonce is older than its TTL (HTTP 400, NONCE_EXPIRED). */
export class NonceExpiredError extends ValidationError {
  constructor(message = 'nonce has expired') {
    super('NONCE_EXPIRED', message);
    this.name = 'NonceExpiredError';
  }
}

/**
 * The EIP-4361 message is unusable: unparseable, or bound to another domain / uri / chain id /
 * statement than this deployment expects (HTTP 400, INVALID_SIWE_MESSAGE). The nonce is NOT
 * consumed, so a forged message cannot burn a caller's challenge.
 */
export class SiweInvalidMessageError extends ValidationError {
  constructor(message = 'invalid SIWE message') {
    super('INVALID_SIWE_MESSAGE', message);
    this.name = 'SiweInvalidMessageError';
  }
}

/** The EIP-4361 message is outside its validity window: issuedAt too old, or expirationTime passed (HTTP 400, SIWE_EXPIRED). */
export class SiweExpiredError extends ValidationError {
  constructor(message = 'SIWE message has expired') {
    super('SIWE_EXPIRED', message);
    this.name = 'SiweExpiredError';
  }
}

/** The caller is not authenticated (HTTP 401, UNAUTHORIZED). */
export class UnauthorizedError extends AppError {
  constructor(message = 'authentication required') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

/** The signature does not recover to the address inside the SIWE message (HTTP 401, INVALID_SIGNATURE). */
export class InvalidSignatureError extends AppError {
  constructor(message = 'signature does not match the wallet') {
    super(401, 'INVALID_SIGNATURE', message);
    this.name = 'InvalidSignatureError';
  }
}

/** The caller is authenticated but may not touch this resource (HTTP 403, FORBIDDEN). */
export class ForbiddenError extends AppError {
  constructor(message = 'forbidden') {
    super(403, 'FORBIDDEN', message);
    this.name = 'ForbiddenError';
  }
}
