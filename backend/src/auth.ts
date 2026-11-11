import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from './db.js';
import { recoverMessageAddress } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { getAuthConfig } from './config.js';
import type { AuthConfig } from './config.js';
import {
  InvalidNonceError,
  InvalidSignatureError,
  NonceExpiredError,
  SiweExpiredError,
  SiweInvalidMessageError,
  UnauthorizedError,
  ValidationError,
} from './errors.js';

/** How long a nonce challenge stays redeemable: long enough for a wallet popup, short enough to bound replay. */
export const NONCE_TTL_MS = 5 * 60 * 1_000;
/** How long a session token stays valid. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
/**
 * Tolerance for a client clock that is ahead of ours. A wallet builds `issuedAt` on the user's
 * machine, so an exact comparison would reject honest clients with a fast clock.
 */
export const SIWE_CLOCK_SKEW_MS = 2 * 60 * 1_000;
/** EIP-4361 message version. Part of the wire contract: parsers must see `Version: 1`. */
export const SIWE_VERSION = '1';
/** EIP-4361 `statement` (the human-readable line the wallet shows). Part of the auth contract. */
export const SIWE_STATEMENT = 'Sign in to CRE8';

/** 32 random bytes as hex (64 chars), for both nonces and session tokens. */
function randomToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * What POST /auth/nonce hands to the client. The client passes every field back into
 * `createSiweMessage` from viem (plus its own address and `issuedAt`) and signs the result:
 *
 *   createSiweMessage({ address, chainId, domain, uri, statement, nonce, version, issuedAt })
 *
 * The signing address is the client's, so the server never guesses it — that keeps one message
 * shape for EOA and smart-account wallets.
 */
export type SiweChallenge = {
  /** 32-byte random hex nonce; alphanumeric as EIP-4361 requires, single use. */
  nonce: string;
  /** EIP-4361 `domain`; must come back unchanged. */
  domain: string;
  /** EIP-4361 `chain ID`; the wallet must be on this chain. */
  chainId: number;
  /** EIP-4361 `uri`; the resource the sign-in is for. */
  uri: string;
  /** EIP-4361 `statement`; must come back unchanged. */
  statement: string;
  /** EIP-4361 `version`, always "1". */
  version: typeof SIWE_VERSION;
  /** Server time at issuance; clients may use it as `issuedAt` so a skewed local clock is moot. */
  issuedAt: string;
  /** ISO-8601 instant after which the nonce is rejected with NONCE_EXPIRED. */
  expiresAt: string;
};

export type SessionCredentials = {
  /** Bearer token for the Authorization header. */
  token: string;
  expiresAt: string;
};

export type LoginCredentials = {
  /** Complete EIP-4361 message, exactly as signed. */
  message: string;
  /** 65-byte signature over the EIP-191 hash of that message. */
  signature: string;
};

/** Where sessions are persisted. Injected so unit tests need no database. */
export type SessionRepository = {
  save(tokenHash: string, wallet: string, expiresAt: Date): Promise<void>;
  /** `null` = unknown or expired. The caller treats both the same (401). */
  find(tokenHash: string): Promise<{ wallet: string; expiresAt: Date } | null>;
  remove(tokenHash: string): Promise<void>;
  /** Best-effort cleanup of expired rows. Never throws into the request path. */
  prune(now: Date): Promise<void>;
};

export type AuthStoreOptions = {
  /** Injectable clock (ms since epoch). Tests use it to expire nonces and sessions without waiting. */
  now?: () => number;
  /** Override the SIWE binding (domain/uri/chainId). Defaults to the process config. */
  auth?: AuthConfig;
  /** Session persistence. Defaults to Postgres; tests pass an in-memory fake. */
  sessions?: SessionRepository;
};

type NonceEntry = { expiresAt: number };
type SessionEntry = { wallet: string; expiresAt: number };

/** Fields of a parsed EIP-4361 message that survived structural validation. */
type ParsedSiwe = {
  address: string;
  domain: string;
  uri: string;
  chainId: number;
  nonce: string;
  statement: string;
  issuedAt: Date;
  expirationTime?: Date;
  notBefore?: Date;
};

