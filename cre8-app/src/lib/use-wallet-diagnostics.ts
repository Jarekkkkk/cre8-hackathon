import { useEffect, useState } from 'react';

/**
 * 錢包端診斷：**注入式錢包讀的是它自己設定的 RPC**，不是我們後端那一條。
 *
 * 為什麼需要它：MetaMask 內建的「BNB Smart Chain」chainId 也是 56，但指向真的 BSC 主網。
 * 使用者切到那個網路時，App 走 `/rpc`（本機 anvil）一切正常，但**簽名會被送到主網**，
 * 於是錢包說「你沒有足夠的 BNB 付手續費」—— 而本機 fork 上那個位址其實有 10 BNB。
 * 這句話完全指錯方向，排查會花很久（我們自己就花了三輪）。
 *
 * 所以連上錢包後直接讀兩邊的數字，並且在 chainId 相同但餘額不同時明說
 * 「你的錢包連到另一條 chain 56 的網路」。
 */
export type WalletDiagnostics = {
  walletChainId: number | null;
  walletBalanceWei: bigint | null;
  nodeBalanceWei: bigint | null;
  nodeChainId: number | null;
  /** 一句話結論；`null` = 一切正常。 */
  problem: string | null;
};

const EXPECTED_CHAIN_ID = 56;

type Eip1193 = { request?: (args: { method: string; params: unknown[] }) => Promise<unknown> };

export function useWalletDiagnostics(address: string | null, provider: unknown): WalletDiagnostics {
  const [state, setState] = useState<WalletDiagnostics>({
    walletChainId: null,
    walletBalanceWei: null,
    nodeBalanceWei: null,
    nodeChainId: null,
    problem: null,
  });

  useEffect(() => {
    if (address === null) return;
    let cancelled = false;

    void (async () => {
      const rpcUrl = import.meta.env.VITE_RPC_URL ?? (import.meta.env.DEV ? '/rpc' : undefined);
      const injected = provider as Eip1193 | null;
      const ask = (method: string, params: unknown[]) => injected?.request?.({ method, params });
      const fromNode = async (method: string, params: unknown[]): Promise<string | null> => {
        if (rpcUrl === undefined) return null;
        try {
          const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          const body = (await res.json()) as { result?: string };
          return body.result ?? null;
        } catch {
          return null;
        }
      };

      const [walletChain, walletBal, nodeChain, nodeBal] = await Promise.all([
        ask('eth_chainId', [])?.catch(() => null) ?? Promise.resolve(null),
        ask('eth_getBalance', [address, 'latest'])?.catch(() => null) ?? Promise.resolve(null),
        fromNode('eth_chainId', []),
        fromNode('eth_getBalance', [address, 'latest']),
      ]);

      if (cancelled) return;

      const parseHex = (value: unknown): bigint | null => {
        if (typeof value !== 'string') return null;
        try {
          return BigInt(value);
        } catch {
          return null;
        }
      };

      const walletChainId = walletChain === null ? null : Number(parseHex(walletChain) ?? -1n);
      const nodeChainId = nodeChain === null ? null : Number(parseHex(nodeChain) ?? -1n);
      const walletBalanceWei = parseHex(walletBal);
      const nodeBalanceWei = parseHex(nodeBal);

      let problem: string | null = null;
      if (walletChainId !== null && walletChainId !== EXPECTED_CHAIN_ID) {
        problem =
          `Your wallet is on chain ${walletChainId}, but this app runs on chain ${EXPECTED_CHAIN_ID}. ` +
          `Point the wallet network at RPC ${rpcUrl ?? 'http://127.0.0.1:8545'} with chain id ${EXPECTED_CHAIN_ID}.`;
      } else if (
        walletBalanceWei !== null &&
        nodeBalanceWei !== null &&
        walletBalanceWei === 0n &&
        nodeBalanceWei > 0n
      ) {
        problem =
          `Your wallet reports 0 BNB, but this node reports ${Number(nodeBalanceWei) / 1e18} BNB for the same address ` +
          `and the same chain id — so the wallet is pointed at a DIFFERENT network that also uses chain ${EXPECTED_CHAIN_ID} ` +
          `(most likely the real BSC mainnet). Edit that network's RPC URL to ${rpcUrl ?? 'http://127.0.0.1:8545'}.`;
      }

      setState({ walletChainId, walletBalanceWei, nodeBalanceWei, nodeChainId, problem });
    })();

    return () => {
      cancelled = true;
    };
  }, [address, provider]);

  return state;
}
