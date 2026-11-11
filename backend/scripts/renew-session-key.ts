// Renew (re-issue) a deployed Kernel v3.3 account's session-key permission, with the UserOp signed
// by the account's **sudo owner** (the user's own EOA) instead of by a session key.
//
// ⚠ DEV / FORK ONLY. This script reads the sudo owner's private key from SUDO_PRIVATE_KEY and signs
// with it in-process. That is acceptable against an anvil fork with publicly known test keys; in
// production the owner signs inside their own wallet and the signature is relayed. Never commit a
// real key, and never put one in a file this script reads from disk.
//
// Why the permission install has to go through the account calling itself:
//   Kernel.sol gates `installValidations` / `grantAccess` on `onlyEntryPointOrSelfOrRoot`. Inside the
//   execution phase of a UserOp the account is `msg.sender` for its own outbound call, so a call whose
//   target is the account itself passes the check. `toInitConfig()` already returns the two calldata
//   pieces (`installValidations(...)`, then an ERC-7579 delegatecall-mode `execute(...)` wrapping
//   `grantAccess(...)`); this script replays exactly those bytes as two self-calls in ONE UserOp.
//
// Run (one line):
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cre8_atp \
//   RPC_URL=http://127.0.0.1:8545 BUNDLER_URL=http://127.0.0.1:3001 \
//   SESSION_KEY_MASTER_SEED=0x<64 hex> SUDO_PRIVATE_KEY=0x<64 hex> \
//   bun run backend/scripts/renew-session-key.ts --strategy-id 11
//
// Flags: --strategy-id <n> --owner <addr> --account <addr> --valid-until <unix> --key-index <n>
//        --no-prove (skip the new-key executeRebalance proof) --revoke-old (also uninstall the old id)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HDKey } from '@scure/bip32';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toECDSASigner } from '@zerodev/permissions/signers';
import {
  KernelV3_3AccountAbi,
  addressToEmptyAccount,
  createKernelAccount,
  createKernelAccountClient,
} from '@zerodev/sdk';
import { KERNEL_V3_3, VALIDATOR_TYPE } from '@zerodev/sdk/constants';
import type { GetKernelVersion } from '@zerodev/sdk/types';
import { recordRenewalResult } from '../src/renewal.js';
import { concat, isAddressEqual, pad } from 'viem';
import type { Address, Chain, Hex, PublicClient } from 'viem';
import { createPublicClient, decodeFunctionData, defineChain, encodeFunctionData, http } from 'viem';
import { hdKeyToAccount, privateKeyToAccount } from 'viem/accounts';

import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';
import { closePool, query } from '../src/db.js';
import { computeSalt } from '../src/kernel.js';
import { buildSessionPermissions, deriveSessionKey, sessionKeyIndexFor, sessionValidUntil } from '../src/permissions.js';

/** EntryPoint v0.7（`toPermissionValidator` 只接受 0.7）。 */
const ENTRY_POINT = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const BUNDLER_URL = process.env.BUNDLER_URL ?? 'http://127.0.0.1:3001';
const CHAIN_ID = 56;

/** AtpExecutor.executeRebalance(address,(...)[],uint256) —— CallPolicy 白名單裡唯一的 selector。 */
const EXECUTE_REBALANCE_SELECTOR: Hex = '0x1b977850';
const REBALANCE_ABI = [
  {
    type: 'function',
    name: 'executeRebalance',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'steps', type: 'tuple[]', components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'minAmountOut', type: 'uint256' },
        { name: 'routerData', type: 'bytes' },
        { name: 'extraData', type: 'bytes[]' },
      ] },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

type Args = {
  strategyId: bigint;
  owner: Address | null;
  account: Address | null;
  validUntil: number;
  keyIndex: bigint | null;
  prove: boolean;
  revokeOld: boolean;
  /** `--revoke-only <pid>`：只撤銷這個 permissionId，不續期（生命週期驗證用）。 */
  revokeOnlyPid: Hex | null;
  revokeValidUntil: number | null;
  revokeKeyIndex: bigint | null;
};

