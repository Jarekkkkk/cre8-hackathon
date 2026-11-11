/**
 * 續期用的 Kernel/UserOp 組裝。
 *
 * 續期這一筆是 **sudo（owner）簽名**的 UserOp：它做的事是「在鏈上安裝一組新的 session key 權限」。
 * 所以簽名者必須是帳戶的 owner EOA —— 也就是剛登入的那個錢包。
 *
 * 兩個刻意的選擇：
 * 1. **bundler 走後端的 relay**（`${VITE_API_BASE}/bundler`），不是 `params.bundlerUrl`。
 *    `bundlerUrl` 是後端自己用的 alto 位址（127.0.0.1:3001），瀏覽器直接打會撞 CORS，而且那個位址
 *    通常不對外。relay 讓前端只認識一個 origin。
 *    ⚠ relay **要帶使用者的 session token**（`Authorization: Bearer`），而且只放行六個白名單方法
 *    （`eth_sendUserOperation` / `eth_estimateUserOperationGas` / `eth_getUserOperationReceipt` /
 *    `eth_getUserOperationByHash` / `eth_supportedEntryPoints` / `eth_chainId`）。
 *    少了這個標頭就是 401 —— 這是踩過的坑。
 * 2. **publicClient 優先用錢包自己的 provider**（那條鏈它已經連上了），只有在 dev 私鑰模式才退回
 *    `VITE_RPC_URL`（dev 由 vite proxy 轉到 anvil）。這樣就不需要在瀏覽器裡散佈一個 RPC 端點。
 */
import {
  createKernelAccount,
  createKernelAccountClient,
} from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import type { GetKernelVersion } from '@zerodev/sdk/types';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, encodePacked, http, keccak256 } from 'viem';
import type { Address, Chain, Hex, LocalAccount, PublicClient, WalletClient } from 'viem';

const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

/**
 * 這個 app 跑的鏈。
 *
 * 為什麼預設是 **1337** 而不是 56：chainId 56 是 MetaMask「認識」的鏈，它會把**代幣餘額顯示**
 * 與**交易模擬**交給自家後端（以 chainId 為主鍵）→ 我們的 fork 被當成 BSC 主網，
 * 於是錢包永遠顯示 0 USDT、永遠說 "likely to fail"，而 nonce/gas 卻是從我們的 RPC 拿的
 * （所以看起來像「連對了但餘額不對」）。換成 MetaMask 不認得的 id，它就只能問我們的 RPC。
 *
 * 正式部署時把 `VITE_CHAIN_ID=56` 設回去即可，呼叫端的名字不變。
 */
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1337);

export const bsc = {
  id: CHAIN_ID,
  name: CHAIN_ID === 56 ? 'BNB Smart Chain' : `CRE8 Local (${CHAIN_ID})`,
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: ['https://bsc-dataseed.binance.org'] } },
} as const satisfies Chain;

/**
 * EntryPoint v0.7 的位址。後端也會帶，但那是**字串**；這裡驗一次相等再交給 SDK，
 * 免得 SDK 收到一個它認不得的型別卻只回一句看不懂的錯誤。
 */
const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

/**
 * SDK 要的是 **物件**（`{ address, version }`），不是位址字串。
 *
 * 踩過的坑：把 `params.entryPoint`（字串）直接傳進去，會得到
 * `Error: Unsupported entry point version` —— 訊息完全沒提「你傳的是字串」。
 */
const ENTRY_POINT = { address: ENTRY_POINT_V07, version: '0.7' } as const;

export function assertEntryPoint(value: string): void {
  if (value.toLowerCase() !== ENTRY_POINT_V07.toLowerCase()) {
    throw new Error(`The backend returned entryPoint ${value}; this front end only supports v0.7 (${ENTRY_POINT_V07})`);
  }
}

export type RenewalWallet =
  | { kind: 'injected'; address: Address; provider: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }
  | { kind: 'dev'; address: Address; account: LocalAccount };

/**
 * 讀鏈用的 client。錢包模式用錢包自己的 transport；dev 用 `VITE_RPC_URL`（預設 dev 的 `/rpc` proxy）。
 */