/**
 * In-memory nonce and session store, plus EIP-4361 verification.
 *
 * Nonces stay in the process (5-minute lifetime, single-use, no value after the login round).
 * **Sessions live in Postgres** (`auth_sessions`): keeping them in memory meant every restart logged
 * everyone out, and a second instance would reject the first instance's tokens.
 *
 * The token itself is never stored — `sha256(token)` is. A database dump then leaks hashes, not
 * usable sessions.
 */

/** `sha256(token)` 的十六進位。**存這個，不存 token** —— DB 洩漏不等於 session 洩漏。 */
export function sha256Hex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Postgres 版本的 session 存放區。
 *
 * 為什麼是 DB 而不是 Redis：這個部署已經有 Postgres，而 session 的寫入頻率是「每次登入一次」、
 * 讀取頻率是「每個請求一次」—— 一張小表 + 主鍵查詢完全夠。多一個 Redis 只是多一個要維運的東西。
 *
 * `find` 用 `now()` 過濾：**過期由資料庫判斷**，不是由應用程式的時鐘。兩個實例的時鐘差幾秒時，
 * 使用者不會在 A 還能用、在 B 不能用。
 */
export class PostgresSessionRepository implements SessionRepository {
  async save(tokenHash: string, wallet: string, expiresAt: Date): Promise<void> {
    await query(
      `insert into auth_sessions (token_hash, wallet, expires_at)
       values ($1, $2, $3)
       on conflict (token_hash) do update set wallet = excluded.wallet, expires_at = excluded.expires_at`,
      [tokenHash, wallet.toLowerCase(), expiresAt],
    );
  }

  async find(tokenHash: string): Promise<{ wallet: string; expiresAt: Date } | null> {
    const result = await query<{ wallet: string; expires_at: Date }>(
      'select wallet, expires_at from auth_sessions where token_hash = $1 and expires_at > now()',
      [tokenHash],
    );
    const row = result.rows[0];
    return row === undefined ? null : { wallet: row.wallet, expiresAt: row.expires_at };
  }

  async remove(tokenHash: string): Promise<void> {
    await query('delete from auth_sessions where token_hash = $1', [tokenHash]);
  }

  async prune(now: Date): Promise<void> {
    await query('delete from auth_sessions where expires_at <= $1', [now]);
  }
}

/** 認證相關的 import（放在檔案尾端的 class 之前，避免動到既有順序）。 */
export class AuthStore {
  readonly #now: () => number;
  readonly #auth: AuthConfig;
  readonly #nonces = new Map<string, NonceEntry>();
  readonly #sessions: SessionRepository;

  constructor(options: AuthStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#auth = options.auth ?? getAuthConfig();
    this.#sessions = options.sessions ?? new PostgresSessionRepository();
  }

  /** The bindings this store accepts, so the HTTP layer and clients describe the same challenge. */
  get auth(): AuthConfig {
    return this.#auth;
  }

