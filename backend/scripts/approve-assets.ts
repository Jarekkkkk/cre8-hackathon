// Grant AtpExecutor an ERC-20 allowance for every asset of the strategy version the account is pinned to.
//
// ⚠ DEV / FORK ONLY. Same posture as `renew-session-key.ts`: the sudo owner's private key is read from
// SUDO_PRIVATE_KEY and signs in-process. Acceptable against an anvil fork with publicly known test keys;
// in production the owner signs inside their own wallet and the signature is relayed. Never commit a real
// key, and never put one in a file this script reads from disk.
//
// Why this script has to exist at all:
//   `AtpExecutor._swap` still pulls the input token with a plain ERC20 `safeTransferFrom`
//   (cre8-contracts/src/atp/AtpExecutor.sol:245-248, the `TODO(permit2)` block), so the account must hold
//   an ERC-20 allowance towards the executor. A session key cannot grant it: its CallPolicy whitelists
//   `executeRebalance` only (src/permissions.ts), and `approve` is a different target+selector. So the
//   allowance is granted ONCE by the sudo owner, with this script, instead of widening the CallPolicy.
//
// Why the asset list comes from the chain instead of from the DB or from a literal list:
//   (a) the DB's strategy id and the on-chain strategy id are different numbers (DB 11, chain 1 here), and
//   (b) `registry.version(id, 0)` silently resolves to the ACTIVE version, so a wrong or zero version
//       number reads as a perfectly plausible asset list.
//   `registry.enrollments(account)` returns the (strategyId, version) the account is actually pinned to;
//   both are hard errors when zero. `version(id, n).assets` is then the same universe the executor's
//   `isAssetAllowed` checks against (AtpExecutor.sol:180-182).
//
// Run (dry run — prints the calls, sends nothing, needs no private key):
//   RPC_URL=http://127.0.0.1:8545 bun run backend/scripts/approve-assets.ts --dry-run
//
// Run (real, one batched UserOp signed by the sudo owner):
//   RPC_URL=http://127.0.0.1:8545 BUNDLER_URL=http://127.0.0.1:3001 \
//   SUDO_PRIVATE_KEY=0x<64 hex> bun run backend/scripts/approve-assets.ts
//
// Flags: --dry-run --account <addr> --executor <addr> --registry <addr> --amount <decimal>
//        --reset-nonzero --submit bundler|direct
//
// Submission path: the op is normally handed to the ERC-4337 bundler (alto) and the SDK does the packing,
// gas estimation and signature. When no bundler is reachable, `--submit direct` (or the automatic fallback)
// submits the SAME op with a plain `EntryPoint.handleOps` transaction from a funded EOA: `handleOps` is the
// EntryPoint's own entry function, so the account is still validated and the approves still execute inside
// the same UserOp — only the relayer differs. That path packs the op itself (limits are fixed, not estimated),
// so it is the fork-only fallback, not the default.

import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import type { GetKernelVersion } from '@zerodev/sdk/types';
import { isAddressEqual } from 'viem';
import type { Address, Chain, Hex, PublicClient } from 'viem';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http } from 'viem';
import { entryPoint07Abi, toPackedUserOperation } from 'viem/account-abstraction';
import type { UserOperation } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';

import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';

/** EntryPoint v0.7（`toPermissionValidator` 只接受 0.7；本腳本用 sudo validator，理由相同）。 */
const ENTRY_POINT = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const BUNDLER_URL = process.env.BUNDLER_URL ?? 'http://127.0.0.1:3001';
const CHAIN_ID = 56;

/** anvil fork fixture：portfolio 5 的 smart account。--account / ACCOUNT_ADDRESS 可覆寫。 */
const DEFAULT_ACCOUNT: Address = '0x2b082fadf8f3d620eaa242a9e36817af8640d042';
/** AtpExecutor（session key CallPolicy 的 target，也是 allowance 的 spender）。 */
const DEFAULT_EXECUTOR: Address = '0x60691760815C69d32c1f68146FA11669F62A4b38';
/** AtpRegistry（fork 上の部署）。 */
const DEFAULT_REGISTRY: Address = '0x27739a1AD35a924F5545C7d04C2B0537069CA76C';