export function publicClientFor(wallet: RenewalWallet): PublicClient {
  if (wallet.kind === 'injected') {
    return createPublicClient({ chain: bsc, transport: custom(wallet.provider as never) });
  }
  const rpcUrl = import.meta.env.VITE_RPC_URL ?? (import.meta.env.DEV ? '/rpc' : undefined);
  if (rpcUrl === undefined || rpcUrl === '') {
    throw new Error(
      'Dev private-key mode needs an RPC: set VITE_RPC_URL, or use the vite /rpc proxy in dev (it targets 127.0.0.1:8545)',
    );
  }
  return createPublicClient({ chain: bsc, transport: http(rpcUrl) });
}

function signerFor(wallet: RenewalWallet): LocalAccount | WalletClient {
  if (wallet.kind === 'dev') return wallet.account;
  return createWalletClient({
    account: wallet.address,
    chain: bsc,
    transport: custom(wallet.provider as never),
  });
}

export type RenewalReceipt = {
  userOpHash: Hex;
  txHash: Hex;
  success: boolean;
  gasUsed: string | null;
};

/**
 * 送出「安裝新權限」的 UserOp。
 *
 * `initConfig` 的每一筆都是**打給帳戶自己**的 calldata（`msg.sender == self` 才會被 Kernel 當成
 * 自我呼叫），所以 `to` 一定是 `accountAddress`。
 */
/**
 * 用 owner 錢包送一筆 sudo UserOp，`calls` 原樣執行。
 *
 * 續期（安裝權限）與 approve 都是「帳戶自己做的事、需要 owner 簽名」，差別只在 calls 的內容 ——
 * 所以組裝與送出只有這一份。
 */
/**
 * 帳戶的 counterfactual salt —— **必須與後端逐 byte 相同**。
 *
 * 後端（`backend/src/kernel.ts` 的 `computeSalt`）用
 * `keccak256(encodePacked(['string','address','uint256'], [TAG, owner, strategyId]))`
 * 當 `createKernelAccount` 的 `index`。前端若省略 index（等於 0n），推導出的
 * counterfactual 地址就**不是**那個帳戶 —— 簽章會綁到錯的設定上，EntryPoint 只會回
 * 一句看不懂的 `AA24 signature error`。
 */
const SALT_DOMAIN_TAG = 'cre8-atp:kernel-v3.3';

export function computeAccountSalt(owner: Address, strategyId: number): bigint {
  return BigInt(
    keccak256(encodePacked(['string', 'address', 'uint256'], [SALT_DOMAIN_TAG, owner, BigInt(strategyId)])),
  );
}

export async function sendSudoCalls(args: {
  wallet: RenewalWallet;
  token: string;
  accountAddress: Address;
  calls: readonly { to: Address; data: Hex; value: bigint }[];
  /** 投組對應的策略 id —— 用來算出與後端相同的帳戶 salt（見 `computeAccountSalt`）。 */
  strategyId: number;
  timeoutMs?: number;
}): Promise<RenewalReceipt> {
  const publicClient = publicClientFor(args.wallet);
  const entryPoint = ENTRY_POINT as never;
  const kernelVersion: GetKernelVersion<'0.7'> = KERNEL_V3_3;

  // 位址**明確傳**：帳戶已經存在，它的位址不該取決於這一次跑出來的 init code。
  const sudoAccount = await createKernelAccount(publicClient, {
    address: args.accountAddress,
    // 與後端同一個 index（salt）；少了它，SDK 會用 0n 推導出不同的帳戶設定。
    index: computeAccountSalt(args.wallet.address as Address, args.strategyId),
    plugins: {
      sudo: await signerToEcdsaValidator(publicClient, {
        signer: signerFor(args.wallet) as never,
        entryPoint,
        kernelVersion,
      }),
    },
    entryPoint,
    kernelVersion,
    useMetaFactory: true,
  });

  // 「連錯錢包」要講清楚，不要讓它變成 AA24。
  //
  // Kernel 的 sudo 驗證是「這個簽名是不是帳戶 owner 簽的」。如果使用者目前連的錢包
  // 不是當初建立那個帳戶的 owner，EntryPoint 只會回一句 `AA24 signature error` ——
  // 那句話完全看不出原因是「錢包不對」，而使用者只會以為是我們的程式壞了。
  //
  // 這裡用同一個 signer 推導一次 counterfactual 地址來比對：地址不同就代表簽名者不是 owner。
  if (sudoAccount.address.toLowerCase() !== args.accountAddress.toLowerCase()) {
    throw new Error(
      `This wallet does not control the fund's account. ` +
        `Connected signer derives ${sudoAccount.address}, but the fund lives at ${args.accountAddress}. ` +
        `Switch MetaMask to the wallet that created this position (the one shown in "My position"), then try again.`,
    );
  }

  const accountClient = createKernelAccountClient({
    account: sudoAccount,
    chain: bsc,
    client: publicClient,
    bundlerTransport: http(`${API_BASE}/bundler`, {
      // relay 是認證端點：沒有這個標頭會回 401 UNAUTHORIZED。
      fetchOptions: { headers: { authorization: `Bearer ${args.token}` } },
      // 估 gas ＋ 送 op ＋ 等 receipt，10 秒（viem 預設）不夠。
      timeout: 60_000,
    }),
    userOperation: {
      // alto 不提供 ZeroDev 的 zd_getUserOperationGasPrice，用節點 gas price（與 scripts 一致）。
      estimateFeesPerGas: async () => {
        const gasPrice = await publicClient.getGasPrice();
        return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
      },
    },
  });

  const userOpHash = await accountClient.sendUserOperation({ calls: args.calls });
  const receipt = await accountClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: args.timeoutMs ?? 180_000,
  });

  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    success: receipt.success,
    gasUsed: receipt.actualGasUsed?.toString() ?? null,
  };
}