function parseArgs(argv: readonly string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const num = (name: string): number | undefined => {
    const raw = flag(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new Error(`--${name} 必須是整數，收到 "${raw}"`);
    return n;
  };
  const validUntilFlag = num('valid-until');
  const keyIndexFlag = flag('key-index');
  return {
    strategyId: BigInt(num('strategy-id') ?? process.env.STRATEGY_ID ?? 11),
    owner: (flag('owner') as Address | undefined) ?? null,
    account: (flag('account') as Address | undefined) ?? null,
    validUntil: validUntilFlag ?? sessionValidUntil(),
    keyIndex: keyIndexFlag === undefined ? null : BigInt(keyIndexFlag),
    prove: !has('no-prove'),
    revokeOld: has('revoke-old'),
    revokeOnlyPid: (flag('revoke-only') as Hex | undefined) ?? null,
    revokeValidUntil: num('revoke-valid-until') ?? null,
    revokeKeyIndex: flag('revoke-key-index') === undefined ? null : BigInt(flag('revoke-key-index')!),
  };
}

const log = (section: string, message: string): void => {
  console.log(`[${section}] ${message}`);
};

const addr = (value: string): Address => value.toLowerCase() as Address;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ---- [1] sudo key: derive the address and prove it is the account's owner ------------------
  // The derivation IS the check: a wrong key must fail here rather than after a signed UserOp.
  const sudoPk = process.env.SUDO_PRIVATE_KEY;
  if (!sudoPk || !/^0x[0-9a-fA-F]{64}$/.test(sudoPk)) {
    throw new Error('[1] SUDO_PRIVATE_KEY 未設定或格式不對：需要 0x + 64 hex 的 sudo owner 私鑰');
  }
  const sudoSigner = privateKeyToAccount(sudoPk as Hex);
  const owner = args.owner ?? sudoSigner.address;
  if (!isAddressEqual(sudoSigner.address, owner)) {
    throw new Error(`[1] sudo key 不是這個 owner：私鑰推導出 ${sudoSigner.address}，期待 ${owner}`);
  }
  log('1', `sudo owner ${owner}（由 SUDO_PRIVATE_KEY 推導，已驗證相符）`);

  const masterSeed = process.env.SESSION_KEY_MASTER_SEED;
  if (!masterSeed || !/^0x[0-9a-fA-F]{64}$/.test(masterSeed)) {
    throw new Error('[1] SESSION_KEY_MASTER_SEED 未設定或格式不對：需要 0x + 64 hex');
  }
  const material = { masterSeed: masterSeed as Hex };

  const chain = defineChain({
    id: CHAIN_ID,
    name: 'anvil-fork-bsc',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const publicClient: PublicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  // ---- [2] resolve the already-deployed account ---------------------------------------------
  // `createKernelAccount` derives the address from the init code, and initConfig is part of that init
  // code. A deployed account was created WITH its permission-install initConfig, so deriving without
  // it lands on a *different, undeployed* address. Both facts are checked below; the account objects
  // are then built with an explicit `address`, which short-circuits derivation entirely.
  const portfolio = await query<{ portfolio_id: string; address: string; owner: string }>(
    `select sa.portfolio_id::text, sa.address, sa.owner
       from smart_accounts sa
       join portfolios p on p.id = sa.portfolio_id
      where lower(sa.owner) = $1 and p.strategy_id = $2 and sa.chain_id = $3
      limit 1`,
    [owner.toLowerCase(), args.strategyId.toString(), CHAIN_ID],
  );
  if (portfolio.rowCount === 0 && !args.account) {
    throw new Error(`[2] DB 找不到 owner=${owner} strategyId=${args.strategyId} 的 smart account：請用 --account 指定`);
  }
  const deployed = args.account ? args.account : addr(portfolio.rows[0]!.address);
  const portfolioId = portfolio.rowCount === 0 ? null : BigInt(portfolio.rows[0]!.portfolio_id);
  const code = await publicClient.getCode({ address: deployed });
  if (!code || code === '0x') {
    throw new Error(`[2] ${deployed} 沒有 code：這不是已部署的帳戶，續期腳本不負責部署`);
  }
  log('2', `帳戶 ${deployed}（已部署，code ${code.length} chars，portfolio ${portfolioId?.toString() ?? 'n/a'}）`);

  // ---- [3] the existing permissions (baseline + the account-identity guards) -----------------
  // **全部** active 的 key 都讀回來，不是只讀最新那把：帳戶是用**第一把**的 initConfig 部署的
  // （docs/pitfalls §8.21），續期過一次的帳戶，最新那把的 initConfig 推不出已部署地址。只讀最新那把
  // 等於讓「續期過的帳戶」全部停在守衛上 —— 而那正是最需要續期的帳戶。舊權限基線（oldKey）仍然是
  // 最新那把（＝這一輪要被換掉的那把），兩件事分開。
  const keyRows = portfolioId === null
    ? []
    : (await query<{ key_ref: string; pid: string; valid_until: string; executor: string }>(
        `select key_ref,
                permissions->>'permissionId' as pid,
                permissions->'timestamp'->>'validUntil' as valid_until,
                permissions->'call'->'permissions'->0->>'target' as executor
           from session_keys
          where portfolio_id = $1 and status = 'active'
          order by expires_at asc`,
        [portfolioId!.toString()],
      )).rows;
  const oldKey = keyRows.length === 0 ? null : keyRows[keyRows.length - 1]!;
  const executor = addr(process.env.EXECUTOR_ADDRESS ?? oldKey?.executor ?? '0x60691760815C69d32c1f68146FA11669F62A4b38');
  let oldPid: Hex | null = null;
  if (oldKey) {
    oldPid = oldKey.pid as Hex;
    const before = await readPermission(publicClient, deployed, oldPid);
    log('3', `舊權限 ${oldPid}（最新那把）validUntil=${oldKey.valid_until} signer=${before.signer} policies=${before.policyData.length}`);
    if (before.signer === '0x0000000000000000000000000000000000000000') {
      log('3', `⚠ 舊權限 ${oldPid} 在鏈上已不存在（signer=0）——續期照做，但不保證舊 key 還是好的`);
    }
  } else {
    log('3', 'DB 沒有既有 session key 可讀，跳過舊權限基線');
  }
  // 守衛一：帳戶身分（直接讀鏈，不靠重算地址）。梯子壞掉時 `enrollments` 會是 (0,0,false)。
  await assertOnChainIdentity(publicClient, deployed, args.strategyId);
  // 守衛二：帳戶地址必須由「DB 裡某一把 key 的 initConfig」重現。候選是全部 active key，不是只有最新那把。
  if (keyRows.length > 0) {
    await resolveDeployKey(publicClient, sudoSigner.address, args.strategyId, deployed, keyRows, material);
  }

  // ---- [3b] revoke-only mode: uninstall one permissionId, then prove its key is dead ----------
  if (args.revokeOnlyPid) {
    const pid = args.revokeOnlyPid;
    if (args.revokeValidUntil === null) {
      throw new Error('--revoke-only 需要 --revoke-valid-until：撤銷要重建該權限拿 deinitData');
    }
    const beforeRevoke = await readPermission(publicClient, deployed, pid);
    log('10', `撤銷前 permissionConfig(${pid}) signer=${beforeRevoke.signer} policies=${beforeRevoke.policyData.length}`);
    if (beforeRevoke.signer === '0x0000000000000000000000000000000000000000') {
      log('10', `${pid} 在鏈上本來就不存在，沒東西可撤銷`);
      return;
    }
    // 重建該權限：deinitData 就是安裝時用的 enableData（SDK uninstallPlugin 也是這樣取）。
    const revokeIndex = args.revokeKeyIndex ?? sessionKeyIndexFor(sudoSigner.address, args.strategyId) + 1n;
    const revokeKeyRef = `m/44'/60'/0'/0/${revokeIndex.toString()}`;
    const revokeKeyAccount = hdKeyToAccount(HDKey.fromMasterSeed(hexToBytesSafe(masterSeed as Hex)), {
      path: revokeKeyRef as `m/44'/60'/${string}`,
    });
    const revokedPerms = await buildSessionPermissions({
      publicClient,
      sessionKeyAddress: revokeKeyAccount.address,
      executorAddress: executor,
      validUntil: args.revokeValidUntil,
      signer: await toECDSASigner({ signer: revokeKeyAccount }),
    });
    if (revokedPerms.permissionId !== pid) {
      log('10', `⚠ 重建的 permissionId ${revokedPerms.permissionId} != 被撤銷的 ${pid}：下面「送不出 op」不能歸因於撤銷`);
    }
    const revoke = await revokeOldPermission(
      publicClient, chain, deployed, sudoSigner, pid,
      await revokedPerms.permissionValidator.getEnableData(deployed),
    );
    log('10', `uninstallValidation(${pid}) txHash ${revoke.txHash} status=${revoke.success ? 'success' : 'REVERT'}`);
    const gone = await readPermission(publicClient, deployed, pid);
    log('10', `撤銷後 permissionConfig(${pid}) signer=${gone.signer} policies=${gone.policyData.length}`);

    const outcome: Record<string, unknown> = {
      account: deployed,
      revoked: pid,
      txHash: revoke.txHash,
      success: revoke.success,
      signerAfter: gone.signer,
      policiesAfter: gone.policyData.length,
    };

    outcome['rebuilt'] = { permissionId: revokedPerms.permissionId, keyRef: revokeKeyRef, sessionKeyAddress: revokeKeyAccount.address };
    try {
      const stillWorks = await proveNewKey(publicClient, chain, deployed, revokedPerms, sudoSigner.address, revokeKeyAccount.address, executor);
      log('10', `❌ 撤銷後該 key 仍然送得出 op —— 撤銷沒有生效`);
      outcome['keyAfterRevoke'] = { stillWorks };
    } catch (error) {
      const reason = firstLine(error);
      log('10', `✅ 撤銷後該 key 送不出 op：${reason}`);
      outcome['keyAfterRevoke'] = { rejected: reason };
    }
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }

  // ---- [4] derive the NEW session key ---------------------------------------------------------
  // Deterministic and distinct from the old one: base index + 1 unless --key-index says otherwise.
  const baseIndex = sessionKeyIndexFor(sudoSigner.address, args.strategyId);
  const newIndex = args.keyIndex ?? (await firstFreeIndex(baseIndex + 1n));
  const newKeyRef = `m/44'/60'/0'/0/${newIndex.toString()}` as const satisfies string as `m/44'/60'/${string}`;
  const newKeyAccount = hdKeyToAccount(HDKey.fromMasterSeed(hexToBytesSafe(masterSeed as Hex)), { path: newKeyRef });
  // Cross-check against the production deriver so this script cannot drift from src/permissions.ts.
  const derived = deriveSessionKey(newIndex, material);
  if (!isAddressEqual(derived.address, newKeyAccount.address)) {
    throw new Error(`[4] 派生不一致：src=${derived.address} script=${newKeyAccount.address}`);
  }
  log('4', `新 session key ${newKeyAccount.address}（${newKeyRef}，index ${newIndex.toString()}）`);

  // ---- [5] build the new permission set -------------------------------------------------------
  const perms = await buildSessionPermissions({
    publicClient,
    sessionKeyAddress: newKeyAccount.address,
    executorAddress: executor,
    validUntil: args.validUntil,
    // 真 signer：這把 key 之後要拿來簽 executeRebalance 那筆 op。
    signer: await toECDSASigner({ signer: newKeyAccount }),
  });
  log('5', `新 permissionId ${perms.permissionId} validUntil=${args.validUntil}（${perms.initConfig.length} 筆 install calldata）`);

  const already = await readPermission(publicClient, deployed, perms.permissionId);
  if (already.signer !== '0x0000000000000000000000000000000000000000') {
    log('5', `已是最新：${perms.permissionId} 已在鏈上（signer=${already.signer}，${already.policyData.length} 層 policy）→ 不重送`);
    await recordSessionKey(deployed, chain.id, sudoSigner.address, {
      keyRef: newKeyRef,
      permissionId: perms.permissionId,
      validUntil: Number(args.validUntil),
    }, perms.policySnapshot);
    if (args.prove) await proveNewKey(publicClient, chain, deployed, perms, sudoSigner.address, newKeyAccount.address, executor);
    return;
  }

  // ---- [6] build the sudo-signed UserOp --------------------------------------------------------
  // `address` is passed explicitly: the account already exists, and its address must not depend on
  // whatever init code this run would have produced.
  const sudoAccount = await createKernelAccount(publicClient, {
    address: deployed,
    plugins: { sudo: await signerToEcdsaValidator(publicClient, { signer: sudoSigner, entryPoint: ENTRY_POINT, kernelVersion: kernelVersion33() }) },
    entryPoint: ENTRY_POINT,
    kernelVersion: kernelVersion33(),
    useMetaFactory: true,
  });
  assertAddress(sudoAccount.address, deployed, 'sudo account');

  // Both initConfig entries are calls **to the account itself** (msg.sender == self inside execute).
  const calls = perms.initConfig.map((data) => ({ to: deployed, data, value: 0n }));
  describeCalls(calls);

  // ---- [7] send + wait ------------------------------------------------------------------------
  const kernelClient = createKernelAccountClient({
    account: sudoAccount,
    chain,
    client: publicClient,
    bundlerTransport: http(BUNDLER_URL),
    // alto 不提供 ZeroDev 的 zd_getUserOperationGasPrice，用節點 gas price。
    userOperation: {
      estimateFeesPerGas: async () => {
        const g = await publicClient.getGasPrice();
        return { maxFeePerGas: g, maxPriorityFeePerGas: g };
      },
    },
  });
  const userOpHash = await kernelClient.sendUserOperation({ calls });
  log('7', `userOpHash ${userOpHash}（sudo key 簽）`);
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash, timeout: 180_000 });
  log('7', `txHash ${receipt.receipt.transactionHash} status=${receipt.success ? 'success' : 'REVERT'} gasUsed=${receipt.actualGasUsed?.toString() ?? '?'} block=${receipt.receipt.blockNumber?.toString() ?? '?'}`);
  if (!receipt.success) throw new Error('[7] 續期 UserOp 上鏈但 revert：權限沒有安裝成功');

  // ---- [8] on-chain verification of the new permission ---------------------------------------
  const after = await readPermission(publicClient, deployed, perms.permissionId);
  log('8', `permissionConfig(${perms.permissionId}) signer=${after.signer} policies=${after.policyData.length} flag=${after.permissionFlag}`);
  after.policyData.forEach((p, i) => log('8', `  policy[${i}] ${p}`));
  if (after.signer === '0x0000000000000000000000000000000000000000' || after.policyData.length !== 3) {
    throw new Error('[8] 新權限不完整：signer 為零或 policy 層數不是 3');
  }

  // ---- [8b] record into `session_keys` --------------------------------------------------------
  await recordSessionKey(deployed, chain.id, sudoSigner.address, {
    keyRef: newKeyRef,
    permissionId: perms.permissionId,
    validUntil: Number(args.validUntil),
  }, perms.policySnapshot);

  const evidence: Record<string, unknown> = {
    account: deployed,
    owner,
    strategyId: args.strategyId.toString(),
    old: oldPid ? { permissionId: oldPid, validUntil: oldKey?.valid_until, keyRef: oldKey?.key_ref } : null,
    next: { permissionId: perms.permissionId, validUntil: args.validUntil, keyRef: newKeyRef, sessionKeyAddress: newKeyAccount.address },
    renewal: { userOpHash, txHash: receipt.receipt.transactionHash, success: receipt.success, gasUsed: receipt.actualGasUsed?.toString() },
  };

  // ---- [9] proof: the NEW session key must be able to send a UserOp ---------------------------
  if (args.prove) {
    const proof = await proveNewKey(publicClient, chain, deployed, perms, sudoSigner.address, newKeyAccount.address, executor);
    evidence['newKeyProof'] = proof;
  } else {
    log('9', '--no-prove：跳過新 key 的執行證明（續期是否生效尚未證明）');
  }

  // ---- [10] optional: revoke the OLD permission ----------------------------------------------
  if (args.revokeOld && oldPid && oldKey) {
    const oldPerms = await buildSessionPermissions({
      publicClient,
      sessionKeyAddress: hdKeyToAccount(HDKey.fromMasterSeed(hexToBytesSafe(masterSeed as Hex)), {
        path: oldKey.key_ref as `m/44'/60'/${string}`,
      }).address,
      executorAddress: executor,
      validUntil: Number(oldKey.valid_until),
    });
    const revoke = await revokeOldPermission(
      publicClient, chain, deployed, sudoSigner, oldPid,
      await oldPerms.permissionValidator.getEnableData(deployed),
    );
    log('10', `uninstallValidation(${oldPid}) txHash ${revoke.txHash} status=${revoke.success ? 'success' : 'REVERT'}`);
    const gone = await readPermission(publicClient, deployed, oldPid);
    log('10', `撤銷後 permissionConfig(${oldPid}) signer=${gone.signer} policies=${gone.policyData.length}`);
    evidence['oldRevoked'] = { ...revoke, signerAfter: gone.signer, policiesAfter: gone.policyData.length };
  }

  const stateFile = fileURLToPath(new URL('../../spike/renewal/state.json', import.meta.url));
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(evidence, null, 2)}\n`);
  log('i', '結果寫入 spike/renewal/state.json（不含任何私鑰）');
}

/**
 * 從 `from` 往上找第一個**沒被 `session_keys` 用過**的 index。
 *
 * 為什麼不能只寫 `baseIndex + 1`：帳戶續期過幾次之後那個 index 早就被用掉了，而 `key_ref` 是唯一鍵
 * —— 新權限寫不進 DB（`on conflict do nothing` 會靜默回 duplicate），DB 那一列仍描述**換 executor
 * 之前**的 CallPolicy target，於是排程器重建出來的 permissionId 對不上鏈上真正的 id，整個帳戶卡死。
 */
async function firstFreeIndex(from: bigint): Promise<bigint> {
  const { rows } = await query<{ key_ref: string }>('select key_ref from session_keys');
  const used = new Set(rows.map((row) => row.key_ref));
  let index = from;
  while (used.has(`m/44'/60'/0'/0/${index.toString()}`)) index += 1n;
  return index;
}