  /** Mint a fresh single-use nonce valid for NONCE_TTL_MS, together with its SIWE fields. */
  issueNonce(): SiweChallenge {
    this.#pruneExpired();
    const nonce = randomToken();
    const now = this.#now();
    const expiresAt = now + NONCE_TTL_MS;
    this.#nonces.set(nonce, { expiresAt });
    return {
      nonce,
      domain: this.#auth.authDomain,
      chainId: this.#auth.chainId,
      uri: this.#auth.authUri,
      statement: SIWE_STATEMENT,
      version: SIWE_VERSION,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Redeem a signed EIP-4361 message for a session token:
   *   1. the message must parse and be bound to this deployment (domain/uri/chainId/statement/version),
   *   2. its nonce must exist (INVALID_NONCE) and be unexpired (NONCE_EXPIRED),
   *   3. issuedAt/expirationTime must be current (SIWE_EXPIRED),
   *   4. the signature must recover to the address inside the message (INVALID_SIGNATURE),
   *   5. the nonce is then deleted, so it can never mint a second session.
   * Sessions live SESSION_TTL_MS; the returned wallet is lowercased and is the only trusted
   * identity for provider-scoped writes.
   */
  async login(message: string, signature: string): Promise<SessionCredentials> {
    const parsed = this.#parseMessage(message);

    // Bind the message to this deployment before touching the nonce: a phishing message must not
    // be able to consume a challenge the user is legitimately trying to redeem.
    if (parsed.domain.toLowerCase() !== this.#auth.authDomain.toLowerCase()) {
      throw new SiweInvalidMessageError(
        `SIWE message domain "${parsed.domain}" does not match this server (${this.#auth.authDomain})`,
      );
    }
    if (parsed.uri !== this.#auth.authUri) {
      throw new SiweInvalidMessageError(
        `SIWE message uri "${parsed.uri}" does not match this server (${this.#auth.authUri})`,
      );
    }
    if (parsed.chainId !== this.#auth.chainId) {
      throw new SiweInvalidMessageError(
        `SIWE message chainId ${parsed.chainId} does not match this server (${this.#auth.chainId})`,
      );
    }
    if (parsed.statement !== SIWE_STATEMENT) {
      throw new SiweInvalidMessageError(`SIWE message statement must be "${SIWE_STATEMENT}"`);
    }

    const challenge = this.#nonces.get(parsed.nonce);
    if (challenge === undefined) {
      throw new InvalidNonceError(
        'nonce is unknown or was already used; request a new one from POST /auth/nonce',
      );
    }
    const now = this.#now();
    if (challenge.expiresAt <= now) {
      this.#nonces.delete(parsed.nonce);
      throw new NonceExpiredError('nonce has expired; request a new one from POST /auth/nonce');
    }

    this.#assertMessageIsCurrent(parsed, now);

    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      // Malformed hex, wrong length, bad v — all the same answer to the caller.
      throw new InvalidSignatureError('signature could not be verified for this wallet');
    }

    if (recovered.toLowerCase() !== parsed.address.toLowerCase()) {
      throw new InvalidSignatureError('signature does not match the address in the SIWE message');
    }

    this.#nonces.delete(parsed.nonce);

    const wallet = parsed.address.toLowerCase();
    const token = randomToken();
    const expiresAt = now + SESSION_TTL_MS;
    // 先把過期列清掉：這是唯一的寫入路徑，順手做就不需要一個背景排程。
    await this.#sessions.prune(new Date(now)).catch(() => undefined);
    await this.#sessions.save(sha256Hex(token), wallet, new Date(expiresAt));
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Resolve `Authorization: Bearer <token>` to the session wallet (lowercase).
   * Every failure — missing header, wrong scheme, unknown or expired token — is 401 UNAUTHORIZED.
   */
  async authenticate(authHeader: string | null | undefined): Promise<string> {
    const token = parseBearerToken(authHeader);
    const tokenHash = sha256Hex(token);

    const session = await this.#sessions.find(tokenHash);
    if (session === null) throw unauthorized('missing or invalid session token');
    if (session.expiresAt.getTime() <= this.#now()) {
      // 過期列留著也不會被接受（上面已經擋掉），這裡刪掉只是不要讓它累積。
      await this.#sessions.remove(tokenHash).catch(() => undefined);
      throw unauthorized('session token has expired');
    }

    return session.wallet;
  }

  /** Drop expired nonces (sessions are pruned by the repository). Called on the write paths. */
  #pruneExpired(): void {
    const now = this.#now();
    for (const [nonce, entry] of this.#nonces) {
      if (entry.expiresAt <= now) this.#nonces.delete(nonce);
    }
  }

  /**
   * Structural parse of an EIP-4361 message. `parseSiweMessage` returns a partial object, so every
   * field the auth contract depends on is checked for presence and shape here.
   */
  #parseMessage(message: string): ParsedSiwe {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new SiweInvalidMessageError('message is required and must be a non-empty string');
    }

    const parsed = parseSiweMessage(message);

    if (typeof parsed.version !== 'string' || parsed.version !== SIWE_VERSION) {
      throw new SiweInvalidMessageError(`SIWE message version must be "${SIWE_VERSION}"`);
    }
    if (typeof parsed.address !== 'string' || !ADDRESS_PATTERN.test(parsed.address)) {
      throw new SiweInvalidMessageError('SIWE message must carry a 0x-prefixed 20-byte address');
    }
    if (typeof parsed.domain !== 'string' || parsed.domain === '') {
      throw new SiweInvalidMessageError('SIWE message is missing its domain');
    }
    if (typeof parsed.uri !== 'string' || parsed.uri === '') {
      throw new SiweInvalidMessageError('SIWE message is missing its uri');
    }
    if (
      typeof parsed.chainId !== 'number' ||
      !Number.isSafeInteger(parsed.chainId) ||
      parsed.chainId < 1
    ) {
      throw new SiweInvalidMessageError('SIWE message is missing a valid Chain ID');
    }
    if (typeof parsed.nonce !== 'string' || !NONCE_PATTERN.test(parsed.nonce)) {
      throw new SiweInvalidMessageError('SIWE message is missing a valid nonce');
    }
    if (typeof parsed.statement !== 'string') {
      throw new SiweInvalidMessageError('SIWE message is missing its statement');
    }
    if (!(parsed.issuedAt instanceof Date) || Number.isNaN(parsed.issuedAt.getTime())) {
      throw new SiweInvalidMessageError('SIWE message is missing a valid Issued At');
    }

