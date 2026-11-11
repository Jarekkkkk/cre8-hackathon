/**
 * 錢包連線（EIP-6963）與訊息簽名。
 *
 * 為什麼用 EIP-6963 而不是 `window.ethereum`：後者是「最後注入者贏」，裝了多個錢包時會連到
 * 不是使用者想連的那一個。6963 讓每個錢包自己廣播身分，dApp 列出清單讓使用者選。
 */
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, LocalAccount } from 'viem';

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  disconnect?: () => Promise<void>;
  /** EIP-1193 事件（可選：某些錢包只提供 request）。 */
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export type ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type ProviderDetail = {
  info: ProviderInfo;
  provider: Eip1193Provider;
};

/** rdns → 已廣播的錢包。同一個錢包重複廣播時以最後一次為準。 */
const announced = new Map<string, ProviderDetail>();
let listening = false;

function isProviderDetail(value: unknown): value is ProviderDetail {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { info?: { rdns?: unknown; uuid?: unknown }; provider?: { request?: unknown } };
  return (
    typeof candidate.info?.rdns === 'string' &&
    typeof candidate.info?.uuid === 'string' &&
    typeof candidate.provider?.request === 'function'
  );
}

function ensureListener(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('eip6963:announceProvider', (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isProviderDetail(detail)) announced.set(detail.info.rdns, detail);
  });
}

/**
 * 列出可用的錢包。
 *
 * 先 dispatch `eip6963:requestProvider`（錢包收到會補廣播，所以「比 dApp 早載入」的錢包也抓得到），
 * 等一小段時間讓晚一步注入的錢包趕上。
 */
export function discoverProviders(waitMs = 300): Promise<ProviderDetail[]> {
  if (typeof window === 'undefined') return Promise.resolve([]);
  ensureListener();
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  return new Promise((resolve) => {
    window.setTimeout(() => resolve([...announced.values()]), waitMs);
  });
}

/** 已在清單裡的錢包（不重新等待），給「重新整理」按鈕用。 */
export function knownProviders(): ProviderDetail[] {
  return [...announced.values()];
}

export async function connectProvider(provider: Eip1193Provider): Promise<string> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== 'string') throw new Error('The wallet returned no account (the user may have cancelled the connection)');
  return first;
}

export async function chainIdOf(provider: Eip1193Provider): Promise<number> {
  const raw = await provider.request({ method: 'eth_chainId' });
  if (typeof raw !== 'string') throw new Error('eth_chainId did not return a string');
  return Number.parseInt(raw, 16);
}

/** 用錢包簽 EIP-191 訊息（SIWE 就是 personal_sign）。 */
export async function signWithProvider(
  provider: Eip1193Provider,
  address: string,
  message: string,
): Promise<string> {
  const signature = await provider.request({
    method: 'personal_sign',
    params: [toHexMessage(message), address],
  });
  if (typeof signature !== 'string') throw new Error('The wallet returned no signature');
  return signature;
}

function toHexMessage(message: string): Hex {
  const bytes = new TextEncoder().encode(message);
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex as Hex;
}

export type DevSigner = {
  address: string;
  signMessage: (message: string) => Promise<string>;
  /** 續期要用它當 sudo signer（Kernel 的 owner validator）。 */
  account: LocalAccount;
};

/**
 * dev 用：極簡私鑰簽名。**只在 `import.meta.env.DEV` 下提供入口**，且私鑰只存在記憶體。
 *
 * 這不是「另一個登入方式」，是讓本機 anvil 的測試帳戶能走完同一條 SIWE 流程 —— 沒有它，
 * 每次改前端都得插硬體錢包。
 */
export function createDevSigner(privateKey: Hex): DevSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signMessage: (message: string) => account.signMessage({ message }),
    account,
  };
}

export function isLikelyPrivateKey(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

/**
 * 讓錢包切到 `chainId`；錢包不認識這條鏈時把它加進去。
 *
 * ## 為什麼一定要做這件事
 *
 * 這個 app 之前**完全沒有** `wallet_switchEthereumChain` —— 連上錢包之後就直接用
 * 「錢包目前所在的鏈」。實測後果：使用者上次測試時把 MetaMask 加了一個
 * 「CRE8 Local (1337)」的網路，之後打開主網的網站，畫面看起來像「網站連到 1337 測試網」，
 * 實際上只是錢包停在那條鏈上，而我們照著用。
 *
 * 那種狀態下每個讀取都會失敗（RPC 指向已關閉的 anvil），而使用者看到的是一堆看不懂的錯誤。
 * 主動切鏈、切不動就明講，比靜默用錯鏈好。
 *
 * ## 三種結果
 *
 *   'already' —— 本來就在這條鏈上（最常見）
 *   'switched' —— 成功切換（或先加入再切換）
 *   'declined' —— 使用者在錢包裡按了取消；呼叫端應該提示而不是報錯
 */
export async function ensureChain(
  provider: Eip1193Provider,
  chainId: number,
  addParams: { chainName: string; rpcUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrls?: string[] },
): Promise<'already' | 'switched' | 'declined'> {
  const current = await chainIdOf(provider).catch(() => null);
  if (current === chainId) return 'already';

  const hex = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    return 'switched';
  } catch (cause) {
    // 4902 = 錢包不認識這條鏈 → 加進去再切一次。
    // 其他錯誤（含使用者按取消的 4001）往上拋由呼叫端判斷。
    const code = (cause as { code?: number }).code;
    if (code !== 4902) {
      if (code === 4001) return 'declined';
      throw cause;
    }
  }

  await provider.request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: hex,
        chainName: addParams.chainName,
        rpcUrls: addParams.rpcUrls,
        nativeCurrency: addParams.nativeCurrency,
        ...(addParams.blockExplorerUrls === undefined ? {} : { blockExplorerUrls: addParams.blockExplorerUrls }),
      },
    ],
  });
  return 'switched';
}