/** 把新 key 記進 DB：排程器靠這一列重建 permissionId，只寫 `spike/…/state.json` 它看不到。 */
async function recordSessionKey(
  account: Address,
  chainId: number,
  owner: Address,
  row: { keyRef: string; permissionId: Hex; validUntil: number },
  snapshot: unknown,
): Promise<void> {
  const found = await query<{ portfolio_id: string }>(
    `select s.portfolio_id::text as portfolio_id
       from smart_accounts s
      where s.address = $1 and s.chain_id = $2
      limit 1`,
    [account.toLowerCase(), chainId],
  );
  const portfolioId = found.rows[0]?.portfolio_id;
  if (portfolioId === undefined) {
    log('8b', `找不到 account ${account} 對應的 portfolio → 沒有寫 DB（排程器會看不到這把 key）`);
    return;
  }
  const recorded = await recordRenewalResult(
    Number(portfolioId),
    owner,
    { keyRef: row.keyRef, permissionId: row.permissionId, validUntil: row.validUntil, policySnapshot: snapshot as never },
    { query },
  );
  log('8b', `已寫入 session_keys（portfolio ${portfolioId}，keyRef ${row.keyRef}，pid ${row.permissionId}）${recorded.duplicate === true ? '（本來就在）' : ''}`);
}

