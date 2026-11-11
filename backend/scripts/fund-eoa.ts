/**
 * 在 anvil fork 上補 BNB 給任意位址（通常是測試者的 MetaMask 帳戶）。
 *
 * ## 為什麼需要這支
 * fork 上的 gas 只存在於「本地狀態」：dump 裡有的帳戶（我們的合約、anvil 內建帳戶）不需要上游；
 * 但**測試者的 MetaMask 位址不在 dump 裡**，讀寫都要回源查詢。而上游（publicnode）的歷史狀態
 * 窗口只有約 75 分鐘 —— 過了之後任何新位址的讀寫都會 403，症狀是錢包說「沒有 gas coin」。
 *
 * 實測結論：
 *   * fork **年輕**（剛 refresh）時：`anvil_setBalance` 有效，任何位址都能補。
 *   * fork **過期**後：連 `anvil_setBalance` 的讀回都會 403 —— 那時只能先跑 `refresh-anvil.sh`。
 *
 * 所以正確順序是「先 refresh，再補幣」。
 *
 * 用法：
 *   bun run scripts/fund-eoa.ts --address 0xabc… [--address 0xdef…] [--bnb 10] [--usdt 1000]
 *
 * `--usdt` 用 `anvil_setStorageAt` 直接寫 USDT 的 `balanceOf` slot（BSC USDT 是 slot 1）。
 * 這和 `fund-portfolio.ts` 給 smart account 入金是同一招：**本地狀態就是真相**，
 * 差別只在這次寫的是使用者自己的 EOA。
 */
import { createPublicClient, http, parseEther, parseUnits } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { encodeAbiParameters, keccak256, toHex } from 'viem';

/** BSC 上的 USDT（18 decimals）。用常數是因為這支腳本不接 DB。 */
const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955' as Address;
const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ANVIL_RPC = process.env.ANVIL_RPC_URL ?? process.env.RPC_URL ?? 'http://127.0.0.1:8545';

