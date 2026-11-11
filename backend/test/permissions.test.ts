import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HDKey } from '@scure/bip32';
import { addressToEmptyAccount } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import {
  RpcRequestError,
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  keccak256,
  toFunctionSelector,
  toHex,
} from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { bsc } from 'viem/chains';
import { KERNEL_V3_3_ADDRESSES, SALT_DOMAIN_TAG } from '../src/addresses.js';
import { loadConfig, loadSessionKeyConfig, requireSessionKeyConfig } from '../src/config.js';
import { computeSalt, getKernelAccountParams } from '../src/kernel.js';
import {
  EXECUTOR_SELECTOR,
  MAX_SESSION_KEY_INDEX,
  SESSION_KEY_DERIVATION_PREFIX,
  SESSION_KEY_INDEX_DOMAIN_TAG,
  deriveSessionKeyFor,
  sessionKeyIndexFor,
  SESSION_CALL_POLICY_VERSION,
  SESSION_GAS_ALLOWED_WEI,
  SESSION_POLICY_FLAG,
  SESSION_VALIDITY_SECONDS,
  buildSessionPermissions,
  deriveSessionKey,
  describePolicies,
  sessionValidUntil,
} from '../src/permissions.js';

/**
 * session key 權限模組的單元測試（不需要鏈）。
 *
 * 這支檔案要釘死兩個最容易搞錯的結論：
 *   1. `plugins.regular` 決定「誰簽」但**不影響地址**；`initConfig` 才是唯一影響地址的東西。
 *   2. `permissionId` 只有 4 bytes，而且會隨 policy 順序 / signer / validUntil 改變 —— 不能當常數或唯一鍵。
 *
 * stub publicClient 的手法比照 test/kernel.test.ts：EntryPoint 的地址查詢是 revert-based，
 * 「回地址」就是「以 SenderAddressResult revert 這個 data」。
 */

const SALT_DOMAIN_TAG_FOR_TEST = SALT_DOMAIN_TAG;
const EXECUTOR = getAddress('0x60691760815C69d32c1f68146FA11669F62A4b38');
const OWNER = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
const STRATEGY_ID = 1n;
const SALT = computeSalt(OWNER, STRATEGY_ID);
const TEST_VALID_UNTIL = 1_800_000_000;

/** 測試專用的 master seed：32 bytes 的 0x11 重複。 */
const MASTER_SEED: Hex = `0x${'11'.repeat(32)}`;

type GoldenVector = { factoryData: string };

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/kernel-golden.json', import.meta.url)), 'utf8'),
) as GoldenVector;

const lower = (value: string): string => value.toLowerCase();

// ---------------------------------------------------------------------------
// stub publicClient
// ---------------------------------------------------------------------------

function senderAddressResult(address: Address): Hex {
  return concatHex([
    toFunctionSelector('SenderAddressResult(address)'),
    encodeAbiParameters([{ type: 'address' }], [address]),
  ]);
}

/**
 * 把 counterfactual 地址定義成 `keccak256(initCode)` 的後 20 bytes：init code 一變，地址就變。
 *
 * 這樣「地址沒變」就不會是 stub 亂回的巧合，而是「送進 EntryPoint 的 init code 逐 byte 相同」的推論。
 */
function initCodeStub(): PublicClient {
  return {
    chain: bsc,
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return toHex(56);
      if (method === 'eth_call') {
        const [call] = params as [{ data: Hex }];
        const [initCode] = decodeFunctionData({ abi: entryPoint07Abi, data: call.data }).args as [Hex];
        throw new RpcRequestError({
          body: {},
          url: 'stub',
          error: {
            code: 3,
            message: 'execution reverted',
            data: senderAddressResult(getAddress(`0x${keccak256(initCode).slice(26)}`)),
          },
        });
      }
      throw new Error(`stub: 不支援的 RPC method ${method}`);
    },
  } as unknown as PublicClient;
}