// ---------------------------------------------------------------------------
// steps that spend a UserOp
// ---------------------------------------------------------------------------

/** The new key's own proof: sign an in-policy executeRebalance with it and land it on chain. */
async function proveNewKey(
  publicClient: PublicClient,
  chain: Chain,
  deployed: Address,
  perms: Awaited<ReturnType<typeof buildSessionPermissions>>,
  owner: Address,
  sessionKeyAddress: Address,
  executor: Address,
): Promise<Record<string, unknown>> {
  // sudo validator 只需要地址（本行程用它推導與填 nonce），regular 才是真正簽章的那一個。
  const sessionAccount = await createKernelAccount(publicClient, {
    address: deployed,
    plugins: {
      sudo: await signerToEcdsaValidator(publicClient, { signer: addressToEmptyAccount(owner), entryPoint: ENTRY_POINT, kernelVersion: kernelVersion33() }),
      regular: perms.permissionValidator,
    },
    entryPoint: ENTRY_POINT,
    kernelVersion: kernelVersion33(),
    useMetaFactory: true,
  });
  assertAddress(sessionAccount.address, deployed, 'session-key account');

  const data = encodeFunctionData({
    abi: REBALANCE_ABI,
    functionName: 'executeRebalance',
    args: [deployed, [], BigInt(Math.floor(Date.now() / 1000) + 3600)],
  });
  if (data.slice(0, 10) !== EXECUTE_REBALANCE_SELECTOR) {
    throw new Error(`executeRebalance selector 不符：${data.slice(0, 10)}`);
  }

  const client = createKernelAccountClient({
    account: sessionAccount,
    chain,
    client: publicClient,
    bundlerTransport: http(BUNDLER_URL),
    userOperation: {
      estimateFeesPerGas: async () => {
        const g = await publicClient.getGasPrice();
        return { maxFeePerGas: g, maxPriorityFeePerGas: g };
      },
    },
  });
  log('9', `用新 session key ${sessionKeyAddress} 送 executeRebalance(${executor})`);
  const userOpHash = await client.sendUserOperation({ calls: [{ to: executor, data, value: 0n }] });
  log('9', `userOpHash ${userOpHash}`);
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash, timeout: 180_000 });
  log('9', `txHash ${receipt.receipt.transactionHash} status=${receipt.success ? 'success' : 'REVERT'} gasUsed=${receipt.actualGasUsed?.toString() ?? '?'}`);
  if (!receipt.success) throw new Error('[9] 新 session key 的 op 上鏈但 revert：續期沒有真正生效');
  return { userOpHash, txHash: receipt.receipt.transactionHash, success: receipt.success, gasUsed: receipt.actualGasUsed?.toString() };
}