/**
 * 授權額度：`type(uint160).max`，不是 `type(uint256).max`。
 *
 * 執行器自己就把上界釘在 uint160：`if (step.amountIn > type(uint160).max) revert AmountTooLarge()`
 * （AtpExecutor.sol:256）。也就是說**執行器無論如何都拉不到超過這個數量的 amountIn**，所以
 * uint160.max 對每一個可達的 amountIn 都已經是「無限授權」；再往上加一個位元換不到任何東西。
 * 選它的理由有三個：
 *   ① 它是「剛好覆蓋全部可達請求」的最小無限授權，超額授權不多一個位元；
 *   ② 與執行器 Permit2 那一段的 allowance 模型同一個位元寬度，兩段語意一致；
 *   ③ 不依賴 uint256.max 的「特殊值」語意（WBNB 的 transferFrom 對 allowance == uint(-1) 會跳過
 *      扣減，那是 token 實作的特殊路徑；這裡不需要踩它，一般數值走一般路徑）。
 * 代價是「未來單筆金額超過 2^160-1」不會被這筆授權涵蓋——那時執行器本身也會 revert，所以不是損失。
 */
const DEFAULT_AMOUNT = (1n << 160n) - 1n;

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
  {
    type: 'function',
    name: 'version',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'versionNumber', type: 'uint16' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'assets', type: 'address[]' },
          { name: 'weightsBps', type: 'uint16[]' },
          { name: 'scheduleHash', type: 'bytes32' },
          { name: 'activeAt', type: 'uint64' },
        ],
      },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** 只為了在送 op 之前把 prefund 的來源講清楚：EntryPoint 的 deposit 還不夠時，差額由帳戶的 BNB 補。 */
const ENTRY_POINT_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

type Call = { to: Address; data: Hex; value: bigint; label: string };

/** 送出路徑的結果：兩條路徑（bundler / 直送 EntryPoint）都化成同一個形狀，下游只認這個。 */
type Submitted = {
  path: 'bundler' | 'entryPoint';
  userOpHash: Hex;
  txHash: Hex;
  status: string;
  blockNumber: bigint | null;
  gasUsed: bigint | null;
};

/**
 * 直送路徑的 gas 上限（不估算，固定值）。
 *
 * Bundler 會替 op 估算 verification/call gas；直送時沒有那一步，所以上限要自己給。給寬一點的原因：
 * 上限只在 prefund 檢查與退款計算裡當「最大值」用，實際消耗照樣按真實用量結算，多給不吃虧。帳戶的
 * sudo 驗證（ecrecover + Kernel 排程）約 40k，兩個 approve 約 46k＋兩次 SSTORE(0→非0) 40k。
 */
const DIRECT_GAS = { verificationGasLimit: 500_000n, callGasLimit: 400_000n, preVerificationGas: 120_000n } as const;

type Args = {
  account: Address;
  executor: Address;
  registry: Address;
  amount: bigint;
  dryRun: boolean;
  resetNonzero: boolean;
  submit: 'bundler' | 'direct';
};

const log = (section: string, message: string): void => {
  console.log(`[${section}] ${message}`);
};

const addr = (value: string): Address => value.toLowerCase() as Address;

