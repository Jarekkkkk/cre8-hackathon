import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, test } from 'node:test';
import { closePool, query as dbQuery } from '../src/db.js';
import { createServer } from '../src/server.js';

/**
 * `GET /health` 的告警欄位。
 *
 * 這一組**故意走真的 HTTP**（`createServer()` + 真的 Postgres），不是只測那個純函式：
 * `/health` 的價值在「一台機器 curl 得到的 JSON」，而 `status`／HTTP 碼／`alerts` 三者的關係
 * （degraded 但 **200**、`alerts: null` 不影響 status）只有在完整的請求路徑上才驗得出來。
 *
 * 為什麼 degraded 一定要是 200：把 503 用在「有 critical 告警」上，會讓負載平衡器把一個**能正常
 * 服務**的實例下線 —— 「該看一下」變成「服務中斷」。503 留給 Postgres 掛掉。
 *
 * 需要真 DB（`DATABASE_URL`）與 0013；不可用時明確 skip。
 */

type HealthBody = {
  status: 'ok' | 'degraded';
  db: 'ok' | 'down';
  chainId: number;
  alerts: { critical: number; warn: number; open: number } | null;
};

const dbSkip = await (async (): Promise<string | null> => {
  try {
    await dbQuery('select 1 from scheduler_alerts limit 0');
    return null;
  } catch (cause) {
    return `Postgres 或 0013 不可用（${cause instanceof Error ? cause.message : String(cause)}）`;
  }
})();
if (dbSkip !== null) console.warn(`[server] /health 的測試 skip：${dbSkip}`);
const dbGate = dbSkip === null ? {} : { skip: dbSkip };

/** 起一個真的伺服器（port 0 = 讓 OS 挑），回傳打 `/health` 的函式與收工用的 close。 */
async function startServer(): Promise<{ health: () => Promise<{ status: number; body: HealthBody }>; close: () => Promise<void> }> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    health: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return { status: response.status, body: (await response.json()) as HealthBody };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

after(async () => {
  await closePool().catch(() => {
    // DB 不可用時整組本來就 skip 了。
  });
});

test('GET /health：200，alerts 是計數物件，status 與「有沒有 critical」一致', dbGate, async () => {
  const { health, close } = await startServer();
  try {
    const { status, body } = await health();
    console.log(`[server] /health（一般情況）HTTP ${status} ${JSON.stringify(body)}`);

    assert.equal(status, 200, 'Postgres 活著就是 200');
    assert.equal(body.db, 'ok');
    assert.ok(body.alerts !== null, '警示表正常時 alerts 是計數物件（不是 null）');
    const alerts = body.alerts as { critical: number; warn: number; open: number };
    assert.equal(alerts.open, alerts.critical + alerts.warn);
    assert.equal(
      body.status,
      alerts.critical > 0 ? 'degraded' : 'ok',
      'critical 未解決 → degraded；否則 ok（HTTP 碼不受影響）',
    );
  } finally {
    await close();
  }
});

test('GET /health：有 critical 未解決 → status degraded，HTTP 仍是 200，alerts 計數含它', dbGate, async () => {
  // 只造一列 portfolio 無關的 critical（外鍵不需要 portfolio；收工時用它自己的 id 刪掉）。
  await dbQuery("delete from scheduler_alerts where kind = 'gas_low' and portfolio_id is null and resolved_at is null").catch(() => undefined);
  const seeded = await dbQuery<{ id: string }>(
    `insert into scheduler_alerts (kind, severity, portfolio_id, detail)
     values ('gas_low', 'critical', null, '測試用：portfolio 無關的 gas 告警')
     returning id`,
  );
  const seededId = Number(seeded.rows[0]?.id);

  const { health, close } = await startServer();
  try {
    const { status, body } = await health();
    console.log(`[server] /health（塞一筆 critical）HTTP ${status} ${JSON.stringify(body)}`);

    assert.equal(status, 200, '⚠ 服務還活著：degraded 不等於 503（503 只給 Postgres 掛掉）');
    assert.equal(body.status, 'degraded');
    assert.equal(body.db, 'ok');
    assert.ok((body.alerts?.critical ?? 0) >= 1);
    assert.ok((body.alerts?.open ?? 0) >= 1);
  } finally {
    await close();
    if (Number.isInteger(seededId)) {
      await dbQuery('delete from scheduler_alerts where id = $1', [seededId]).catch(() => undefined);
    }
  }
});

/**
 * `alerts: null`（警示表壞掉）在這裡沒有對應的 HTTP 測試：那需要一張真的壞掉的表，而共用 DB 上
 * 做不到也不該做。它的定義（讀失敗 → `alerts: null`、status 不受影響）由 `alerts.test.ts` 的
 * `healthStatusFor('ok', null)` 釘住 —— 那個函式是 `health()` 裡唯一決定 status 的地方。
 */