/** Optional: uninstall the old permission with a sudo-signed op, so the old key stops working. */
async function revokeOldPermission(
  publicClient: PublicClient,
  chain: Chain,
  deployed: Address,
  sudoSigner: ReturnType<typeof privateKeyToAccount>,
  oldPid: Hex,
  deinitData: Hex,
): Promise<{ txHash: Hex; success: boolean }> {
  const data = encodeFunctionData({
    abi: KernelV3_3AccountAbi,
    functionName: 'uninstallValidation',
    args: [permissionIdToVId(oldPid), deinitData, '0x'],
  });

  const sudoAccount = await createKernelAccount(publicClient, {
    address: deployed,
    plugins: { sudo: await signerToEcdsaValidator(publicClient, { signer: sudoSigner, entryPoint: ENTRY_POINT, kernelVersion: kernelVersion33() }) },
    entryPoint: ENTRY_POINT,
    kernelVersion: kernelVersion33(),
    useMetaFactory: true,
  });
  const client = createKernelAccountClient({
    account: sudoAccount,
    chain,
    client: publicClient,
    bundlerTransport: http(BUNDLER_URL),
    userOperation: {
      estimateFeesPerGas: async () => {
        const g = await publicClient.getGasPrice();
        return { maxFeePerGas: g, maxPriorityFeePerGas: g };
      },
    },
  });
  const userOpHash = await client.sendUserOperation({ calls: [{ to: deployed, data, value: 0n }] });
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash, timeout: 180_000 });
  return { txHash: receipt.receipt.transactionHash, success: receipt.success };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!.slice(0, 300);
}

