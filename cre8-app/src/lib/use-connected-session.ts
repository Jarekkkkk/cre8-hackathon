import { sessionIsLive, useSession } from '../store/session';
import { useWallet } from '../store/wallet';

export function useConnectedSessionToken(): string | null {
  const walletAddress = useWallet((state) => state.address);
  const { token, expiresAt, address } = useSession();
  return walletAddress !== null &&
    address?.toLowerCase() === walletAddress.toLowerCase() &&
    sessionIsLive({ token, expiresAt })
    ? token
    : null;
}
