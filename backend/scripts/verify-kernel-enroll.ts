// End-to-end verification of the Kernel v3.3 smart-account deploy + enroll path, against a running
// Anvil fork of BSC mainnet (chain 56). Every item prints PASS/FAIL and any FAIL exits non-zero.
//
// It uses a fixed wallet so a second run takes the idempotent path instead of creating new rows,
// and it derives every expected value (counterfactual address, on-chain strategy id, pinned
// version) from what the run actually produced / from the DB, never from a hardcoded constant.
//
// Run with:
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cre8_atp \
//   RPC_URL=http://127.0.0.1:8545 \
//   OPERATOR_PRIVATE_KEY=0x... REGISTRY_ADDRESS=0x... CHAIN_ID=56 \
//   EXECUTOR_ADDRESS=0x... SESSION_KEY_MASTER_SEED=0x...(64 hex) \
//   bun run scripts/verify-kernel-enroll.ts
//
// The two session-key env vars are checked first (section [0]): enroll now installs a session-key
// permission at deploy time, so without them every later section would fail for one root cause.
// ECDSA_SIGNER_CONTRACT 由 SDK 的 root 匯出（`@zerodev/permissions/constants` 不是一個 exports subpath），
// 所以這裡不寫死地址：期望值跟著 SDK 走，SDK 換版本時檢查會跟著換。
import { ECDSA_SIGNER_CONTRACT } from '@zerodev/permissions';
import { toEmptyECDSASigner } from '@zerodev/permissions/signers';
import { concatHex, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';

import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';
import { deploySmartAccount, getChain } from '../src/chain.js';
import { requireSessionKeyConfig } from '../src/config.js';
import { closePool, query } from '../src/db.js';
import { computeCounterfactualAddress, computeSalt } from '../src/kernel.js';
import { buildSessionPermissions, deriveSessionKey, sessionKeyIndexFor } from '../src/permissions.js';
import type { SessionPolicySnapshot } from '../src/permissions.js';
import { enrollPortfolio } from '../src/portfolios.js';

/** Strategy under verification; must be mirrored on chain with at least one published version. */
const STRATEGY_ID = Number(process.env.STRATEGY_ID ?? 11);
/** Fixed wallet: anvil account #2. Re-running must hit the idempotent path, not create new rows. */
const WALLET = (process.env.VERIFY_WALLET ?? '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC') as Address;
/** Probe owner for the R1 check: anvil account #1, deliberately a different owner than WALLET. */
const PROBE_OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'enrollments',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'strategyId', type: 'uint256' },
      { name: 'version', type: 'uint16' },
      { name: 'paused', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isEnrolled',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
] as const;