function kernelVersion33(): GetKernelVersion<'0.7'> {
  return KERNEL_V3_3;
}

/** permissionId(bytes4) → the bytes21 validation id Kernel keys its storage by. */
function permissionIdToVId(pid: Hex): Hex {
  return pad(concat([VALIDATOR_TYPE.PERMISSION, pid]), { size: 21, dir: 'right' });
}

async function readPermission(publicClient: PublicClient, account: Address, pid: Hex) {
  return publicClient.readContract({
    address: account,
    abi: KernelV3_3AccountAbi,
    functionName: 'permissionConfig',
    args: [pid],
  });
}

function hexToBytesSafe(hex: Hex): Uint8Array {
  return Uint8Array.from((hex.slice(2).match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16)));
}

function assertAddress(actual: Address, expected: Address, label: string): void {
  if (!isAddressEqual(actual, expected)) {
    throw new Error(`地址不符（${label}）：算出的 ${actual} != 期待 ${expected}。不送 op。`);
  }
}

/** 只有這兩個 view 需要：`enrollments` 是帳戶在 registry 上的身分。 */
const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'enrollments',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'strategyId', type: 'uint256' },
      { name: 'version', type: 'uint16' },
      { name: 'paused', type: 'bool' },
    ],
  },
] as const;

/** 一筆 session_keys 列（只取推導/守衛需要的那幾個欄位）。 */
type SessionKeyRow = { key_ref: string; pid: string; valid_until: string; executor: string };