/**
 * 續期：把 `initConfig` 的每一筆當成一個 call（`to` 是帳戶自己 —— `msg.sender == self`）。
 *
 * 包在 `sendSudoCalls` 外面只是為了留住「續期」這個名字，行為完全一樣。
 */
export async function sendRenewalUserOp(args: {
  wallet: RenewalWallet;
  token: string;
  accountAddress: Address;
  entryPoint: string;
  initConfig: readonly Hex[];
  /** 投組對應的策略 id（算出帳戶 salt 用）。 */
  strategyId: number;
  timeoutMs?: number;
}): Promise<RenewalReceipt> {
  assertEntryPoint(args.entryPoint);
  return sendSudoCalls({
    wallet: args.wallet,
    token: args.token,
    accountAddress: args.accountAddress,
    strategyId: args.strategyId,
    calls: args.initConfig.map((data) => ({ to: args.accountAddress, data, value: 0n })),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
}

/** ERC-20 `approve` 的 calldata（`uint256(2**256-1)` = 無限額度）。 */

/** `transfer(to, amount)` 的 calldata —— 提領就是這一筆（帳戶 → 使用者錢包）。 */
/**
 * 把帳戶裡多個資產一次掃回錢包（一筆 sudo UserOp、多個 transfer）。
 *
 * 為什麼要「一次」：清倉後殘留的是 wei 級塵埃，每一筆各自送一個 UserOp 的話，
 * 光 gas 就比那些塵埃值錢。合併成一筆只付一次 overhead。
 *
 * 只掃**餘額 > 0** 的資產；`0` 的別送（transfer(0) 浪費 gas 又沒有語意）。
 */
export async function sendSweep(args: {
  wallet: RenewalWallet;
  token: string;
  accountAddress: Address;
  recipient: Address;
  /** 要掃出去的資產與金額（wei）。金額為 0 的會被忽略。 */
  /** 投組對應的策略 id（算出帳戶 salt 用）。 */
  strategyId: number;
  balances: readonly { asset: Address; amountWei: bigint }[];
  /**
   * 額外要退回的原生幣（wei），與代幣轉帳放在**同一個** UserOp 裡。
   *
   * 為什麼不能事後再送一筆：連續兩筆 UserOp 時，第二筆的 account nonce 可能還沒推進，
   * 模擬階段就以 `AA25 invalid account nonce` 失敗（實測清倉後掃 BNB 就是這樣掛的）。
   * 合併成一筆同時也省一次 overhead。
   */
  nativeWei?: bigint;
}): Promise<RenewalReceipt | null> {
  const calls = args.balances
    .filter((row) => row.amountWei > 0n)
    .map((row) => ({ to: row.asset, data: transferCalldata(args.recipient, row.amountWei), value: 0n }));
  if (args.nativeWei !== undefined && args.nativeWei > 0n) {
    calls.push({ to: args.recipient, data: '0x', value: args.nativeWei });
  }
  if (calls.length === 0) return null;
  return sendSudoCalls({
    wallet: args.wallet,
    token: args.token,
    accountAddress: args.accountAddress,
    strategyId: args.strategyId,
    calls,
  });
}

export function transferCalldata(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transfer',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
      },
    ] as const,
    functionName: 'transfer',
    args: [to, amount],
  });
}