    return {
      address: parsed.address,
      domain: parsed.domain,
      uri: parsed.uri,
      chainId: parsed.chainId,
      nonce: parsed.nonce,
      statement: parsed.statement,
      issuedAt: parsed.issuedAt,
      ...(parsed.expirationTime === undefined ? {} : { expirationTime: parsed.expirationTime }),
      ...(parsed.notBefore === undefined ? {} : { notBefore: parsed.notBefore }),
    };
  }

  /**
   * `issuedAt` bounds the age of the message (a stolen message cannot outlive a nonce window) and
   * `expirationTime`/`notBefore` are honoured when the client sets them. The clock-skew allowance
   * only ever widens the window by SIWE_CLOCK_SKEW_MS.
   */
  #assertMessageIsCurrent(parsed: ParsedSiwe, now: number): void {
    const issuedAtMs = parsed.issuedAt.getTime();
    if (issuedAtMs > now + SIWE_CLOCK_SKEW_MS) {
      throw new SiweInvalidMessageError('SIWE message Issued At is in the future');
    }
    if (now - issuedAtMs > NONCE_TTL_MS + SIWE_CLOCK_SKEW_MS) {
      throw new SiweExpiredError(
        `SIWE message Issued At is older than ${NONCE_TTL_MS} ms; sign a fresh challenge`,
      );
    }

    if (parsed.expirationTime !== undefined) {
      const expiresAtMs = parsed.expirationTime.getTime();
      if (Number.isNaN(expiresAtMs)) {
        throw new SiweInvalidMessageError('SIWE message has an invalid Expiration Time');
      }
      if (expiresAtMs <= now) {
        throw new SiweExpiredError('SIWE message has passed its Expiration Time');
      }
    }

    if (parsed.notBefore !== undefined) {
      const notBeforeMs = parsed.notBefore.getTime();
      if (Number.isNaN(notBeforeMs)) {
        throw new SiweInvalidMessageError('SIWE message has an invalid Not Before');
      }
      if (notBeforeMs > now + SIWE_CLOCK_SKEW_MS) {
        throw new SiweInvalidMessageError('SIWE message is not valid yet (Not Before)');
      }
    }
  }
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** EIP-4361 nonce: alphanumeric, at least 8 characters. Our nonces are 64 hex chars. */
const NONCE_PATTERN = /^[a-zA-Z0-9]{8,}$/;

/** Validate the POST /auth/login body before any crypto runs, so shape errors are 400 and not 401. */
export function parseLoginBody(body: unknown): LoginCredentials {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('INVALID_AUTH', 'request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  return {
    message: requireField(record.message, 'message'),
    signature: requireField(record.signature, 'signature'),
  };
}

function requireField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('INVALID_AUTH', `${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function parseBearerToken(authHeader: string | null | undefined): string {
  const match = typeof authHeader === 'string' ? BEARER_PATTERN.exec(authHeader.trim()) : null;
  const token = match?.[1];
  if (token === undefined) throw unauthorized('missing or malformed Authorization header');
  return token;
}

function unauthorized(message: string): UnauthorizedError {
  return new UnauthorizedError(message);
}

/**
 * Process-wide store used by the HTTP layer. Created lazily so importing this module never forces
 * config resolution (tests that never call an auth function stay side-effect free). Tests that need
 * to expire nonces or sessions build their own `new AuthStore({ now })`; route tests go through
 * this singleton.
 */
let defaultStore: AuthStore | null = null;

function store(): AuthStore {
  defaultStore ??= new AuthStore();
  return defaultStore;
}

export function issueNonce(): SiweChallenge {
  return store().issueNonce();
}

export function login(message: string, signature: string): Promise<SessionCredentials> {
  return store().login(message, signature);
}

export function authenticate(authHeader: string | null | undefined): Promise<string> {
  return store().authenticate(authHeader);
}
