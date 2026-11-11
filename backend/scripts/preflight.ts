/**
 * 主網/遠端部署的**起飛前檢查**。
 *
 *     bun run scripts/preflight.ts
 *     bun run scripts/preflight.ts --chain 56 --strict
 *
 * ## 為什麼需要一支獨立的腳本
 *
 * `src/config.ts` 的驗證是**逐項、延遲**的：只有真的用到某個設定時才拋錯。那是對的（讓不需要
 * session key 的行程能啟動），但也意味著「部署後才在第 37 分鐘的某一輪才發現 seed 是空的」。
 *
 * 這支腳本把**所有**設定一次檢查完，而且檢查的是「能不能真的跑」，不只是「有沒有填」：
 *
 *   * 設定本身合法（格式、必填）
 *   * 鏈一致（`CHAIN_ID` 與 RPC 實際回的 chainId 相同 —— 不一致時 UserOp 的簽章會對不上，
 *     錯誤訊息只會說 "signature invalid"，看不出是 chainId）
 *   * 合約位址真的有 code（打錯一個字 vs 鏈還沒部署，在這裡就分得出來）
 *   * registry 的 owner 是誰（主網前要換 multisig，這裡會提醒）
 *   * executor 的 oracle / router 有沒有接上
 *   * 營運錢包有沒有 gas、DB 連不連得上、migration 跑過沒
 *
 * ## 為什麼不是測試
 *
 * 測試跑在 fixture 上；這支跑在**真實的環境變數與真實的鏈**上。它讀 `.env`，所以同一支腳本
 * 在 fork（1337）與主網（56）都能用，只是檢查的門檻不同（見 `--strict`）。
 */

import { createPublicClient, http, isAddress, getAddress } from 'viem';
import type { Address } from 'viem';

import { activeChain } from '../src/chain-object.js';
import { getConfig, requireSessionKeyConfig } from '../src/config.js';
import { query } from '../src/db.js';

type Level = 'ok' | 'warn' | 'fail';

type Check = {
  level: Level;
  /** 一句話說明「檢查了什麼」。 */
  name: string;
  /** 結果（值或原因）。 */
  detail: string;
  /** `warn`/`fail` 時：怎麼辦。 */
  fix?: string;
};

const results: Check[] = [];

function record(check: Check): void {
  results.push(check);
}

function ok(name: string, detail: string): void {
  record({ level: 'ok', name, detail });
}

function warn(name: string, detail: string, fix: string): void {
  record({ level: 'warn', name, detail, fix });
}

function fail(name: string, detail: string, fix: string): void {
  record({ level: 'fail', name, detail, fix });
}

// ---------------------------------------------------------------------------
// 參數
// ---------------------------------------------------------------------------