const KERNEL_ACCOUNT_ABI = [
  {
    type: 'function',
    name: 'rootValidator',
    inputs: [],
    outputs: [{ name: '', type: 'bytes21' }],
    stateMutability: 'view',
  },
  {
    // 安裝在帳戶上的權限（ValidationManager.PermissionConfig）：
    //   permissionFlag — 三層 policy 共用的 flag。
    //   signer         — **簽章器合約**位址（ECDSA_SIGNER_CONTRACT）的 32-byte word，不是 session key 的 EOA。
    //                    session key 的 EOA 只以 `getSignerData()` 的形式經 toSignerId 進 permissionId，
    //                    不會出現在這裡 —— 所以拿這個欄位比 session key EOA 是類型錯誤，永遠不會相等。
    //   policyData     — 每一層 policy 的 (flag ++ 合約地址 + 參數)。
    // 這個欄位只能證明「有東西被安裝」，綁定證明要看 permissionId（見 [7] 的 B 檢查）。
    type: 'function',
    name: 'permissionConfig',
    inputs: [{ name: 'pId', type: 'bytes4' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'permissionFlag', type: 'bytes2' },
          { name: 'signer', type: 'address' },
          { name: 'policyData', type: 'bytes22[]' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

/** Kernel v3 reads an account's owner from the validator's storage, not from the account itself. */
const ECDSA_VALIDATOR_ABI = [
  {
    type: 'function',
    name: 'ecdsaValidatorStorage',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

/** One PASS/FAIL line, collected for the exit code and the trailing summary. */
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
}

function errMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

type Snapshot = { block: bigint; portfolios: number; accounts: number; sessionKeys: number };

/** Row counts for this (wallet, strategy) pair plus the current block height. */
async function snapshot(wallet: string): Promise<Snapshot> {
  const { publicClient } = getChain();
  const portfolios = await query<{ c: number }>(
    `select count(*)::int as c from portfolios where user_id = $1 and strategy_id = $2`,
    [wallet, STRATEGY_ID],
  );
  const accounts = await query<{ c: number }>(
    `select count(*)::int as c
       from smart_accounts s
       join portfolios p on p.id = s.portfolio_id
      where p.user_id = $1 and p.strategy_id = $2`,
    [wallet, STRATEGY_ID],
  );
  const sessionKeys = await query<{ c: number }>(
    `select count(*)::int as c
       from session_keys k
       join portfolios p on p.id = k.portfolio_id
      where p.user_id = $1 and p.strategy_id = $2`,
    [wallet, STRATEGY_ID],
  );
  return {
    block: await publicClient.getBlockNumber(),
    portfolios: Number(portfolios.rows[0]?.c ?? -1),
    accounts: Number(accounts.rows[0]?.c ?? -1),
    sessionKeys: Number(sessionKeys.rows[0]?.c ?? -1),
  };
}


// ---------------------------------------------------------------------------
// [0] session key env — checked first, and diagnosed by name
// ---------------------------------------------------------------------------

type SessionKeyEnv = { executorAddress: Address; masterSeed: Hex };

/**
 * 缺 env 時要「指出缺哪一個、怎麼補」，而不是讓 enroll 在 SDK 深處炸一個看不出原因的錯。
 * 這裡直接呼叫 production 的守門員，所以錯誤訊息與正式流程逐字相同。
 */
function probeSessionKeyEnv(): SessionKeyEnv | null {
  console.log('\n[0] session key env (EXECUTOR_ADDRESS + SESSION_KEY_MASTER_SEED)');
  try {
    const config = requireSessionKeyConfig();
    record(
      'session key env is configured (EXECUTOR_ADDRESS + SESSION_KEY_MASTER_SEED)',
      true,
      `executor=${config.executorAddress} seed=0x…（32 bytes，不印出內容）`,
    );
    return config;
  } catch (error) {
    record(
      'session key env is configured (EXECUTOR_ADDRESS + SESSION_KEY_MASTER_SEED)',
      false,
      `${errMessage(error)}｜請補上 EXECUTOR_ADDRESS=0x…(40 hex) 與 SESSION_KEY_MASTER_SEED=0x…(64 hex) 後重跑`,
    );
    return null;
  }
}

/** `session_keys.permissions` 的一列，只取這支腳本要驗的欄位。 */
type SessionKeyRow = {
  portfolio_id: string | number;
  key_ref: string;
  permissions: unknown;
  expires_at: Date;
  status: string;
  revoked_at: Date | null;
};

/** key_ref 的形狀：`m/44'/60'/0'/0/<index>`（index 是非 hardened 的 BIP32 child index）。 */
const KEY_REF_PATTERN = /^m\/44'\/60'\/0'\/0\/(\d+)$/;

async function readSessionKeyRow(portfolioId: number): Promise<SessionKeyRow | null> {
  const result = await query<SessionKeyRow>(
    `select portfolio_id, key_ref, permissions, expires_at, status, revoked_at
       from session_keys
      where portfolio_id = $1
      order by expires_at desc
      limit 1`,
    [portfolioId],
  );
  return result.rows[0] ?? null;
}

/** pg 把 jsonb 直接解成物件；字串也接受（不同 driver 設定），壞掉就回 null 而不是拋。 */
function asPolicySnapshot(value: unknown): SessionPolicySnapshot | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as SessionPolicySnapshot;
  } catch {
    return null;
  }
}

/**
 * 把一份 policy 快照攤成一行可比對的字串。
 *
 * 用途是證明「重建真的照著快照的參數」，而不是照 src 目前的預設值重建 —— 少了這一步，重建會因為
 * 兩邊都用同一組常數而「剛好」相等，看不出常數漂移。不能直接 stringify 整個物件：`permissions`
 * 來自 jsonb，Postgres 不保證鍵序。
 */
function policyFingerprint(p: SessionPolicySnapshot): string {
  const rule = (r: { condition: unknown; offset: unknown; params: unknown }) =>
    `${String(r.condition)}@${String(r.offset)}:${JSON.stringify(r.params)}`;
  const permission = (x: SessionPolicySnapshot['call']['permissions'][number]) =>
    `${x.callType}|${x.target.toLowerCase()}|${x.selector.toLowerCase()}|${String(x.valueLimit)}|${x.rules.map(rule).join(',')}`;

  return [
    `flag=${p.flag}`,
    `call=${p.call.policyFlag}/${p.call.policyAddress.toLowerCase()}/${p.call.policyVersion}(${p.call.permissions.map(permission).join(';')})`,
    `gas=${p.gas.policyFlag}/${p.gas.policyAddress.toLowerCase()}/${String(p.gas.allowed)}/${String(p.gas.enforcePaymaster)}/${String(p.gas.allowedPaymaster).toLowerCase()}`,
    `timestamp=${p.timestamp.policyFlag}/${p.timestamp.policyAddress.toLowerCase()}/${String(p.timestamp.validAfter)}/${String(p.timestamp.validUntil)}`,
  ].join('#');
}

/**
 * [5b] session_keys：enroll 現在會為這個 portfolio 寫下的那一列。
 * 回傳 policy 快照給 [7] 重建鏈上參數用；任何一項不成立就回 null 讓 main 收尾。
 */
async function probeSessionKeyRow(
  portfolioId: number,
  env: SessionKeyEnv | null,
): Promise<SessionPolicySnapshot | null> {
  console.log('\n[5b] session_keys — the reference enroll wrote for this portfolio');

  const row = await readSessionKeyRow(portfolioId);
  record(
    "DB session_keys has one row for this portfolio with status='active'",
    row !== null && row.status === 'active' && row.revoked_at === null,
    row === null
      ? `no session_keys row for portfolio ${portfolioId}｜若這個 portfolio 是「session key 之前」留下的舊資料，` +
        `冪等 SELECT 會直接回那個沒有安裝權限的舊帳戶 —— 請改用沒 enroll 過的 VERIFY_WALLET 重跑`
      : `status=${row.status} revoked_at=${String(row.revoked_at)}`,
  );
  if (row === null) return null;

  const match = KEY_REF_PATTERN.exec(row.key_ref);
  const index = match?.[1] === undefined ? null : BigInt(match[1]);
  record(
    "DB session_keys.key_ref is a derivation path m/44'/60'/0'/0/<index>, not key material",
    index !== null && index === sessionKeyIndexFor(WALLET, BigInt(STRATEGY_ID)),
    `key_ref=${row.key_ref} expectedIndex=${sessionKeyIndexFor(WALLET, BigInt(STRATEGY_ID)).toString()}`,
  );

  const expiresAt = new Date(row.expires_at);
  record(
    'DB session_keys.expires_at is in the future',
    Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now(),
    `expires_at=${expiresAt.toISOString()} now=${new Date().toISOString()}`,
  );

  const policy = asPolicySnapshot(row.permissions);
  const layers = (['call', 'gas', 'timestamp'] as const).filter(
    (layer) => policy !== null && typeof policy[layer] === 'object' && policy[layer] !== null,
  );
  record(
    'DB session_keys.permissions is valid JSON carrying the three policy layers (call/gas/timestamp)',
    policy !== null && layers.length === 3,
    policy === null
      ? 'permissions is not a JSON object'
      : `layers=[${layers.join(', ')}] permissionId=${String((policy as { permissionId?: unknown }).permissionId)}`,
  );
  if (policy === null) return null;

  record(
    'DB session_keys.expires_at == permissions.timestamp.validUntil == permissions.expiresAt',
    expiresAt.getTime() === policy.timestamp.validUntil * 1000 &&
      policy.expiresAt === expiresAt.toISOString(),
    `expires_at=${expiresAt.toISOString()} validUntil=${policy.timestamp.validUntil} jsonExpiresAt=${policy.expiresAt}`,
  );

  if (env === null || index === null) {
    record(
      'DB session_keys.key_ref re-derives to permissions.sessionKeyAddress (the same key)',
      false,
      'session key env or key_ref is unusable, so the derivation cannot be replayed',
    );
    return policy;
  }
  const rederived = deriveSessionKey(index, { masterSeed: env.masterSeed });
  record(
    'DB session_keys.key_ref re-derives to permissions.sessionKeyAddress (the same key)',
    rederived.address.toLowerCase() === String(policy.sessionKeyAddress).toLowerCase(),
    `derived=${rederived.address} db=${String(policy.sessionKeyAddress)}`,
  );
  return policy;
}

/**
 * [5c] enrollment_intents：這次 enrollment 在**任何鏈上動作之前**釘死的 `validUntil`。
 *
 * 這張表存在的唯一理由就是「重試要落在同一個地址」，所以真正要驗的不是「有沒有一列」，而是
 * 「表裡那一個數字 == 實際用在鏈上（session_keys.permissions.timestamp.validUntil）的那一個」。
 * 兩者相等，帳戶地址才可以只用 DB 重建；不相等就代表重試會算出另一地址，也就是孤兒帳戶的溫床。
 */
async function probeEnrollmentIntent(
  wallet: string,
  chainId: number,
  policy: SessionPolicySnapshot,
): Promise<void> {
  console.log('\n[5c] enrollment_intents — the pinned validUntil this enrollment used');

  const rows = await query<{ valid_until: string; created_at: Date }>(
    `select valid_until, created_at
       from enrollment_intents
      where user_id = $1 and strategy_id = $2 and chain_id = $3`,
    [wallet, STRATEGY_ID, chainId],
  );
  const row = rows.rows[0];
  record(
    'DB enrollment_intents has exactly one row for (wallet, strategyId, chainId)',
    row !== undefined && rows.rows.length === 1,
    row === undefined
      ? `no row for (${wallet}, ${STRATEGY_ID}, ${chainId})｜這個 portfolio 若是 intent 之前留下的舊資料，` +
        `請改用沒 enroll 過的 VERIFY_WALLET 重跑`
      : `rows=${rows.rows.length} valid_until=${row.valid_until} created_at=${row.created_at.toISOString()}`,
  );

  const intentValidUntil = row === undefined ? null : BigInt(row.valid_until);
  const policyValidUntil = BigInt(policy.timestamp.validUntil);
  record(
    'DB enrollment_intents.valid_until == session_keys.permissions.timestamp.validUntil (the value that went on chain)',
    intentValidUntil !== null && intentValidUntil === policyValidUntil,
    `intent=${intentValidUntil === null ? 'no row' : intentValidUntil.toString()} policy=${policyValidUntil.toString()}` +
      `｜相等才代表這個帳戶地址能只靠 DB 重建（孤兒帳戶的判準）`,
  );
}

/**
 * R1: does computeCounterfactualAddress throw for an (owner, strategyId) whose account is already
 * deployed? deploySmartAccount computes the address before its getCode guard, so if it threw the
 * idempotent re-deploy path would be unreachable. Provoked on a never-used pair so the first call
 * really deploys.
 */
async function probeR1(): Promise<Address | null> {
  console.log('\n[1] R1 probe — deploySmartAccount twice on a fresh (owner, strategyId)');

  // Fresh strategyId per run keeps the counterfactual address unused, so the first call deploys.
  const probeStrategyId = 1_000_000n + (BigInt(keccak256(toHex(`${Date.now()}:${process.pid}`))) % 1_000_000n);
  console.log(`    probe owner=${PROBE_OWNER} strategyId=${probeStrategyId}`);

  let first: { address: Address; deployed: boolean };
  try {
    first = await deploySmartAccount(PROBE_OWNER, probeStrategyId);
  } catch (error) {
    record('R1a first deploySmartAccount succeeds', false, errMessage(error));
    return null;
  }
  record(
    'R1a first deploySmartAccount really deploys',
    first.deployed === true,
    `address=${first.address} deployed=${first.deployed}`,
  );

  let second: { address: Address; deployed: boolean } | null = null;
  let thrown: unknown = null;
  try {
    second = await deploySmartAccount(PROBE_OWNER, probeStrategyId);
  } catch (error) {
    thrown = error;
  }
  record(
    'R1b second call does not throw (computeCounterfactualAddress works on a deployed account)',
    thrown === null,
    thrown === null ? 'no throw' : `threw ${errMessage(thrown)}`,
  );
  record(
    'R1c second call returns the same address with deployed=false (getCode guard is reachable)',
    second !== null && second.address === first.address && second.deployed === false,
    second === null ? 'no result' : `address=${second.address} deployed=${second.deployed}`,
  );
  return first.address;
}

async function main(): Promise<number> {
  const { publicClient, registryAddress, chainId } = getChain();

  // [0] first: enroll cannot install a permission without these two, and every later section
  // depends on that permission existing.
  const sessionEnv = probeSessionKeyEnv();

  await probeR1();

  console.log('\n[2] strategy facts read from the DB (not hardcoded)');
  const strategyRow = (
    await query<{ onchain_id: number | string | null; active_version: number | string }>(
      `select s.onchain_id, coalesce(max(v.version), 0) as active_version
         from strategies s
         left join strategy_versions v on v.strategy_id = s.id
        where s.id = $1
        group by s.id`,
      [STRATEGY_ID],
    )
  ).rows[0];
  const onchainId = Number(strategyRow?.onchain_id ?? NaN);
  const activeVersion = Number(strategyRow?.active_version ?? NaN);
  record(
    `strategy ${STRATEGY_ID} is mirrored on chain with a published version`,
    Number.isFinite(onchainId) && Number.isFinite(activeVersion) && activeVersion >= 1,
    `onchain_id=${String(strategyRow?.onchain_id)} active_version=${String(strategyRow?.active_version)}`,
  );
  if (!Number.isFinite(onchainId)) {
    record('verification can proceed (strategy has an on-chain id)', false, 'no onchain_id: aborting');
    return summarize();
  }

  console.log(`\n[3] enrollPortfolio(${STRATEGY_ID}, ${WALLET})`);
  const before = await snapshot(WALLET.toLowerCase());
  console.log(`    before: block=${before.block} portfolios=${before.portfolios} smart_accounts=${before.accounts}`);

  let portfolio;
  try {
    portfolio = await enrollPortfolio(STRATEGY_ID, WALLET);
  } catch (error) {
    record('enrollPortfolio succeeds', false, errMessage(error));
    return summarize();
  }
  const account = portfolio.smartAccounts[0];
  record('enrollPortfolio returns one smart account', portfolio.smartAccounts.length === 1, `accounts=${portfolio.smartAccounts.length}`);
  if (account === undefined) return summarize();
  const smartAccount = account.address as Address;
  record(
    'portfolio points at the requested strategy with a KERNEL smart account',
    portfolio.strategyId === STRATEGY_ID && account.accountType === 'KERNEL',
    `id=${portfolio.id} strategyId=${portfolio.strategyId} version=${portfolio.version} address=${smartAccount} accountType=${account.accountType}`,
  );
  record(
    'portfolio.user_id is the wallet EOA',
    portfolio.userId === WALLET.toLowerCase(),
    `userId=${portfolio.userId} wallet=${WALLET.toLowerCase()}`,
  );

  console.log('\n[4] on-chain assertions on the smart account');
  const code = await publicClient.getCode({ address: smartAccount });
  record('smart account has code', code !== undefined && code !== '0x', `codeLength=${code === undefined ? 'undefined' : (code.length - 2) / 2} bytes`);

  const enrollment = await publicClient.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'enrollments',
    args: [smartAccount],
  });
  record(
    'registry.enrollments(smartAccount) == (onchain_id, version, paused=false)',
    Number(enrollment[0]) === onchainId && Number(enrollment[1]) === activeVersion && enrollment[2] === false,
    `actual=(${enrollment[0]}, ${enrollment[1]}, ${enrollment[2]}) expected=(${onchainId}, ${activeVersion}, false)`,
  );

  const isEnrolled = await publicClient.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'isEnrolled',
    args: [smartAccount],
  });
  record('registry.isEnrolled(smartAccount) is true', isEnrolled === true, `isEnrolled=${isEnrolled}`);

  const rootValidator = await publicClient.readContract({
    address: smartAccount,
    abi: KERNEL_ACCOUNT_ABI,
    functionName: 'rootValidator',
  });
  const expectedRootValidator = concatHex(['0x01', KERNEL_V3_3_ADDRESSES.ecdsaValidatorV31]) as Hex;
  record(
    'rootValidator() == 0x01 ++ ecdsaValidatorV31',
    rootValidator.toLowerCase() === expectedRootValidator.toLowerCase(),
    `actual=${rootValidator} expected=${expectedRootValidator}`,
  );

  // Kernel v3.3 accounts expose no owner()/getOwner() (both revert InvalidSelector on the proxy);
  // the owner lives in the ECDSA validator's storage, keyed by account.
  const ownerViaValidator = await publicClient.readContract({
    address: KERNEL_V3_3_ADDRESSES.ecdsaValidatorV31,
    abi: ECDSA_VALIDATOR_ABI,
    functionName: 'ecdsaValidatorStorage',
    args: [smartAccount],
  });
  record(
    'smart account owner (validator storage) is the wallet EOA',
    ownerViaValidator.toLowerCase() === WALLET.toLowerCase(),
    `ecdsaValidatorStorage(${smartAccount})=${ownerViaValidator} wallet=${WALLET.toLowerCase()}`,
  );

  console.log('\n[5] DB row assertions');
  const row = (
    await query<{
      id: number;
      user_id: string;
      strategy_id: number;
      version: number;
      schedule_state: string;
      chain_id: string | number;
      address: string;
      owner: string;
      account_type: string;
    }>(
      `select p.id, p.user_id, p.strategy_id, p.version, p.schedule_state,
              s.chain_id, s.address, s.owner, s.account_type
         from portfolios p
         join smart_accounts s on s.portfolio_id = p.id
        where p.id = $1`,
      [portfolio.id],
    )
  ).rows[0];
  if (row === undefined) {
    record('DB row for the returned portfolio exists', false, `no row for portfolio id ${portfolio.id}`);
    return summarize();
  }
  record(
    "DB smart_accounts.account_type == 'KERNEL'",
    row.account_type === 'KERNEL',
    `account_type=${row.account_type}`,
  );
  record(
    'DB smart_accounts.address is lowercase and matches the deployed account',
    row.address === row.address.toLowerCase() && row.address === smartAccount.toLowerCase(),
    `db=${row.address} chain=${smartAccount.toLowerCase()}`,
  );
  record(
    'DB smart_accounts.owner and portfolios.user_id are the wallet EOA',
    row.owner === WALLET.toLowerCase() && row.user_id === WALLET.toLowerCase(),
    `owner=${row.owner} user_id=${row.user_id} wallet=${WALLET.toLowerCase()}`,
  );
  record(
    'DB smart_accounts.chain_id matches the configured chain',
    Number(row.chain_id) === chainId,
    `db=${String(row.chain_id)} configured=${chainId}`,
  );

  const storedPolicy = await probeSessionKeyRow(portfolio.id, sessionEnv);
  if (storedPolicy === null) return summarize();

  await probeEnrollmentIntent(WALLET.toLowerCase(), chainId, storedPolicy);

  console.log('\n[6] idempotency — second enrollPortfolio must change nothing');
  const beforeIdem = await snapshot(WALLET.toLowerCase());
  let repeat;
  try {
    repeat = await enrollPortfolio(STRATEGY_ID, WALLET);
  } catch (error) {
    record('second enrollPortfolio does not throw', false, errMessage(error));
    return summarize();
  }
  const afterIdem = await snapshot(WALLET.toLowerCase());
  record(
    'second enrollPortfolio returns the same portfolio id',
    repeat.id === portfolio.id,
    `first=${portfolio.id} second=${repeat.id}`,
  );
  record(
    'second enrollPortfolio sends no transaction (block height unchanged)',
    afterIdem.block === beforeIdem.block,
    `block ${beforeIdem.block} -> ${afterIdem.block}`,
  );
  record(
    'second enrollPortfolio writes no rows',
    afterIdem.portfolios === beforeIdem.portfolios && afterIdem.accounts === beforeIdem.accounts,
    `portfolios ${beforeIdem.portfolios} -> ${afterIdem.portfolios}, smart_accounts ${beforeIdem.accounts} -> ${afterIdem.accounts}`,
  );
  record(
    'second enrollPortfolio returns the same smart account',
    repeat.smartAccounts[0]?.address === account.address,
    `first=${account.address} second=${String(repeat.smartAccounts[0]?.address)}`,
  );
  record(
    'second enrollPortfolio writes no session_keys row',
    afterIdem.sessionKeys === beforeIdem.sessionKeys,
    `session_keys ${beforeIdem.sessionKeys} -> ${afterIdem.sessionKeys}`,
  );

  console.log('\n[7] the deployed account really carries the session key permission (chain)');
  // enroll 成功就代表 env 一定在（它是 enroll 的前置條件）；這一行只是把那個事實收窄給型別看，
  // 順便把「連 [0] 都缺」的情況收在已經記下 FAIL 的那一條上，不另外製造一條假檢查。
  if (sessionEnv === null) return summarize();
  {
    // Rebuild the initConfig from what the DB stored: same session key, same executor, and the same
    // validUntil instant. If the rebuild reproduces the deployed address, the DB snapshot is enough
    // to reconstruct exactly what was installed — nothing about the install lives only in memory.
    const rebuilt = await buildSessionPermissions({
      publicClient,
      sessionKeyAddress: storedPolicy.sessionKeyAddress,
      executorAddress: sessionEnv.executorAddress,
      validUntil: storedPolicy.timestamp.validUntil,
    });
    const salt = computeSalt(WALLET, BigInt(STRATEGY_ID));

    const withPermission = await computeCounterfactualAddress(publicClient, WALLET, salt, {
      initConfig: rebuilt.initConfig,
    });
    record(
      'account address == counterfactual address computed WITH the rebuilt initConfig',
      withPermission.toLowerCase() === smartAccount.toLowerCase(),
      `rebuilt=${withPermission} deployed=${smartAccount} permissionId=${rebuilt.permissionId}`,
    );

    // 這一條就是「initConfig 真的生效」的證據：沒有權限時算出來的是另一個地址，而鏈上有 code 的是
    // 有權限的那個。少了 initConfig 的部署會得到 withoutPermission，且不會有任何錯誤提示。
    const withoutPermission = await computeCounterfactualAddress(publicClient, WALLET, salt);
    record(
      'account address != the address computed WITHOUT initConfig (the permission changed the address)',
      withoutPermission.toLowerCase() !== smartAccount.toLowerCase(),
      `withoutInitConfig=${withoutPermission} deployed=${smartAccount}`,
    );

    // 重建必須照著快照的參數（尤其 validUntil＝現在時間 + 365 天重算會得到不同的 permissionId）。
    // 這一行證明上面那個 rebuilt 真的用了快照裡的 numbers，而不是靠兩邊共用同一組預設值「剛好」相等。
    const rebuiltFingerprint = policyFingerprint(rebuilt.policySnapshot);
    const snapshotFingerprint = policyFingerprint(storedPolicy);
    record(
      'rebuilt permission params are byte-identical to the DB snapshot (all three policies + validUntil)',
      rebuiltFingerprint === snapshotFingerprint,
      rebuiltFingerprint === snapshotFingerprint
        ? `fingerprint=${rebuiltFingerprint}`
        : `rebuilt=${rebuiltFingerprint}｜db=${snapshotFingerprint}`,
    );

    const permissionConfig = await publicClient.readContract({
      address: smartAccount,
      abi: KERNEL_ACCOUNT_ABI,
      functionName: 'permissionConfig',
      args: [storedPolicy.permissionId],
    });

    // A：這個欄位存的是「簽章器合約」，不是 session key 的 EOA。
    // 期望值不寫死：enroll 時 toPermissionValidator 用的就是 toEmptyECDSASigner(sessionKey).signerContractAddress，
    // 而它預設等於 SDK 的 ECDSA_SIGNER_CONTRACT（後面括號裡並列，兩者必須一致）。
    const expectedSignerContract = toEmptyECDSASigner(storedPolicy.sessionKeyAddress).signerContractAddress;
    const onchainSigner = permissionConfig.signer;
    record(
      'on-chain permissionConfig(permissionId).signer == the ECDSA signer CONTRACT (NOT the session key EOA)',
      onchainSigner.toLowerCase() === expectedSignerContract.toLowerCase() &&
        expectedSignerContract.toLowerCase() === ECDSA_SIGNER_CONTRACT.toLowerCase(),
      `onchain=${onchainSigner} expected=${expectedSignerContract} (SDK=${ECDSA_SIGNER_CONTRACT})` +
        `｜sessionKeyEOA=${storedPolicy.sessionKeyAddress}（EOA 永遠不會出現在這個欄位，它不是綁定證據）`,
    );

    // B：真正的綁定證明。permissionId = keccak256(abi.encode([toPolicyId(policies), flag, toSignerId(signer)]))[0..4]
    // 而 toSignerId = concat([signerContractAddress, session key EOA]) —— EOA 在雜湊的原像裡，所以
    // 「重建的 id == DB 的 id == 鏈上認得的 id」就是這把 session key 綁在這個 permission 上的密碼學證明。
    const rebuiltId = rebuilt.permissionValidator.getIdentifier();
    const dbId = storedPolicy.permissionId;
    const chainConfig = await publicClient.readContract({
      address: smartAccount,
      abi: KERNEL_ACCOUNT_ABI,
      functionName: 'permissionConfig',
      args: [rebuiltId],
    });
    const chainHasConfig = chainConfig.signer.toLowerCase() !== zeroAddress.toLowerCase();
    // 反向對照：改掉 1 個 byte 的 id 必須查不到東西，否則「查得到」這半邊不具鑑別力。
    const perturbedId = `${rebuiltId.slice(0, -2)}${((parseInt(rebuiltId.slice(-2), 16) ^ 0xff) & 0xff)
      .toString(16)
      .padStart(2, '0')}` as Hex;
    let perturbedHasConfig = false;
    try {
      const other = await publicClient.readContract({
        address: smartAccount,
        abi: KERNEL_ACCOUNT_ABI,
        functionName: 'permissionConfig',
        args: [perturbedId],
      });
      perturbedHasConfig = other.signer.toLowerCase() !== zeroAddress.toLowerCase();
    } catch {
      perturbedHasConfig = false; // 未知 id 直接 revert，也算「鏈上查不到」
    }
    const rebuiltEqDb = rebuiltId.toLowerCase() === String(dbId).toLowerCase();
    record(
      'rebuilt permissionId == DB permissionId == the permissionId the chain holds a config under',
      rebuiltEqDb && chainHasConfig && !perturbedHasConfig,
      `rebuilt=${rebuiltId} db=${String(dbId)} chain=${chainHasConfig ? rebuiltId : 'NO CONFIG'}` +
        `｜rebuilt${rebuiltEqDb ? '==' : '!='}db rebuilt${chainHasConfig ? '==' : '!='}chain` +
        `｜negativeControl(${perturbedId})=${perturbedHasConfig ? 'HAS CONFIG — not discriminating!' : 'empty'}`,
    );

    // C：session key 的 EOA 真的被寫進安裝 calldata（installValidations 的第 0 段）。
    const installCalldata = String(rebuilt.initConfig[0] ?? '');
    const sessionKeyHex = storedPolicy.sessionKeyAddress.toLowerCase().slice(2);
    record(
      'rebuilt initConfig[0] (installValidations) contains the session key EOA from the DB snapshot',
      installCalldata.toLowerCase().includes(sessionKeyHex),
      `sessionKey=${storedPolicy.sessionKeyAddress} calldata=${(installCalldata.length - 2) / 2} bytes` +
        ` contains=${installCalldata.toLowerCase().includes(sessionKeyHex)}`,
    );

    record(
      'on-chain permissionConfig(permissionId) carries all three policies (call/gas/timestamp)',
      permissionConfig.policyData.length === 3,
      `policyData.length=${permissionConfig.policyData.length} permissionFlag=${permissionConfig.permissionFlag}`,
    );
  }

  return summarize();
}

/** Print the tally and map it to an exit code: any FAIL exits non-zero. */
function summarize(): number {
  const failed = checks.filter((c) => !c.ok);
  const total = checks.length;
  console.log('\n' + '─'.repeat(72));
  for (const failure of failed) console.log(`FAILED: ${failure.name} — ${failure.detail}`);
  console.log(`${total - failed.length}/${total} checks PASSED`);
  console.log(failed.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  console.error(`ABORTED: ${errMessage(error)}`);
  exitCode = 1;
} finally {
  await closePool();
}
process.exit(exitCode);
