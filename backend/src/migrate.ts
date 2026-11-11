import { closePool, migrate } from './db.js';

/** `npm run migrate`: apply pending SQL without starting the HTTP server. */
async function main(): Promise<void> {
  try {
    const { applied } = await migrate();
    console.log(
      applied.length === 0
        ? JSON.stringify({ level: 'info', msg: 'migrations up to date' })
        : JSON.stringify({ level: 'info', msg: 'migrations applied', files: applied }),
    );
  } finally {
    await closePool();
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'migration failed',
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }),
  );
  process.exitCode = 1;
});
