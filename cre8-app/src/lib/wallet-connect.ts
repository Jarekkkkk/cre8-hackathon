import { isAddress } from 'viem';
import type { EthereumProvider } from '@walletconnect/ethereum-provider';
import { CHAIN_ID } from './kernel';
import type { Eip1193Provider } from './wallet';

// The WalletConnect SDK reads this value to reopen the selected app for signing.
const DEEP_LINK_KEY = 'WALLETCONNECT_DEEPLINK_CHOICE';

export function rememberWalletConnectApp(href: string | null): void {
  try {
    if (href) window.localStorage.setItem(DEEP_LINK_KEY, JSON.stringify({ href }));
    else window.localStorage.removeItem(DEEP_LINK_KEY);
  } catch {
    // Wallets can still be opened manually when storage is unavailable.
  }
}

export const WALLETCONNECT_RDNS = 'com.walletconnect';
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() ?? '';
export const walletConnectAvailable = /^[0-9a-f]{32}$/i.test(projectId) &&
  (CHAIN_ID === 56 || CHAIN_ID === 97);

type WalletConnectProvider = Awaited<ReturnType<typeof EthereumProvider.init>>;
type Connection = { address: string; rdns: string; provider: Eip1193Provider };
type UriListener = (uri: string) => void;
type Pairing = {
  uri: string | null;
  listeners: Set<UriListener>;
  connection: Promise<Connection>;
};

let initialization: Promise<WalletConnectProvider> | undefined;
let pendingPairing: Pairing | undefined;

function walletConnectProvider(): Promise<WalletConnectProvider> {
  if (!initialization) {
    initialization = import('@walletconnect/ethereum-provider').then(({ EthereumProvider }) =>
      EthereumProvider.init({
        projectId,
        chains: [CHAIN_ID],
        methods: ['personal_sign', 'eth_sendTransaction'],
        optionalMethods: ['eth_signTypedData_v4', 'wallet_switchEthereumChain'],
        events: ['accountsChanged', 'chainChanged'],
        showQrModal: false,
        telemetryEnabled: false,
        metadata: {
          name: 'CRE8',
          description: 'Explore and manage CRE8 funds',
          url: window.location.origin,
          icons: [new URL('/logos/cre8-icon.svg', window.location.origin).href],
        },
      }),
    ).catch((cause) => {
      initialization = undefined;
      throw cause;
    });
  }
  return initialization;
}

function activeConnection(provider: WalletConnectProvider): Connection | null {
  const address = provider.accounts[0];
  if (!provider.session || provider.session.expiry <= Date.now() / 1000 ||
    provider.chainId !== CHAIN_ID || !address || !isAddress(address)) return null;
  return { address, rdns: WALLETCONNECT_RDNS, provider: provider as Eip1193Provider };
}

export async function restoreWalletConnect(): Promise<Connection | null> {
  return walletConnectAvailable ? activeConnection(await walletConnectProvider()) : null;
}

export function pairWalletConnect(onUri: UriListener): Promise<Connection> {
  if (!pendingPairing) {
    const listeners = new Set<UriListener>();
    const connection = walletConnectProvider().then(async (provider) => {
      const existing = activeConnection(provider);
      if (existing) return existing;
      if (provider.session) await provider.disconnect();
      rememberWalletConnectApp(null);

      const updateUri = (uri: string) => {
        if (pendingPairing?.listeners !== listeners || !uri.startsWith('wc:')) return;
        pendingPairing.uri = uri;
        for (const listener of listeners) listener(uri);
      };
      provider.on('display_uri', updateUri);
      try {
        await provider.connect();
        const connected = activeConnection(provider);
        if (connected) return connected;
        if (provider.session) await provider.disconnect();
        throw new Error('The wallet did not approve a BNB Smart Chain account.');
      } finally {
        provider.removeListener('display_uri', updateUri);
      }
    }).finally(() => {
      pendingPairing = undefined;
    });
    pendingPairing = { uri: null, listeners, connection };
  }

  const pairing = pendingPairing;
  let timeout: number | undefined;
  const preparation = new Promise<never>((_, reject) => {
    timeout = window.setTimeout(() => reject(new Error(
      'WalletConnect could not start. Try again or use a browser wallet.',
    )), 15_000);
  });
  const notifyUri = (uri: string) => {
    window.clearTimeout(timeout);
    onUri(uri);
  };
  pairing.listeners.add(notifyUri);
  if (pairing.uri) notifyUri(pairing.uri);

  return Promise.race([pairing.connection, preparation]).finally(() => {
    window.clearTimeout(timeout);
    pairing.listeners.delete(notifyUri);
  });
}
