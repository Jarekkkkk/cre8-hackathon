/**
 * 把 DB 裡已存在的某個版本「補上鏈」—— 只寫鏈，不動 DB。
 *
 * ## 為什麼需要這支
 * DB 與鏈是兩份狀態，而 fork 重啟（`loadState` 載入舊 dump）只會回滾**鏈**，DB 不會。
 * 實際踩到的分裂：strategy 529 的 v2（移除 DOGE）在 DB 有、鏈上沒有 →
 * `portfolios.version = 2` 指的是一個鏈上不存在的版本，而 `/status` 讀鏈上 v1，
 * 於是畫面顯示含 DOGE 的舊目標。
 *
 * 修法是**補鏈**而不是改 DB：DB 的 v2 是使用者要的內容（無 DOGE），
 * 把它原樣發上鏈就一致了。用後端的 `publishVersionOnchain` 是為了沿用
 * `canonicalScheduleHash` —— 自己組 hash 會跟後端/合約的期望不一致。
 *
 * 用法：
 *   bun run scripts/publish-db-version.ts --strategy 529 --version 2
 */
import { query } from '../src/db.js';
import { publishVersionOnchain } from '../src/chain.js';
import type { Address } from 'viem';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const strategyId = Number(flag('strategy'));
  const versionNumber = Number(flag('version'));
  if (!Number.isInteger(strategyId) || strategyId <= 0) throw new Error('--strategy <db id> 必填');
  if (!Number.isInteger(versionNumber) || versionNumber <= 0) throw new Error('--version <n> 必填');

  const { rows } = await query<{
    onchain_id: string | number;
    allocation: { assets?: { address?: string; weightBps?: number }[] };
    schedule: unknown;
    active_at: Date | null;
  }>(
    `select s.onchain_id, v.allocation, v.schedule, v.active_at
       from strategy_versions v
       join strategies s on s.id = v.strategy_id
      where v.strategy_id = $1 and v.version = $2`,
    [strategyId, versionNumber],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`DB 沒有 strategy ${strategyId} 的 version ${versionNumber}`);
  if (row.onchain_id === null || row.onchain_id === undefined) {
    throw new Error(`strategy ${strategyId} 沒有 onchain_id，無法補鏈`);
  }

  const assets = (row.allocation.assets ?? []).map((asset) => {
    if (typeof asset.address !== 'string') throw new Error('allocation.assets[].address 不是字串');
    if (typeof asset.weightBps !== 'number') throw new Error('allocation.assets[].weightBps 不是數字');
    return { address: asset.address as Address, weightBps: asset.weightBps };
  });
  if (assets.length === 0) throw new Error('allocation 是空的');

  const schedule = row.schedule as { kind: 'interval'; intervalSeconds: number } | { kind: 'cron'; cron: string };
  const activeAt = row.active_at ?? new Date();

  console.log(`  strategy ${strategyId} (onchain ${row.onchain_id}) version ${versionNumber}`);
  console.log(`  assets: ${assets.map((asset) => `${asset.address.slice(0, 8)}:${asset.weightBps}`).join(' ')}`);
  console.log(`  schedule: ${JSON.stringify(schedule)} · activeAt ${activeAt.toISOString()}`);

  const published = await publishVersionOnchain(Number(row.onchain_id), {
    assets: assets.map((asset) => asset.address),
    weightsBps: assets.map((asset) => asset.weightBps),
    schedule,
    activeAt,
  });
  console.log(`  ✓ 已上鏈，鏈上版本號 = ${published}`);
  if (published !== versionNumber) {
    console.log(
      `  ⚠ 鏈上版本號 ${published} 與 DB 的 ${versionNumber} 不同 —— 代表鏈上多/少了版本，` +
        '要再對一次兩邊的版本序列，不要直接假設一致',
    );
  }
}

await main();