/**
 * 從 Kernel 帳戶提領一個資產到使用者自己的錢包。
 *
 * 為什麼一定要 owner 簽名：session key 的 CallPolicy 只允許 `executeRebalance`，
 * 所以「把錢轉出去」這件事**只能**由 owner 的 sudo 驗證做（跟 approve 同一條路徑）。
 * 這也意味著提領需要帳戶裡有 BNB 付 gas —— 沒有就先 top up。
 */
export async function sendWithdraw(args: {
  wallet: RenewalWallet;
  token: string;
  accountAddress: Address;
  asset: Address;
  recipient: Address;
  amountWei: bigint;
  /** 投組對應的策略 id（算出帳戶 salt 用）。 */
  strategyId: number;
}): Promise<RenewalReceipt> {
  if (args.amountWei === 0n) throw new Error('withdraw amount must be greater than zero');
  return sendSudoCalls({
    wallet: args.wallet,
    token: args.token,
    accountAddress: args.accountAddress,
    strategyId: args.strategyId,
    calls: [{ to: args.asset, data: transferCalldata(args.recipient, args.amountWei), value: 0n }],
  });
}

export function approveCalldata(spender: Address): Hex {
  return encodeFunctionData({
    abi: [
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
    ] as const,
    functionName: 'approve',
    args: [spender, (1n << 256n) - 1n],
  });
}

/** 帳戶對 spender 的 ERC-20 allowance。 */
/**
 * 唯讀的 public client —— **不需要錢包**。
 *
 * allowance 是純讀取，卻原本綁在「錢包 transport」上，於是沒連錢包時整個 Allowance 區塊只能顯示
 * 那段長說明（永遠不知道其實已經 approve 了）。把讀取與簽名拆開：讀用 RPC，簽才需要錢包。
 */
export function readOnlyClient(): PublicClient {
  const rpcUrl = import.meta.env.VITE_RPC_URL ?? (import.meta.env.DEV ? '/rpc' : undefined);
  if (rpcUrl === undefined || rpcUrl === '') {
    throw new Error(
      'Reading allowance needs an RPC: set VITE_RPC_URL (in dev the vite /rpc proxy is used automatically)',
    );
  }
  return createPublicClient({ chain: bsc, transport: http(rpcUrl) });
}

export async function readAllowance(args: {
  /** 有連錢包就用它的 transport（沿用使用者自己的 RPC）；沒有就退回唯讀 client。 */
  wallet?: RenewalWallet | null;
  token: Address;
  owner: Address;
  spender: Address;
}): Promise<bigint> {
  const client = args.wallet === null || args.wallet === undefined ? readOnlyClient() : publicClientFor(args.wallet);
  return (await client.readContract({
    address: args.token,
    abi: [
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
    ] as const,
    functionName: 'allowance',
    args: [args.owner, args.spender],
  })) as bigint;
}

/**
 * 從 owner 錢包送 BNB 到某個位址（給新帳戶付 UserOp 的 gas）。
 *
 * 為什麼需要它：新帳戶部署時 operator 付 gas，但**之後**每一筆 UserOp（approve、再平衡）都由帳戶自己付。
 * 帳戶沒有 BNB 時，approve 這筆 op 會因為付不出 gas 而失敗 —— 而錯誤訊息不會提到「沒錢」。
 */
export async function sendGasTopUp(args: {
  wallet: RenewalWallet;
  to: Address;
  valueWei: bigint;
}): Promise<Hex> {
  if (args.wallet.kind === 'dev') {
    const rpcUrl = import.meta.env.VITE_RPC_URL ?? (import.meta.env.DEV ? '/rpc' : undefined);
    if (rpcUrl === undefined || rpcUrl === '') {
      throw new Error('dev 私鑰模式需要一個 RPC 才能送交易：設 VITE_RPC_URL（dev 預設 /rpc）');
    }
    const client = createWalletClient({ account: args.wallet.account, chain: bsc, transport: http(rpcUrl) });
    return client.sendTransaction({ to: args.to, value: args.valueWei, chain: bsc });
  }
  const client = createWalletClient({
    account: args.wallet.address,
    chain: bsc,
    transport: custom(args.wallet.provider as never),
  });
  return client.sendTransaction({ to: args.to, value: args.valueWei, chain: bsc });
}