function parseArgs(argv: readonly string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const amountRaw = flag('amount');
  let amount = DEFAULT_AMOUNT;
  if (amountRaw !== undefined) {
    if (amountRaw === 'max') {
      amount = DEFAULT_AMOUNT;
    } else {
      // 大數字一律 bigint：`Number()` 在 2^53 之後會安靜失真。
      amount = BigInt(amountRaw);
      if (amount <= 0n) throw new Error(`--amount 必須是正數，收到 "${amountRaw}"`);
      if (amount > DEFAULT_AMOUNT) {
        throw new Error(
          `--amount ${amount} 超過 type(uint160).max：執行器對 > uint160.max 的 amountIn 直接 revert AmountTooLarge，` +
            '超額授權沒有意義',
        );
      }
    }
  }
  const submitRaw = flag('submit') ?? process.env.SUBMIT_MODE ?? 'bundler';
  if (submitRaw !== 'bundler' && submitRaw !== 'direct') {
    throw new Error(`--submit 只接受 bundler 或 direct，收到 "${submitRaw}"`);
  }
  return {
    account: addr(flag('account') ?? process.env.ACCOUNT_ADDRESS ?? DEFAULT_ACCOUNT),
    executor: addr(flag('executor') ?? process.env.EXECUTOR_ADDRESS ?? DEFAULT_EXECUTOR),
    registry: addr(flag('registry') ?? process.env.REGISTRY_ADDRESS ?? DEFAULT_REGISTRY),
    amount,
    dryRun: has('dry-run'),
    resetNonzero: has('reset-nonzero'),
    submit: submitRaw,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const chain = defineChain({
    id: CHAIN_ID,
    name: 'anvil-fork-bsc',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const publicClient: PublicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  // ---- [1] the account must be a deployed contract -------------------------------------------
  const code = await publicClient.getCode({ address: args.account });
  if (!code || code === '0x') {
    throw new Error(`[1] ${args.account} 沒有 code：這不是已部署的帳戶（approve 必須由帳戶自己發）`);
  }
  log('1', `帳戶 ${args.account}（已部署，code ${code.length} chars），executor ${args.executor}`);

  // ---- [2] the pinned (strategyId, version) — both zero are hard errors ------------------------
  const enrollment = await publicClient.readContract({
    address: args.registry,
    abi: REGISTRY_ABI,
    functionName: 'enrollments',
    args: [args.account],
  });
  const [strategyId, versionNumber, paused] = enrollment;
  if (strategyId === 0n) {
    throw new Error(`[2] ${args.account} 在 registry ${args.registry} 上沒有 enroll 紀錄（strategyId=0）`);
  }
  if (versionNumber === 0) {
    throw new Error(`[2] ${args.account} 的 enrollment.version 是 0：0 會被 version(id, 0) 解析成 active version，拒絕猜`);
  }
  log('2', `enrollment：strategyId=${strategyId} version=${versionNumber} paused=${paused}${paused ? ' ⚠ 已暫停（approve 仍可授權，但 executeRebalance 會 revert Paused）' : ''}`);

  // ---- [3] the asset universe, from the chain -------------------------------------------------
  const onchainVersion = await publicClient.readContract({
    address: args.registry,
    abi: REGISTRY_ABI,
    functionName: 'version',
    args: [strategyId, versionNumber],
  });
  const assets = onchainVersion.assets;
  if (assets.length === 0) {
    throw new Error(`[3] registry.version(${strategyId}, ${versionNumber}).assets 是空的：沒有東西可授權`);
  }
  log('3', `version(${strategyId}, ${versionNumber}).assets = [${assets.join(', ')}]（weightsBps [${onchainVersion.weightsBps.join(', ')}]）`);
  for (const asset of assets) {
    const assetCode = await publicClient.getCode({ address: asset });
    if (!assetCode || assetCode === '0x') {
      throw new Error(`[3] version.assets 裡的 ${asset} 沒有 code：registry 的資產清單壞了，不送 op`);
    }
  }

  // ---- [4] allowance before --------------------------------------------------------------------
  const before: { asset: Address; allowance: bigint }[] = [];
  for (const asset of assets) {
    before.push({ asset, allowance: await readAllowance(publicClient, asset, args.account, args.executor) });
  }
  before.forEach((b) => log('4', `allowance(${args.account}, ${args.executor}) @ ${b.asset} = ${b.allowance}`));

  // ---- [5] build the approve calls --------------------------------------------------------------
  // One batched UserOp, not one per token: the batch is atomic (either every asset is approved or none
  // is), and it pays account validation once. A half-approved asset list is exactly the state that makes
  // the next `executeRebalance` fail on whichever leg happened to be missing.
  const calls: Call[] = [];
  for (const b of before) {
    if (b.allowance === args.amount) {
      log('5', `跳過 ${b.asset}：allowance 已經是 target ${args.amount}（不重送）`);
      continue;
    }
    if (b.allowance !== 0n) {
      // 有些代幣（USDT 系列的 `require(!((value > 0) && (allowed > 0)))`）把 approve 從「非 0」改到
      // 「另一個非 0」視為錯誤，必須先歸零。目前兩個資產都是 0，所以走不到這裡；真的走到就明確拒絕，
      // 不讓一筆注定 revert 的 op 上鏈（它會拖著整個 batch 一起失敗）。
      if (!args.resetNonzero) {
        throw new Error(
          `[5] ${b.asset} 目前 allowance=${b.allowance}（非 0）而目標是 ${args.amount}：USDT 類代幣會拒絕` +
            '「非 0 → 非 0」的 approve。加 --reset-nonzero 先送 approve(0) 再送 approve(target)，或先確認這筆要覆蓋的額度',
        );
      }
      log('5', `${b.asset} allowance=${b.allowance}（非 0）→ --reset-nonzero：先 approve(0) 再 approve(${args.amount})`);
      calls.push(approveCall(b.asset, args.executor, 0n));
    }
    calls.push(approveCall(b.asset, args.executor, args.amount));
  }

  if (calls.length === 0) {
    log('5', `全部資產的 allowance 都已經是 ${args.amount}：沒有要送的東西`);
    console.log(
      JSON.stringify(
        { alreadyApproved: true, account: args.account, executor: args.executor, before },
        (_, v) => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ),
    );
    return;
  }

  log('5', `將送出 ${calls.length} 筆 call（一個 batch UserOp）：`);
  calls.forEach((c, i) => log('5', `  call[${i}] → ${c.to} approve(spender=${args.executor}, amount=${decodeApproveAmount(c.data)}) data=${c.data.slice(0, 10)}…`));

  if (args.dryRun) {
    log('dry-run', '不送交易、不簽名（--dry-run）。要真的送，去掉 --dry-run 並提供 SUDO_PRIVATE_KEY。');
    console.log(
      JSON.stringify(
        { dryRun: true, account: args.account, executor: args.executor, strategyId: strategyId.toString(), version: versionNumber, amount: args.amount.toString(), calls: calls.map(({ label, to, data }) => ({ to, label, data })), before },
        (_, v) => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ),
    );
    return;
  }

  // ---- [6] sudo key: the derivation IS the check ------------------------------------------------
  const sudoPk = process.env.SUDO_PRIVATE_KEY;
  if (!sudoPk || !/^0x[0-9a-fA-F]{64}$/.test(sudoPk)) {
    throw new Error('[6] SUDO_PRIVATE_KEY 未設定或格式不對：需要 0x + 64 hex 的 sudo owner 私鑰');
  }
  const sudoSigner = privateKeyToAccount(sudoPk as Hex);
  const ownerOverride = process.env.SUDO_OWNER;
  if (ownerOverride && !isAddressEqual(addr(ownerOverride), sudoSigner.address)) {
    throw new Error(`[6] sudo key 不是這個 owner：私鑰推導出 ${sudoSigner.address}，期待 ${ownerOverride}`);
  }
  log('6', `sudo owner ${sudoSigner.address}（由 SUDO_PRIVATE_KEY 推導）`);

  // ---- [7] prefund source: make "AA21 didn't pay prefund" legible before spending gas ----------
  const nativeBalance = await publicClient.getBalance({ address: args.account });
  const deposit = await publicClient.readContract({
    address: ENTRY_POINT.address,
    abi: ENTRY_POINT_ABI,
    functionName: 'balanceOf',
    args: [args.account],
  });
  log('7', `prefund：EntryPoint deposit ${deposit} wei，帳戶 BNB ${nativeBalance} wei（deposit 不足時 EntryPoint 會向帳戶要 missingAccountFunds）`);
  if (deposit === 0n && nativeBalance === 0n) {
    throw new Error('[7] EntryPoint deposit 與帳戶 BNB 都是 0：付不出 prefund，先補 gas 再跑');
  }

  // ---- [8] build the sudo-signed account + client ----------------------------------------------
  // `address` is passed explicitly: the account already exists, and its address must not depend on
  // whatever init code this run would have produced.
  const sudoAccount = await createKernelAccount(publicClient, {
    address: args.account,
    plugins: {
      sudo: await signerToEcdsaValidator(publicClient, {
        signer: sudoSigner,
        entryPoint: ENTRY_POINT,
        kernelVersion: kernelVersion33(),
      }),
    },
    entryPoint: ENTRY_POINT,
    kernelVersion: kernelVersion33(),
    useMetaFactory: true,
  });
  assertAddress(sudoAccount.address, args.account, 'sudo account');

  // ---- [9] send + wait -------------------------------------------------------------------------
  let submitted: Submitted | null = null;
  if (args.submit === 'bundler') {
    try {
      submitted = await sendViaBundler({ publicClient, chain, account: sudoAccount, calls });
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      log('9', `⚠ bundler ${BUNDLER_URL} 連不上（${firstLine(error)}）→ 改走 --submit direct：直接把同一個 op 交給 EntryPoint.handleOps`);
    }
  }
  if (!submitted) {
    submitted = await sendViaEntryPoint({ publicClient, chain, account: sudoAccount, calls, relayerPk: sudoPk as Hex, deposit, nativeBalance });
  }
  log('9', `送出途徑 ${submitted.path}；txHash ${submitted.txHash} status=${submitted.status} gasUsed=${submitted.gasUsed?.toString() ?? '?'} block=${submitted.blockNumber?.toString() ?? '?'}`);
  if (submitted.status !== 'success') throw new Error('[9] approve 的 op 上鏈但 revert：allowance 沒有寫入');

  // ---- [10] allowance after: the only thing that actually matters -------------------------------
  const after: { asset: Address; before: bigint; after: bigint; expected: bigint }[] = [];
  for (const b of before) {
    const now = await readAllowance(publicClient, b.asset, args.account, args.executor);
    after.push({ asset: b.asset, before: b.allowance, after: now, expected: args.amount });
    log('10', `allowance(${args.account}, ${args.executor}) @ ${b.asset} = ${now}（送之前 ${b.allowance}）`);
  }
  const unapproved = after.filter((a) => a.after !== a.expected);
  if (unapproved.length > 0) {
    throw new Error(`[10] 這些資產的 allowance 不等於 target ${args.amount}：${unapproved.map((a) => `${a.asset}=${a.after}`).join(', ')}`);
  }

  log('10', '✅ 全部資產已授權。注意：這只證明 allowance 寫進去了；帳戶目前持有 0 個資產，');
  log('10', '   「執行器真的拉得到幣」要等帳戶有餘額後由 executeRebalance 的端到端驗證（下一個工單）。');

  console.log(
    JSON.stringify(
      {
        account: args.account,
        executor: args.executor,
        strategyId: strategyId.toString(),
        version: versionNumber,
        amount: args.amount.toString(),
        approval: {
          path: submitted.path,
          userOpHash: submitted.userOpHash,
          txHash: submitted.txHash,
          blockNumber: submitted.blockNumber?.toString() ?? null,
          status: submitted.status,
          gasUsed: submitted.gasUsed?.toString() ?? null,
        },
        before,
        after,
      },
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// submission
// ---------------------------------------------------------------------------

type SendArgs = {
  publicClient: PublicClient;
  chain: Chain;
  account: Awaited<ReturnType<typeof createKernelAccount>>;
  calls: readonly Call[];
};

/** The normal path: hand the batch to the bundler, which estimates gas and forwards handleOps. */
async function sendViaBundler({ publicClient, chain, account, calls }: SendArgs): Promise<Submitted> {
  const kernelClient = createKernelAccountClient({
    account,
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
  const userOpHash = await kernelClient.sendUserOperation({
    calls: calls.map(({ to, data, value }) => ({ to, data, value })),
  });
  log('9', `userOpHash ${userOpHash}（sudo key 簽，${calls.length} 筆 approve 在同一個 batch）`);
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash, timeout: 180_000 });
  return {
    path: 'bundler',
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    status: receipt.receipt.status,
    blockNumber: receipt.receipt.blockNumber,
    gasUsed: receipt.actualGasUsed ?? null,
  };
}

/**
 * Fallback with no bundler in the loop: pack the op ourselves and call `EntryPoint.handleOps` from an EOA.
 *
 * Everything that makes the op valid is still produced by the SDK — `encodeCalls` (the Kernel batch
 * multisend), `getNonce` (nonce key for the active/sudo validator) and `signUserOperation` (the sudo ECDSA
 * signature over the v0.7 userOpHash). Only gas limits are fixed instead of estimated, and the EOA pays the
 * L1 gas while the account pays its own prefund through `missingAccountFunds`.
 */
async function sendViaEntryPoint({
  publicClient,
  chain,
  account,
  calls,
  relayerPk,
  deposit,
  nativeBalance,
}: SendArgs & { relayerPk: Hex; deposit: bigint; nativeBalance: bigint }): Promise<Submitted> {
  const callData = await account.encodeCalls(calls.map(({ to, data, value }) => ({ to, data, value })));
  const nonce = await account.getNonce();
  const gasPrice = await publicClient.getGasPrice();
  const op: UserOperation<'0.7'> = {
    sender: account.address,
    nonce,
    callData,
    ...DIRECT_GAS,
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice,
    signature: '0x',
  };
  // EntryPoint 的 prefund 上界＝ gasLimit × maxFeePerGas；deposit 不足的差額由帳戶的 BNB 付。
  const requiredPrefund = (DIRECT_GAS.verificationGasLimit * 3n + DIRECT_GAS.callGasLimit + DIRECT_GAS.preVerificationGas) * gasPrice;
  log('9', `直送：prefund 上界 ${requiredPrefund} wei（deposit ${deposit} + 帳戶 BNB ${nativeBalance}）`);
  if (deposit + nativeBalance < requiredPrefund) {
    throw new Error('[9] 帳戶的 deposit + BNB 付不出 prefund：先補 gas，不送一筆注定 AA21 的交易');
  }

  const signature = await account.signUserOperation(op);
  const signed: UserOperation<'0.7'> = { ...op, signature };
  const userOpHash = await publicClient.readContract({
    address: ENTRY_POINT.address,
    abi: entryPoint07Abi,
    functionName: 'getUserOpHash',
    args: [toPackedUserOperation(signed)],
  });
  log('9', `直送：userOpHash ${userOpHash}（sudo key 簽，${calls.length} 筆 approve 在同一個 batch）`);

  // 代送的 EOA：同一把 sudo 私鑰（anvil #3），它只付 L1 gas，不進 op 的語意。
  const relayer = privateKeyToAccount(relayerPk);
  const walletClient = createWalletClient({ account: relayer, chain, transport: http(RPC_URL) });
  const txHash = await walletClient.writeContract({
    address: ENTRY_POINT.address,
    abi: entryPoint07Abi,
    functionName: 'handleOps',
    args: [[toPackedUserOperation(signed)], relayer.address],
  });
  log('9', `直送：handleOps tx ${txHash}（代送 EOA ${relayer.address}）`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
  return {
    path: 'entryPoint',
    userOpHash,
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  };
}

/**
 * 「連不上」與「送出被拒」要分開：前者才可以換路徑重試，後者是 op 本身的問題，換路徑只會送第二次。
 */
function isUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error);
  return /ECONNREFUSED|ENOTFOUND|fetch failed|Unable to connect|HTTP request failed|socket hang up/i.test(message);
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!.slice(0, 200);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function approveCall(token: Address, spender: Address, amount: bigint): Call {
  return {
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
    value: 0n,
    label: `approve(${spender}, ${amount})`,
  };
}

/** 只為了印出可讀的 plan：把 calldata 的 amount 解回來（第 2 個 word）。 */
function decodeApproveAmount(data: Hex): bigint {
  return BigInt(`0x${data.slice(10 + 64, 10 + 128)}`);
}

function readAllowance(publicClient: PublicClient, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
}

function kernelVersion33(): GetKernelVersion<'0.7'> {
  return KERNEL_V3_3;
}

function assertAddress(actual: Address, expected: Address, label: string): void {
  if (!isAddressEqual(actual, expected)) {
    throw new Error(`地址不符（${label}）：算出的 ${actual} != 期待 ${expected}。不送 op。`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
