import { getConfig } from './config.js';
import { closePool, migrate } from './db.js';
import { createServer } from './server.js';

/**
 * Entrypoint: fail fast on config, bring the schema up to date, then listen.
 *
 * ⚠ `MIGRATIONS_ENABLED=0` 會跳過 migration。
 *
 * 為什麼需要這個開關：`db/migrations` 住在**隔壁的 repo**（`cre8-protocol/db`），而容器
 * （Railway / Docker）的 build context 只有 `backend/` —— image 裡根本沒有那些 .sql 檔。
 * 沒有這個開關，容器會在啟動時死在 `ENOENT: /db/migrations`（實測）。
 *
 * 容器部署時的做法：`MIGRATIONS_ENABLED=0` + migration 當成部署步驟跑
 * （`railway run bun run src/migrate.ts`，見 docs/deploy-railway.zh-TW.md）。
 *
 * 預設是**開啟**：本機與 CI 都能照舊自動套用，不會因為忘記設變數而少跑。
 */
async function main(): Promise<void> {
  const config = getConfig();

  if (process.env.MIGRATIONS_ENABLED === '0') {
    console.log(JSON.stringify({ level: 'warn', msg: 'migrations skipped (MIGRATIONS_ENABLED=0)' }));
  } else {
    const { applied } = await migrate();
    if (applied.length > 0) {
      console.log(JSON.stringify({ level: 'info', msg: 'migrations applied', files: applied }));
    } else {
      console.log(JSON.stringify({ level: 'info', msg: 'migrations up to date' }));
    }
  }

  const server = createServer();
  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'cre8-atp-backend listening',
        port: config.port,
        chainId: config.chainId,
        rpcConfigured: config.rpcUrl !== null,
      }),
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));

    const forceExit = setTimeout(() => {
      console.error(JSON.stringify({ level: 'error', msg: 'shutdown timed out, forcing exit' }));
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
    clearTimeout(forceExit);
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'startup failed',
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }),
  );
  process.exitCode = 1;
});
