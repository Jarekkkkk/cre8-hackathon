import { bsc } from 'viem/chains';
import type { Chain } from 'viem';

import { getConfig } from './config.js';

/**
 * 這個部署實際跑的鏈物件。
 *
 * 為什麼不能直接用 `viem/chains` 的 `bsc`：那個物件的 `id` 固定是 56，而 ERC-4337 的
 * `userOpHash` **包含 chainId** —— 在 chainId 1337 的本機 fork 上用 56 去簽，EntryPoint 一定
 * 判簽章無效（錯誤訊息只說 "Signature provided for the User Operation is invalid"，
 * 完全看不出是 chainId 的問題）。同一個道理也適用 `eth_chainId` 相關的斷言。
 *
 * 所以凡是**會影響簽章或交易**的地方，都要用這個函式拿到「與 RPC 一致的鏈物件」。
 */
export function activeChain(): Chain {
  const { chainId } = getConfig();
  if (chainId === bsc.id) return bsc;
  return {
    ...bsc,
    id: chainId,
    name: `CRE8 Local (${chainId})`,
  } as Chain;
}
