import { useEffect, useState } from 'react';
import { rememberWalletConnectApp } from '../lib/wallet-connect';

export function WalletConnectPairing({ uri, mobile }: { uri: string; mobile: boolean }) {
  const [qrCode, setQrCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import('qrcode').then(({ toDataURL }) =>
      toDataURL(uri, { width: 240, margin: 2 }),
    ).then((image) => {
      if (!cancelled) setQrCode(image);
    }).catch(() => {
      if (!cancelled) setQrCode(null);
    });
    return () => { cancelled = true; };
  }, [uri]);

  const encoded = encodeURIComponent(uri);
  const wallets = [
    { name: 'MetaMask', link: 'https://metamask.app.link' },
    { name: 'Trust Wallet', link: 'https://link.trustwallet.com' },
  ];
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    wallets.push(
      { name: 'Binance Wallet', link: 'bnc://app.binance.com/cedefi' },
      { name: 'OKX Wallet', link: 'okex://main' },
    );
  }

  return (
    <>
      <p className="wallet-menu__hint" role="status">
        {mobile ? 'Open your wallet app to approve the connection.' : 'Scan with your wallet app to connect.'}
      </p>
      {mobile && wallets.map(({ name, link }) => (
        <a key={name} className="wallet-menu__item" role="menuitem" href={`${link}/wc?uri=${encoded}`}
          onClick={() => rememberWalletConnectApp(link)}
          target={link.startsWith('https:') ? '_blank' : undefined} rel="noreferrer">
          {name}
        </a>
      ))}
      {qrCode && (mobile ? (
        <details className="wallet-connect-qr">
          <summary>Show QR code</summary>
          <img src={qrCode} alt="WalletConnect pairing QR code" width={208} height={208} />
        </details>
      ) : (
        <div className="wallet-connect-qr">
          <img src={qrCode} alt="WalletConnect pairing QR code" width={208} height={208} />
        </div>
      ))}
    </>
  );
}