/**
 * 守衛一：帳戶身分**直接讀鏈**，不靠重算地址。
 *
 * 判的是「這個地址在 AtpRegistry 上是我們這條策略的帳戶」，也就是「要送 op 的對象是 DB 說的那個帳戶」
 * 這件事本身；重算地址判的是「部署參數可重現」，兩者防的不是同一個錯。梯子上沒有 enroll 紀錄
 * （全 0）、策略不同、或被 pause 都是停下來的理由。
 */
async function assertOnChainIdentity(
  publicClient: PublicClient,
  account: Address,
  strategyId: bigint,
): Promise<void> {
  const registry = process.env.REGISTRY_ADDRESS;
  if (!registry || !/^0x[0-9a-fA-F]{40}$/.test(registry)) {
    throw new Error('[3] REGISTRY_ADDRESS 未設定或格式不對：鏈上身分守衛讀不到 enrollments，停下不送 op');
  }
  const row = await query<{ onchain_id: string | null }>(
    'select onchain_id::text from strategies where id = $1',
    [strategyId.toString()],
  );
  const onchainId = row.rowCount === 0 ? null : row.rows[0]!.onchain_id;
  if (onchainId === null) {
    throw new Error(`[3] DB 的 strategies.id=${strategyId} 沒有 onchain_id：無法把 DB 策略對到鏈上 enrollment，停下不送 op`);
  }
  const [chainStrategyId, version, paused] = await publicClient.readContract({
    address: registry as Address,
    abi: REGISTRY_ABI,
    functionName: 'enrollments',
    args: [account],
  });
  log(
    '3',
    `鏈上身分：registry.enrollments(${account}) = strategyId ${chainStrategyId} version ${version} paused ${paused}` +
      `；DB strategies.onchain_id ${onchainId}`,
  );
  if (chainStrategyId === 0n) {
    throw new Error(`[3] ${account} 在 registry 上沒有 enroll 紀錄：這不是本專案的帳戶，停下不送 op`);
  }
  if (chainStrategyId !== BigInt(onchainId)) {
    throw new Error(
      `[3] ${account} 在鏈上 enroll 的是 strategyId ${chainStrategyId}，DB 說應該是 ${onchainId}：` +
        '帳戶與策略對不起來，停下不送 op',
    );
  }
  if (paused) {
    throw new Error(`[3] 策略 ${chainStrategyId} 在 registry 上是 paused：續期裝上去也不會生效，停下不送 op`);
  }
}

/**
 * 守衛二：已部署地址必須由「DB 裡某一把 active key 的 initConfig」重現。
 *
 * 帳戶是用**第一把** session key 的 initConfig 部署的（`docs/pitfalls` §8.21），而續期每次都往 DB
 * 加一把新的、expires_at 更晚的 key。所以「重算地址」這條守衛的輸入必須是**候選集合**而不是
 * 「最新那把」：拿最新那把去算，續期過一次的帳戶必然算不出自己的地址 —— 守衛本身沒錯，餵錯參數。
 *
 * 這裡**沒有放寬**判準：仍然要求「initConfig 進 initcode 後逐位重現已部署地址」，只是把候選從 1 把
 * 換成全部 active key，並要求**恰好一把**命中（0 把 = 參數對不上，多把 = DB 有重複紀錄，兩者都停）。
 * 同時把「不帶 initConfig」的反向對照留下來當證據。
 */