function flags(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}`) {
      const value = process.argv[i + 1];
      if (value !== undefined) out.push(value);
    }
  }
  return out;
}


/**
 * 直接寫 ERC-20 的 `balanceOf` slot。
 *
 * slot 用**哨兵值探測**而不是寫死：不同代幣的 mapping slot 不一樣（BSC USDT 是 1，但那不是通則）。
 * 哨兵取一個「不可能剛好等於現有餘額」的值，才不會像先前那樣「重跑時剛好相符」而誤判成 slot 0。
 */
async function setErc20Balance(args: {
  client: PublicClient;
  token: Address;
  holder: Address;
  amount: bigint;
  maxSlot?: bigint;
}): Promise<bigint> {
  const sentinel = 123_456_789_012_345_678_901_234_567_890n;
  const maxSlot = args.maxSlot ?? 12n;
  const read = async (): Promise<bigint | null> => {
    try {
      return (await args.client.readContract({
        address: args.token,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [args.holder],
      })) as bigint;
    } catch {
      // 讀不到 ≠ slot 不對：新位址的 slot 還沒被本地快取時會回源失敗。
      return null;
    }
  };

  for (let slot = 0n; slot <= maxSlot; slot += 1n) {
    const key: Hex = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [args.holder, slot]),
    );
    await args.client.request({
      method: 'anvil_setStorageAt' as never,
      params: [args.token, key, toHex(sentinel, { size: 32 })] as never,
    });
    if ((await read()) !== sentinel) continue;
    await args.client.request({
      method: 'anvil_setStorageAt' as never,
      params: [args.token, key, toHex(args.amount, { size: 32 })] as never,
    });
    const after = await read();
    if (after !== args.amount) {
      throw new Error(`slot ${slot} 寫入 ${args.amount} 後回讀不符（${after}）`);
    }
    return slot;
  }
  throw new Error(`試過 slot 0..${maxSlot} 都寫不進 ${args.token} 的 balanceOf`);
}

async function main(): Promise<void> {
  const addresses = flags('address');
  if (addresses.length === 0) throw new Error('至少要一個 --address 0x…');
  const bnb = flags('bnb')[0] ?? '10';
  const value = parseEther(bnb);

  const client = createPublicClient({ transport: http(ANVIL_RPC) });

  for (const raw of addresses) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`不是地址：${raw}`);
    const address = raw as Address;
    // `anvil_setBalance` 直接寫本地狀態；fork 年輕時連「dump 裡沒有的位址」也能寫。
    await client.request({ method: 'anvil_setBalance' as never, params: [address, `0x${value.toString(16)}`] as never });
    const balance = await client.getBalance({ address });
    const ok = balance === value;
    console.log(`  ${address}  ${Number(balance) / 1e18} BNB  ${ok ? '✓' : '✗ 回讀不符'}`);
    if (!ok) {
      throw new Error(
        '回讀不符：fork 可能已經過期（上游 archive 窗口約 75 分鐘）。先跑 refresh-anvil.sh 再試 —— ' +
          '寫入看起來成功但讀不到，就是這個症狀。',
      );
    }
  }

  const usdtAmount = flags('usdt')[0];
  if (usdtAmount !== undefined) {
    const token = (flags('token')[0] ?? BSC_USDT) as Address;
    const amount = parseUnits(usdtAmount, 18);
    for (const raw of addresses) {
      const address = raw as Address;
      const slot = await setErc20Balance({ client, token, holder: address, amount });
      const after = (await client.readContract({
        address: token,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint;
      console.log(`  ${address}  USDT ${Number(after) / 1e18}（slot ${slot}）${after === amount ? '✓' : '✗'}`);
    }
  }

  await mineUntilFinalized(client, addresses as Address[]);
}

/**
 * 挖塊，讓 `finalized` / `safe` 標籤追上我們剛才寫入的狀態。
 *
 * ## 為什麼非做不可
 * MetaMask **讀 `eth_getBalance` 用的是 `finalized`（或 `safe`）區塊**，不是 `latest`。
 * anvil 的 finalized 落後 head 約 64 塊，所以剛補完幣時：
 *
 *     eth_getBalance(addr, "latest")     → 10 BNB  ✓
 *     eth_getBalance(addr, "finalized")  → 0 BNB   ✗ ← 錢包看這個
 *
 * 結果就是錢包顯示「You do not have enough BNB in your account to pay for network fees」，
 * 而鏈上明明有 10 BNB。USDT 的 `balanceOf` 與交易的 `eth_call` 模擬也一樣會讀 finalized，
 * 所以不挖塊的話，錢包連「這筆會不會成功」都判斷錯（顯示 likely to fail）。
 *
 * 實測：`anvil_mine 0x78`（120 塊）之後，finalized 的 BNB 與 USDT 都正確，模擬也通過。
 */
async function mineUntilFinalized(client: PublicClient, addresses: readonly Address[]): Promise<void> {
  const probe = addresses[0];
  if (probe === undefined) return;
  const finalizedBalance = async (): Promise<bigint | null> => {
    try {
      const res = await fetch(ANVIL_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBalance',
          params: [probe, 'finalized'],
        }),
      });
      const body = (await res.json()) as { result?: string };
      return typeof body.result === 'string' ? BigInt(body.result) : null;
    } catch {
      return null;
    }
  };

  const balance = await client.getBalance({ address: probe });
  if ((await finalizedBalance()) === balance) return;

  await client.request({ method: 'anvil_mine' as never, params: ['0x78'] as never });
  const after = await finalizedBalance();
  console.log(
    `  挖 120 塊讓 finalized 追上：finalized 餘額 ${after === null ? '?' : Number(after) / 1e18} BNB` +
      `（MetaMask 讀的是 finalized，不是 latest）${after === balance ? ' ✓' : ' ✗'}`,
  );
}

await main();
