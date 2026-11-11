import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getConfig } from './config.js';

const { Pool } = pg;

/**
 * `db/migrations` 住在**隔壁的 repo**（`cre8-protocol/db`），所以預設路徑相對這個模組解析：
 * `src/db.ts` 與 `dist/db.js` 都在 `backend/` 底下兩層。`backend/README.md` 說明 db/ 要 checkout 在旁邊。
 *
 * ⚠ 但這在容器裡會失效：Docker 的 build context 只有 `backend/`，`../db/migrations` 不存在。
 * 所以允許 `MIGRATIONS_DIR` 覆寫 —— 兩條路都留著：
 *
 *   * 本機 / CI：省略，走預設的相對路徑
 *   * 容器：把 migration 檔一起放進 image，並設 `MIGRATIONS_DIR=/app/migrations`
 *
 * 另一條路是「migration 當成部署步驟，不由容器執行」（見 `docs/deploy-railway.zh-TW.md`）——
 * 這在只有 backend 建置脈絡時是唯一可行的做法。
 */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR?.trim() !== undefined && process.env.MIGRATIONS_DIR?.trim() !== ''
    ? (process.env.MIGRATIONS_DIR as string)
    : fileURLToPath(new URL('../../db/migrations/', import.meta.url));

/** App-wide advisory lock so two processes never apply migrations at the same time. */
const MIGRATION_LOCK_ID = 8_121_956_001;

let pool: PgPool | null = null;

export function getPool(): PgPool {
  if (pool) return pool;

  const { databaseUrl } = getConfig();
  pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'cre8-atp-backend',
  });
  pool.on('error', (err: Error) => {
    // An idle client died (network blip, server restart). The pool discards it; log and move on.
    console.error(JSON.stringify({ level: 'error', msg: 'idle postgres client error', error: err.message }));
  });
  return pool;
}

/** Thin helper so the rest of the app never touches the pool directly. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, [...params]);
}

/** Run `fn` inside BEGIN/COMMIT; rolls back on any throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {
      // The connection may already be dead; the original error is the one worth reporting.
    });
    throw err;
  } finally {
    client.release();
  }
}

export type MigrationResult = {
  /** Filenames applied by this call, in order. Empty when everything was already up to date. */
  applied: string[];
};

/**
 * Apply pending migrations in filename order. Each file runs in its own transaction together with
 * its schema_migrations row, so a failed migration leaves no partial schema and no record.
 *
 * The sha256 of every applied file is stored. Editing an applied migration is an error: create a
 * new numbered file instead (see db/README.md).
 */
export async function migrate(): Promise<MigrationResult> {
  const files = await listMigrationFiles();
  const client = await getPool().connect();

  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await client.query(`
        create table if not exists schema_migrations (
          filename   text        primary key,
          checksum   text        not null,
          applied_at timestamptz not null default now()
        )
      `);

      const existing = await client.query<{ filename: string; checksum: string }>(
        'select filename, checksum from schema_migrations',
      );
      const applied = new Map(existing.rows.map((row) => [row.filename, row.checksum]));
      const ran: string[] = [];

      for (const file of files) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const previous = applied.get(file);

        if (previous !== undefined) {
          if (previous !== checksum) {
            throw new Error(
              `migration ${file} was modified after it was applied ` +
                `(recorded ${previous}, file ${checksum}); add a new migration instead`,
            );
          }
          continue;
        }

        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [
            file,
            checksum,
          ]);
          await client.query('commit');
        } catch (err) {
          await client.query('rollback').catch(() => {});
          throw new Error(`migration ${file} failed: ${errorMessage(err)}`, { cause: err });
        }
        ran.push(file);
      }

      return { applied: ran };
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** Close the pool (graceful shutdown, tests, CLI). Safe to call when no pool was ever created. */
export async function closePool(): Promise<void> {
  const current = pool;
  if (!current) return;
  pool = null;
  await current.end();
}

export function isUniqueViolation(err: unknown): boolean {
  return errorCode(err) === '23505';
}

export function isForeignKeyViolation(err: unknown): boolean {
  return errorCode(err) === '23503';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

async function listMigrationFiles(): Promise<string[]> {
  try {
    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    throw new Error(`cannot read migrations at ${MIGRATIONS_DIR}: ${errorMessage(err)}`, { cause: err });
  }
}