async function resolveDeployKey(
  publicClient: PublicClient,
  owner: Address,
  strategyId: bigint,
  deployed: Address,
  candidates: readonly SessionKeyRow[],
  material: { masterSeed: Hex },
): Promise<SessionKeyRow> {
  const matches: SessionKeyRow[] = [];
  for (const candidate of candidates) {
    const keyAccount = hdKeyToAccount(HDKey.fromMasterSeed(hexToBytesSafe(material.masterSeed)), {
      path: candidate.key_ref as `m/44'/60'/${string}`,
    });
    const perms = await buildSessionPermissions({
      publicClient,
      sessionKeyAddress: keyAccount.address,
      executorAddress: candidate.executor.toLowerCase() as Address,
      validUntil: Number(candidate.valid_until),
    });
    const account = await createKernelAccount(publicClient, {
      plugins: { sudo: await signerToEcdsaValidator(publicClient, { signer: addressToEmptyAccount(owner), entryPoint: ENTRY_POINT, kernelVersion: kernelVersion33() }) },
      entryPoint: ENTRY_POINT,
      kernelVersion: kernelVersion33(),
      index: BigInt(computeSalt(owner, strategyId)),
      useMetaFactory: true,
      initConfig: perms.initConfig,
    });
    const hit = isAddressEqual(account.address, deployed);
    if (hit) matches.push(candidate);
    // 順便把「DB 說 active、鏈上卻沒有」的漂移看得見：signer=0 就是那筆權限不在鏈上。
    const onChain = await readPermission(publicClient, deployed, candidate.pid as Hex);
    log(
      '3',
      `候選 ${candidate.key_ref}（${keyAccount.address}，pid ${candidate.pid}，validUntil ${candidate.valid_until}，` +
        `鏈上 signer ${onChain.signer}）→ 帶 initConfig 推導 ${account.address}${hit ? ' = 已部署 ✓' : ' ✗'}`,
    );
  }

  if (matches.length === 0) {
    throw new Error(
      `[3] DB 現有 ${candidates.length} 把 active session key 都推不出已部署地址 ${deployed}（逐一結果見上）：` +
        'DB 的 key_ref/validUntil 與部署當時不一致，停下不送 op',
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `[3] 有 ${matches.length} 把 key 都推出同一個已部署地址（${matches.map((m) => m.key_ref).join('、')}）：` +
        'DB 有重複紀錄，停下不送 op',
    );
  }

  const deployKey = matches[0]!;
  log(
    '3',
    `守衛通過：部署當時用的是 ${deployKey.key_ref}（pid ${deployKey.pid}，validUntil ${deployKey.valid_until}），` +
      '只有它重現了已部署地址',
  );
  const withoutInit = await createKernelAccount(publicClient, {
    plugins: { sudo: await signerToEcdsaValidator(publicClient, { signer: addressToEmptyAccount(owner), entryPoint: ENTRY_POINT, kernelVersion: kernelVersion33() }) },
    entryPoint: ENTRY_POINT,
    kernelVersion: kernelVersion33(),
    index: BigInt(computeSalt(owner, strategyId)),
    useMetaFactory: true,
  });
  log(
    '3',
    `反向對照：不帶 initConfig → ${withoutInit.address}` +
      `${isAddressEqual(withoutInit.address, deployed) ? ' ❌ 竟然相同（initConfig 沒進 initcode）' : '（不同，符合預期：initConfig 是唯一影響地址的東西）'}`,
  );
  return deployKey;
}

function describeCalls(calls: readonly { to: Address; data: Hex }[]): void {
  calls.forEach((call, i) => {
    const decoded = decodeFunctionData({ abi: KernelV3_3AccountAbi, data: call.data });
    if (decoded.functionName === 'installValidations') {
      const [vIds] = decoded.args as [readonly Hex[], unknown, unknown, unknown];
      log('6', `call[${i}] → 帳戶自己 installValidations(${vIds.length} 個 vId ${vIds[0]})`);
    } else if (decoded.functionName === 'execute') {
      const [mode, execData] = decoded.args as [Hex, Hex];
      // delegatecall 的 executionCalldata 是 `to(20 bytes) ++ data`（沒有 value 欄位）。
      const innerTo = `0x${execData.slice(2, 42)}`;
      const innerSel = `0x${execData.slice(42, 50)}`;
      log('6', `call[${i}] → 帳戶自己 execute(callType=${mode.slice(2, 4)}…) → delegatecall ${innerTo} ${innerSel}（grantAccess）`);
    } else {
      log('6', `call[${i}] → 帳戶自己 ${decoded.functionName}`);
    }
  });
}

await main();
await closePool().catch(() => undefined);