/** 帳戶的 sudo validator（位址由 owner 決定，與 session key 無關）。 */
async function sudoValidator() {
  return signerToEcdsaValidator(initCodeStub(), {
    signer: addressToEmptyAccount(OWNER),
    entryPoint: { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' },
    kernelVersion: KERNEL_V3_3,
  });
}

async function buildPermissions(validUntil: number = TEST_VALID_UNTIL) {
  const sessionKey = deriveSessionKey(7n, { masterSeed: MASTER_SEED });
  return buildSessionPermissions({
    publicClient: initCodeStub(),
    sessionKeyAddress: sessionKey.address,
    executorAddress: EXECUTOR,
    validUntil,
  });
}

// ---------------------------------------------------------------------------
// HD 派生
// ---------------------------------------------------------------------------

test('deriveSessionKey: 同一 portfolioId 穩定、不同 portfolioId 不同地址', () => {
  const first = deriveSessionKey(7n, { masterSeed: MASTER_SEED });
  const again = deriveSessionKey(7n, { masterSeed: MASTER_SEED });
  const other = deriveSessionKey(8n, { masterSeed: MASTER_SEED });
  const asNumber = deriveSessionKey(7, { masterSeed: MASTER_SEED });

  assert.equal(first.address, again.address, '同一條派生路徑必須得到同一把金鑰');
  assert.equal(asNumber.address, first.address, 'bigint 與 number 走同一條路徑');
  assert.notEqual(other.address, first.address, '不同 portfolioId 必須是不同金鑰，否則權限會互相重疊');
  assert.equal(getAddress(first.address), first.address, 'address 是 checksummed 的合法地址');
});

test('deriveSessionKey: keyRef 是派生路徑，而且回傳物件不含私鑰', () => {
  const derived = deriveSessionKey(7n, { masterSeed: MASTER_SEED });

  assert.equal(derived.keyRef, "m/44'/60'/0'/0/7", 'keyRef 就是 DB 要存的那個路徑字串');
  assert.match(derived.keyRef, /^m\/44'\/60'\/0'\/0\/\d+$/);
  assert.deepEqual(Object.keys(derived).sort(), ['address', 'keyRef'], '回傳只有 address 與 keyRef');

  // 真的把私鑰算出來，確認它沒有出現在回傳值裡（不是「看起來沒有」而已）。
  const child = HDKey.fromMasterSeed(hexToBytes(MASTER_SEED)).derive(derived.keyRef);
  assert.ok(child.privateKey, 'stub 自己也要導得出私鑰，否則這條斷言沒意義');
  const privateKeyHex = Buffer.from(child.privateKey).toString('hex');

  assert.equal('privateKey' in derived, false);
  assert.equal(JSON.stringify(derived).toLowerCase().includes(privateKeyHex), false, '私鑰不得出現在回傳值裡');
  assert.equal(/0x[0-9a-fA-F]{64}/.test(derived.keyRef), false, 'keyRef 不該長得像金鑰');
});

test('deriveSessionKey: portfolioId 超出非 hardened 範圍或非整數時拋錯', () => {
  assert.throws(() => deriveSessionKey(2 ** 31, { masterSeed: MASTER_SEED }), /portfolioId/);
  assert.throws(() => deriveSessionKey(-1n, { masterSeed: MASTER_SEED }), /portfolioId/);
  assert.throws(() => deriveSessionKey(1.5, { masterSeed: MASTER_SEED }), /portfolioId/);
  assert.throws(
    () => deriveSessionKey(1n, { masterSeed: '0x1234' as Hex }),
    (error: Error) => {
      assert.match(error.message, /master seed/);
      assert.match(error.message, /32 bytes/);
      return true;
    },
  );
});


// ---------------------------------------------------------------------------
// 穩定索引：重跑一致性的唯一依據（不吃 portfolioId）
// ---------------------------------------------------------------------------

test('sessionKeyIndexFor: (owner, strategyId) → 固定的非 hardened 索引，重跑必然一致', () => {
  const first = sessionKeyIndexFor(OWNER, STRATEGY_ID);
  const again = sessionKeyIndexFor(OWNER.toLowerCase() as Address, 1);

  assert.equal(first, again, '大小寫不同的同一個 owner 必須得到同一個索引');
  assert.ok(first >= 0n && first < BigInt(MAX_SESSION_KEY_INDEX), '索引必須落在 0..2^31-2（非 hardened 區間）');
  assert.notEqual(sessionKeyIndexFor(OWNER, 2n), first, '不同 strategyId 是不同的索引');
  assert.notEqual(sessionKeyIndexFor('0x000000000000000000000000000000000000dead' as Address, STRATEGY_ID), first);

  // 索引的 domain tag 與帳戶 salt 的分開：共用一顆 hash 會讓兩者的改動互相波及。
  assert.equal(SESSION_KEY_INDEX_DOMAIN_TAG.startsWith('cre8-atp:session-key'), true);
  assert.notEqual(SESSION_KEY_INDEX_DOMAIN_TAG, SALT_DOMAIN_TAG_FOR_TEST);
});

test('sessionKeyIndexFor: 大量輸入也不會離開非 hardened 區間（越界會撞到別人的金鑰）', () => {
  const owners = [
    OWNER,
    '0x0000000000000000000000000000000000000001',
    '0xffffffffffffffffffffffffffffffffffffffff',
    '0x000000000000000000000000000000000000dead',
  ] as Address[];
  const limit = BigInt(MAX_SESSION_KEY_INDEX);
  for (const owner of owners) {
    for (const strategyId of [0n, 1n, 2n, 7n, 1_000_000n, 2n ** 200n]) {
      const index = sessionKeyIndexFor(owner, strategyId);
      assert.ok(index >= 0n && index < limit, `${owner}/${strategyId} 的索引越界：${index.toString()}`);
    }
  }

  assert.throws(() => sessionKeyIndexFor('0xnot-an-address' as Address, 1n), /owner/);
  assert.throws(() => sessionKeyIndexFor(OWNER, 1.5), /strategyId/);
  assert.throws(() => sessionKeyIndexFor(OWNER, -1n), /strategyId/);
});

test('deriveSessionKeyFor: 同一 (owner, strategyId) 的地址與 key_ref 固定，重跑不會換金鑰', () => {
  const first = deriveSessionKeyFor(OWNER, STRATEGY_ID, { masterSeed: MASTER_SEED });
  const again = deriveSessionKeyFor(OWNER, STRATEGY_ID, { masterSeed: MASTER_SEED });

  assert.deepEqual(again, first, '重跑必須得到同一把金鑰，否則 initConfig 一變、地址也跟著變');
  assert.equal(first.keyRef, `${SESSION_KEY_DERIVATION_PREFIX}/${sessionKeyIndexFor(OWNER, STRATEGY_ID).toString()}`);
  assert.match(first.keyRef, /^m\/44'\/60'\/0'\/0\/\d+$/);
  assert.deepEqual(deriveSessionKey(sessionKeyIndexFor(OWNER, STRATEGY_ID), { masterSeed: MASTER_SEED }), first);
  assert.notEqual(deriveSessionKeyFor(OWNER, 2n, { masterSeed: MASTER_SEED }).address, first.address);
});

// ---------------------------------------------------------------------------
// permissionId
// ---------------------------------------------------------------------------

test('buildSessionPermissions: permissionId 是 4 bytes，且對固定輸入穩定', async () => {
  const first = await buildPermissions();
  const again = await buildPermissions();

  assert.match(first.permissionId, /^0x[0-9a-f]{8}$/, 'permissionId 只有 4 bytes');
  assert.equal(first.permissionId, again.permissionId, '同輸入必須得到同一組權限');

  // 但 validUntil 一變，permissionId 就變：timestamp policy 的資料也是 policyId 的一部分。
  // 所以它不能當常數寫死，也不能當唯一鍵。
  const later = await buildPermissions(TEST_VALID_UNTIL + 1);
  assert.notEqual(later.permissionId, first.permissionId, 'permissionId 綁著 validUntil，不是常數');
});

// ---------------------------------------------------------------------------
// policySnapshot（要進 DB 的東西）
// ---------------------------------------------------------------------------

test('buildSessionPermissions: policySnapshot 含三層 policy 與 executor target', async () => {
  const { policySnapshot } = await buildPermissions();

  // Call 層：只鎖 executor + executeRebalance selector。
  assert.equal(policySnapshot.call.permissions.length, 1);
  assert.equal(lower(policySnapshot.call.permissions[0]!.target), lower(EXECUTOR));
  assert.equal(policySnapshot.call.permissions[0]!.selector, EXECUTOR_SELECTOR);
  assert.equal(EXECUTOR_SELECTOR, '0x1b977850');
  assert.equal(policySnapshot.call.policyVersion, SESSION_CALL_POLICY_VERSION);
  assert.equal(policySnapshot.call.policyVersion, '0.0.4');

  // Gas 層：一次性 wei 預算 1e18。
  assert.equal(policySnapshot.gas.allowed, '1000000000000000000');
  assert.equal(BigInt(policySnapshot.gas.allowed), SESSION_GAS_ALLOWED_WEI);
  assert.equal(SESSION_GAS_ALLOWED_WEI, 10n ** 18n);

  // Timestamp 層：起點不限（0），終點就是 expiresAt。
  assert.equal(policySnapshot.timestamp.validAfter, 0);
  assert.equal(policySnapshot.timestamp.validUntil, TEST_VALID_UNTIL);

  assert.equal(policySnapshot.flag, SESSION_POLICY_FLAG);
  assert.equal(policySnapshot.flag, '0x0000');
  assert.equal(policySnapshot.entryPoint, KERNEL_V3_3_ADDRESSES.entryPointV07);
});

test('buildSessionPermissions: policySnapshot 是 JSON-safe、可原樣存進 DB 再讀回', async () => {
  const { policySnapshot } = await buildPermissions();

  // bigint 不能 JSON 化，所以快照裡一律是字串；這裡連「有沒有漏掉 bigint」一起驗。
  const roundTripped = JSON.parse(JSON.stringify(policySnapshot)) as unknown;
  assert.deepEqual(roundTripped, policySnapshot, '快照必須能 JSON round-trip（DB 的 jsonb 欄位）');

  // 三層 policy 各自的合約地址都在：換 policy 版本時地址不同，不記下來就重建不出來。
  assert.match(policySnapshot.call.policyAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.match(policySnapshot.gas.policyAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.match(policySnapshot.timestamp.policyAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(policySnapshot.call.policyAddress, policySnapshot.gas.policyAddress);

  // CallPolicy 的地址是「由版本決定」的，toCallPolicy 不會把它放進 policyParams ——
  // 這裡把 0.0.4 的合約地址釘死，免得快照裡存了一個 undefined 卻沒人發現。
  assert.equal(
    lower(policySnapshot.call.policyAddress),
    '0x9a52283276a0ec8740df50bf01b28a80d880eaf2',
    'CallPolicy v0.0.4 的合約地址必須進快照',
  );
});

test('buildSessionPermissions: expiresAt 等於 validUntil', async () => {
  const { expiresAt, policySnapshot } = await buildPermissions();

  assert.equal(expiresAt.getTime(), TEST_VALID_UNTIL * 1000);
  assert.equal(policySnapshot.timestamp.validUntil, Math.floor(expiresAt.getTime() / 1000));
  assert.equal(policySnapshot.expiresAt, expiresAt.toISOString());
});

test('describePolicies 與 buildSessionPermissions 用的是同一組參數（沒有第二份定義）', async () => {
  const { policySnapshot } = await buildPermissions();
  const described = describePolicies({ executorAddress: EXECUTOR, validUntil: TEST_VALID_UNTIL });

  assert.deepEqual(described, {
    version: policySnapshot.version,
    entryPoint: policySnapshot.entryPoint,
    kernelVersion: policySnapshot.kernelVersion,
    flag: policySnapshot.flag,
    call: policySnapshot.call,
    gas: policySnapshot.gas,
    timestamp: policySnapshot.timestamp,
  });
});

test('sessionValidUntil: 預設有效期是 365 天', () => {
  assert.equal(SESSION_VALIDITY_SECONDS, 365 * 24 * 60 * 60);
  assert.equal(sessionValidUntil(1_000), 1_000 + SESSION_VALIDITY_SECONDS);
});

// ---------------------------------------------------------------------------
// 本檔最關鍵：只有 initConfig 會改變地址
// ---------------------------------------------------------------------------

test('只有 initConfig 改變 counterfactual 地址；plugins.regular 不改變（逐 byte 相同）', async () => {
  const { permissionValidator, initConfig } = await buildPermissions();
  const sudo = await sudoValidator();

  const baseline = await getKernelAccountParams(initCodeStub(), OWNER, SALT);
  const regularOnly = await getKernelAccountParams(initCodeStub(), OWNER, SALT, {
    plugins: { sudo, regular: permissionValidator },
  });
  const both = await getKernelAccountParams(initCodeStub(), OWNER, SALT, {
    plugins: { sudo, regular: permissionValidator },
    initConfig,
  });
  const initConfigOnly = await getKernelAccountParams(initCodeStub(), OWNER, SALT, { initConfig });

  // 1. 帳戶本身沒有變：不傳 options 時仍然逐 byte 等於 golden vector（904 hex）。
  assert.equal(lower(baseline.factoryData), lower(golden.factoryData), '不傳 options 必須與 fixture 相同');

  // 2. 只加 plugins.regular：誰簽變了，但地址與 init code 都沒變。
  assert.equal(
    lower(regularOnly.factoryData),
    lower(baseline.factoryData),
    'plugins.regular 不得進入 init code —— 它決定誰簽，不是裝了什麼',
  );
  assert.equal(regularOnly.address, baseline.address, 'plugins.regular 不得改變 counterfactual 地址');
  assert.equal(regularOnly.factory, baseline.factory);

  // 3. 加上 initConfig：地址真的變了，而且 factoryData 也變了。
  assert.notEqual(lower(both.factoryData), lower(baseline.factoryData), 'initConfig 必須進入 init code');
  assert.notEqual(both.address, baseline.address, 'initConfig 必須改變 counterfactual 地址');

  // 4. initConfig 一個人就足以決定新地址：plugins.regular 不參與地址推導。
  assert.equal(initConfigOnly.address, both.address, 'initConfig 是唯一影響地址的東西');
  assert.equal(lower(initConfigOnly.factoryData), lower(both.factoryData));
});

test('buildSessionPermissions: initConfig 是兩筆 calldata（安裝權限 + delegatecall 授權）', async () => {
  const { initConfig } = await buildPermissions();

  assert.equal(initConfig.length, 2, 'installValidations(...) 與 delegatecall(grantAccess(...)) 各一筆');
  for (const entry of initConfig) {
    assert.match(entry, /^0x[0-9a-fA-F]+$/, '每筆都必須是 hex calldata');
  }
  // 第一筆是帳戶上的 installValidations；換了它，init code 就不同，地址才會不同。
  assert.equal(initConfig[0]!.slice(0, 10), '0x9198bdf5');
  assert.equal(initConfig[1]!.slice(0, 10), '0xe9ae5c53', '第二筆是 EntryPoint v0.7 的 delegatecall');
});

test('buildSessionPermissions: 參數不對時拋錯，而不是算出一個看起來正常的結果', async () => {
  const sessionKey = deriveSessionKey(7n, { masterSeed: MASTER_SEED });
  const base = {
    publicClient: initCodeStub(),
    sessionKeyAddress: sessionKey.address,
    executorAddress: EXECUTOR,
    validUntil: TEST_VALID_UNTIL,
  };

  await assert.rejects(
    () => buildSessionPermissions({ ...base, executorAddress: '0xnot-an-address' as Address }),
    /executorAddress/,
  );
  await assert.rejects(
    () => buildSessionPermissions({ ...base, sessionKeyAddress: '' as Address }),
    /sessionKeyAddress/,
  );
  await assert.rejects(
    () => buildSessionPermissions({ ...base, validUntil: 1.5 }),
    /validUntil/,
  );
  await assert.rejects(
    () => buildSessionPermissions({ ...base, publicClient: undefined as unknown as PublicClient }),
    /publicClient/,
  );
});

// ---------------------------------------------------------------------------
// env：未設時不影響任何東西，需要時才炸
// ---------------------------------------------------------------------------

test('loadSessionKeyConfig: 兩個 env 都未設時是 null，不影響既有 config', () => {
  assert.deepEqual(loadSessionKeyConfig({}), { executorAddress: null, sessionKeyMasterSeed: null });

  // 既有 loadConfig 的形狀沒有被動到：session key 的設定刻意不進 Config，
  // 否則 DATABASE_URL 的必填性會傳染過去，也會改到 test/strategies.test.ts 的 deepEqual。
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/cre8' });
  assert.equal('executorAddress' in config, false);
  assert.equal('sessionKeyMasterSeed' in config, false);
});

test('requireSessionKeyConfig: 缺 env 時拋出可診斷的錯誤，設好後回正規化值', () => {
  assert.throws(
    () => requireSessionKeyConfig({}),
    (error: Error) => {
      assert.match(error.message, /EXECUTOR_ADDRESS/, '訊息要指出缺哪一個');
      assert.match(error.message, /SESSION_KEY_MASTER_SEED/, '兩個都缺時要一次講完');
      return true;
    },
  );

  assert.throws(
    () => requireSessionKeyConfig({ EXECUTOR_ADDRESS: '0x60691760815C69d32c1f68146FA11669F62A4b38' }),
    /SESSION_KEY_MASTER_SEED/,
  );
  assert.throws(() => requireSessionKeyConfig({ SESSION_KEY_MASTER_SEED: MASTER_SEED }), /EXECUTOR_ADDRESS/);

  // 形狀錯的 seed 在解析階段就擋掉，不要等到派生出一組對不上帳戶的地址才發現。
  assert.throws(
    () =>
      requireSessionKeyConfig({
        EXECUTOR_ADDRESS: '0x60691760815C69d32c1f68146FA11669F62A4b38',
        SESSION_KEY_MASTER_SEED: '0xdeadbeef',
      }),
    /SESSION_KEY_MASTER_SEED/,
  );

  const resolved = requireSessionKeyConfig({
    EXECUTOR_ADDRESS: '0x60691760815C69d32c1f68146FA11669F62A4b38',
    SESSION_KEY_MASTER_SEED: MASTER_SEED.toUpperCase().replace('0X', '0x'),
  });
  assert.equal(lower(resolved.executorAddress), lower(EXECUTOR), '地址正規化成小寫');
  assert.equal(resolved.masterSeed, MASTER_SEED, 'seed 正規化成小寫 hex');
});

test('deriveSessionKey: 沒給 material 時走 requireSessionKeyConfig（缺 env 就炸）', () => {
  // 不帶第二個參數 → 預設值 evaluate 時呼叫 requireSessionKeyConfig()，讀 process.env。
  // 測試環境沒有設 SESSION_KEY_MASTER_SEED，所以必須是可診斷的錯誤而不是 undefined 例外。
  const previous = process.env.SESSION_KEY_MASTER_SEED;
  delete process.env.SESSION_KEY_MASTER_SEED;
  try {
    assert.throws(
      () => deriveSessionKey(1n),
      (error: Error) => {
        assert.match(error.message, /SESSION_KEY_MASTER_SEED/);
        return true;
      },
    );
  } finally {
    if (previous !== undefined) process.env.SESSION_KEY_MASTER_SEED = previous;
  }
});