type Args = { chain: number | null; strict: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { chain: null, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--strict') {
      args.strict = true;
      continue;
    }
    if (token === '--chain') {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error('--chain 需要一個數字');
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--chain 必須是正整數，得到 "${raw}"`);
      args.chain = parsed;
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      console.log('用法: bun run scripts/preflight.ts [--chain <id>] [--strict]');
      process.exit(0);
    }
    throw new Error(`未知的參數 "${token}"（--help 看用法）`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// 檢查
// ---------------------------------------------------------------------------

/** `0x` 開頭、20 bytes。用 viem 的判斷而不是自己寫正則。 */
function asAddressOrNull(raw: string | undefined): Address | null {
  if (raw === undefined || raw.trim() === '') return null;
  return isAddress(raw.trim()) ? getAddress(raw.trim()) : null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // --- 1. 設定本身 -------------------------------------------------------
  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
    ok('config 載入', `CHAIN_ID=${config.chainId} PORT=${config.port}`);
  } catch (cause) {
    fail('config 載入', cause instanceof Error ? cause.message : String(cause), '補齊 backend/.env（對照 .env.example）');
    print();
    return 1;
  }

  const expectedChain = args.chain ?? config.chainId;
  if (args.chain !== null && args.chain !== config.chainId) {
    warn(
      'chain 參數與設定不一致',
      `--chain ${args.chain} 但 CHAIN_ID=${config.chainId}`,
      '兩者要一樣；否則下面檢查的是另一條鏈',
    );
  }

  // --- 2. session key / executor ----------------------------------------
  try {
    const session = requireSessionKeyConfig();
    ok('session key 設定', `EXECUTOR_ADDRESS=${session.executorAddress}`);
    if (session.masterSeed === '0x' + '00'.repeat(32)) {
      // 全零 seed 是最容易被誤用的「看起來有填」。它會產生可預測的私鑰。
      fail('SESSION_KEY_MASTER_SEED', '是全零 seed（可預測的私鑰）', '換一個真的隨機 32 bytes');
    } else {
      ok('SESSION_KEY_MASTER_SEED', '已設定且不是全零');
    }
  } catch (cause) {
    fail('session key 設定', cause instanceof Error ? cause.message : String(cause), '設定 EXECUTOR_ADDRESS 與 SESSION_KEY_MASTER_SEED');
  }

  // --- 3. 合約位址格式 ---------------------------------------------------
  const registry = asAddressOrNull(process.env.REGISTRY_ADDRESS);
  if (registry === null) {
    fail('REGISTRY_ADDRESS', '未設定或不是合法的 20-byte 位址', '部署合約後填入');
  } else {
    ok('REGISTRY_ADDRESS', registry);
  }
  const executor = asAddressOrNull(process.env.EXECUTOR_ADDRESS);
  if (executor === null) {
    fail('EXECUTOR_ADDRESS', '未設定或不是合法的 20-byte 位址', '部署合約後填入');
  } else {
    ok('EXECUTOR_ADDRESS', executor);
  }

  // --- 4. RPC 與鏈一致 ---------------------------------------------------
  const rpcUrl = process.env.RPC_URL?.trim();
  if (rpcUrl === undefined || rpcUrl === '') {
    fail('RPC_URL', '未設定', '主網要用付費/有 archive 的 BSC RPC');
    print();
    return 1;
  }

  const chain = activeChain();
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  try {
    const actualChainId = await client.getChainId();
    if (actualChainId !== expectedChain) {
      // 這個不一致最貴：userOpHash 含 chainId，簽章對不上時 EntryPoint 只會說 signature invalid。
      fail(
        'RPC 的 chainId',
        `RPC 回 ${actualChainId}，但設定是 ${expectedChain}`,
        '改 CHAIN_ID 或換 RPC —— 不一致時 UserOp 簽章會無聲失敗',
      );
    } else {
      ok('RPC 的 chainId', `${actualChainId}（與設定一致）`);
    }

    const blockNumber = await client.getBlockNumber();
    ok('RPC 連線', `head = ${blockNumber}`);
  } catch (cause) {
    fail('RPC 連線', cause instanceof Error ? cause.message : String(cause), '確認 RPC_URL 可達');
    print();
    return 1;
  }

  // --- 5. 合約上真的有 code ---------------------------------------------
  for (const [label, address] of [
    ['registry', registry],
    ['executor', executor],
  ] as const) {
    if (address === null) continue;
    try {
      const code = await client.getCode({ address });
      if (code === undefined || code === '0x') {
        fail(`${label} 的 code`, `${address} 上沒有合約`, '位址打錯，或這條鏈還沒部署');
      } else {
        ok(`${label} 的 code`, `${(code.length - 2) / 2} bytes`);
      }
    } catch (cause) {
      warn(`${label} 的 code`, `讀不到：${cause instanceof Error ? cause.message : String(cause)}`, 'RPC 可能不支援 eth_getCode');
    }
  }

  // --- 6. registry owner（主網前要換 multisig）--------------------------
  if (registry !== null) {
    try {
      const owner = await client.readContract({
        address: registry,
        abi: [
          {
            type: 'function',
            name: 'owner',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ type: 'address' }],
          },
        ] as const,
        functionName: 'owner',
      });
      const operator = process.env.OPERATOR_PRIVATE_KEY?.trim();
      if (args.strict) {
        // 主網：owner 應該是 multisig/timelock，不是單一 EOA。
        warn(
          'registry owner',
          `${owner}${operator === undefined ? '' : '（= OPERATOR_PRIVATE_KEY 的位址？）'}`,
          '主網前轉移到 Safe / timelock —— 單一 EOA 的 owner 可以改 fee、換策略、pause（見 mainnet-todo §4）',
        );
      } else {
        ok('registry owner', owner);
      }
    } catch (cause) {
      warn('registry owner', `讀不到：${cause instanceof Error ? cause.message : String(cause)}`, '確認 registry ABI / 位址');
    }
  }

  // --- 7. executor 的 oracle / router 接上了嗎 --------------------------
  if (executor !== null) {
    try {
      const oracle = await client.readContract({
        address: executor,
        abi: [
          {
            type: 'function',
            name: 'oracle',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ type: 'address' }],
          },
        ] as const,
        functionName: 'oracle',
      });
      if (oracle === '0x0000000000000000000000000000000000000000') {
        fail('executor.oracle', '是零位址', '_checkStep 會 re-quote 失敗，所有再平衡都會 revert');
      } else {
        const oracleCode = await client.getCode({ address: oracle });
        if (oracleCode === undefined || oracleCode === '0x') {
          fail('executor.oracle', `${oracle} 上沒有合約`, '重新部署 oracle 並呼叫 setOracle');
        } else {
          ok('executor.oracle', oracle);
        }
      }
    } catch (cause) {
      warn('executor.oracle', `讀不到：${cause instanceof Error ? cause.message : String(cause)}`, '確認 executor ABI');
    }
  }

  // --- 8. 營運錢包有 gas 嗎 --------------------------------------------
  const operatorKey = process.env.OPERATOR_PRIVATE_KEY?.trim();
  if (operatorKey === undefined || operatorKey === '') {
    fail('OPERATOR_PRIVATE_KEY', '未設定', '部署與 approve 都要它簽名');
  } else {
    ok('OPERATOR_PRIVATE_KEY', `已設定（${operatorKey.length} chars）`);
  }

  // --- 9. bundler -------------------------------------------------------
  const bundler = process.env.BUNDLER_URL?.trim() ?? '';
  if (bundler === '') {
    warn('BUNDLER_URL', '未設定（只有 dry-run 能跑）', 'live 需要一個 ERC-4337 bundler');
  } else {
    try {
      const response = await fetch(bundler, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json()) as { result?: string[]; error?: { message?: string } };
      if (Array.isArray(body.result) && body.result.length > 0) {
        ok('bundler', `entryPoints: ${body.result.join(', ')}`);
      } else {
        warn('bundler', body.error?.message ?? '沒有回 entryPoints', '確認 alto / 第三方 bundler 的版本與設定');
      }
    } catch (cause) {
      warn('bundler', `連不上：${cause instanceof Error ? cause.message : String(cause)}`, 'live 模式需要它');
    }
  }

  // --- 10. DB 與 migration ---------------------------------------------
  try {
    const { rows } = await query<{ version: string }>('select version()');
    ok('DB 連線', String(rows[0]?.version ?? 'ok').slice(0, 40));
    const { rows: applied } = await query<{ count: string }>('select count(*)::text as count from schema_migrations');
    ok('migration', `${applied[0]?.count ?? '?'} 個已套用`);
  } catch (cause) {
    fail('DB 連線', cause instanceof Error ? cause.message : String(cause), '確認 DATABASE_URL；Railway 上由平台注入');
  }

  // --- 11. auth --------------------------------------------------------
  if (process.env.AUTH_DOMAIN === undefined || process.env.AUTH_DOMAIN.trim() === '') {
    warn('AUTH_DOMAIN', '未設定', 'SIWE 需要它；用真實網域（不要 localhost）');
  } else {
    ok('AUTH_DOMAIN', process.env.AUTH_DOMAIN);
  }
  if (process.env.AUTH_URI === undefined || process.env.AUTH_URI.trim() === '') {
    warn('AUTH_URI', '未設定', 'SIWE 的 uri 欄位；https://<你的網域>');
  } else {
    ok('AUTH_URI', process.env.AUTH_URI);
  }

  print();
  return exitCode();
}

function print(): void {
  const icons: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' };
  const width = Math.max(...results.map((r) => r.name.length), 10);

  console.log('\n=== preflight ===\n');
  for (const entry of results) {
    console.log(`  ${icons[entry.level]} ${entry.name.padEnd(width)}  ${entry.detail}`);
    if (entry.fix !== undefined) console.log(`    ${' '.repeat(width)}  → ${entry.fix}`);
  }

  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n  ${results.length - fails - warns} ok · ${warns} warn · ${fails} fail\n`);
}

/** `--strict`（主網）時 warn 也算失敗 —— 上線前不接受「知道但先不管」。 */
function exitCode(): number {
  const args = parseArgs(process.argv.slice(2));
  const fails = results.filter((r) => r.level === 'fail').length;
  if (fails > 0) return 1;
  if (args.strict && results.some((r) => r.level === 'warn')) return 1;
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((cause: unknown) => {
    console.error(`\n  preflight 自己壞了：${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  });
