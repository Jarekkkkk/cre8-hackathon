import type { ReactNode } from 'react';

export type AppTab = 'explore' | 'creators' | 'create' | 'manage' | 'portfolio';
export type AppIconName = AppTab | 'rebalance' | 'search' | 'filter' | 'left' | 'right' | 'down'
  | 'close' | 'share' | 'external' | 'info' | 'holdings' | 'activity' | 'deposit'
  | 'withdraw' | 'wallet' | 'check' | 'alert' | 'clock' | 'document' | 'network'
  | 'sort' | 'reset' | 'edit' | 'chart';

export function AppIcon({ name, active = false, size = 20 }: {
  name: AppIconName;
  active?: boolean;
  size?: number;
}) {
  let symbol: ReactNode;
  switch (name) {
    case 'explore':
      symbol = <><circle cx="12" cy="12" r="8.75" /><path d="m15.6 8.4-2.05 5.15L8.4 15.6l2.05-5.15Z" fill={active ? 'currentColor' : 'none'} /></>;
      break;
    case 'creators':
      symbol = <>
        <circle cx="9" cy="8" r="3" fill={active ? 'currentColor' : 'none'} />
        <path d="M3.3 19v-.75c0-2.62 2.3-4.25 5.7-4.25s5.7 1.63 5.7 4.25V19Z" fill={active ? 'currentColor' : 'none'} />
        <path d="M16 5.4a2.8 2.8 0 0 1 0 5.2m.55 3.6c2.54.32 4.15 1.81 4.15 4.03V19" />
      </>;
      break;
    case 'create':
      symbol = <>
        <rect x="4" y="4" width="16" height="16" rx="4.2" fill={active ? 'currentColor' : 'none'} />
        <path d="M12 8.6v6.8m-3.4-3.4h6.8" stroke={active ? 'var(--snow)' : 'currentColor'} />
      </>;
      break;
    case 'manage':
      symbol = <><rect x="5" y="4.5" width="14" height="16" rx="3" /><path d="M9 9.25h6m-6 3.5h6m-6 3.5h3.5" /></>;
      break;
    case 'rebalance':
      symbol = <path d="M3.8 8h16.4m-4.3-4.3L20.2 8l-4.3 4.3m4.3 3.7H3.8m4.3-4.3L3.8 16l4.3 4.3" />;
      break;
    case 'portfolio':
      symbol = <g fill={active ? 'currentColor' : 'none'}>
        <rect x="4" y="13" width="3.2" height="6.7" rx="1" />
        <rect x="10.4" y="8.5" width="3.2" height="11.2" rx="1" />
        <rect x="16.8" y="4" width="3.2" height="15.7" rx="1" />
      </g>;
      break;
    case 'search':
      symbol = <><circle cx="10.7" cy="10.7" r="5.9" /><path d="m15 15 4.5 4.5" /></>;
      break;
    case 'filter':
      symbol = <><path d="M4 6h5m4 0h7M4 12h10m4 0h2M4 18h3m4 0h9" /><path d="M9 3.7v4.6m9 1.4v4.6m-7 1.4v4.6" /></>;
      break;
    case 'left': symbol = <path d="m14.75 5.75-6.25 6.25 6.25 6.25" />; break;
    case 'right': symbol = <path d="m9.25 5.75 6.25 6.25-6.25 6.25" />; break;
    case 'down': symbol = <path d="m5.75 9.25 6.25 6.25 6.25-6.25" />; break;
    case 'close': symbol = <path d="m6.25 6.25 11.5 11.5m0-11.5-11.5 11.5" />; break;
    case 'share':
      symbol = <path d="M8 9H6.5a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2H16m-4 6V3m-3 3 3-3 3 3" />;
      break;
    case 'external': symbol = <path d="M7 17 17 7M8.5 7H17v8.5" />; break;
    case 'info':
      symbol = <><circle cx="12" cy="12" r="8.75" /><path d="M12 11.25v4.65M12 8v.1" /></>;
      break;
    case 'holdings':
      symbol = <><rect x="3.5" y="6.25" width="17" height="13" rx="3" /><path d="M8.8 6V5a1.5 1.5 0 0 1 1.5-1.5h3.4A1.5 1.5 0 0 1 15.2 5v1M4 12.5h16m-8 0v2" /></>;
      break;
    case 'activity':
      symbol = <><circle cx="12" cy="12" r="8.75" /><path d="M12 7.5v4.75l3 1.75" /></>;
      break;
    case 'deposit':
    case 'withdraw':
      symbol = <>
        <path d="M7.25 10h-2l-2.1 4.2v3.65a1.9 1.9 0 0 0 1.9 1.9h13.9a1.9 1.9 0 0 0 1.9-1.9V14.2l-2.1-4.2h-2m-13.4 4.5h5.9l1.25 1.7h3l1.25-1.7h5.9" />
        <path d={name === 'deposit' ? 'M12 3.5v7m-3-3 3 3 3-3' : 'M12 10.5v-7m-3 3 3-3 3 3'} />
      </>;
      break;
    case 'wallet':
      symbol = <><path d="M20.5 9V7.5a2 2 0 0 0-2-2H6a2.5 2.5 0 0 0 0 5h13.5a1 1 0 0 1 1 1V17a2 2 0 0 1-2 2H6a2.5 2.5 0 0 1-2.5-2.5V8" /><path d="M20.5 13h-4.2a1.75 1.75 0 0 0 0 3.5h4.2" /></>;
      break;
    case 'check': symbol = <path d="m5.5 12.3 4.2 4.2 8.8-9" />; break;
    case 'alert': symbol = <path d="M12 6.25v7.2m0 3.7v.1" />; break;
    case 'clock': symbol = <path d="M12 5.7v6.55l4.4 2.5" />; break;
    case 'document':
      symbol = <path d="M7 3.75h7l4.25 4.5V18.5a1.75 1.75 0 0 1-1.75 1.75h-9a1.75 1.75 0 0 1-1.75-1.75V5.5A1.75 1.75 0 0 1 7.5 3.75M14 4v4.25h4m-9 4h6m-6 3.5h6" />;
      break;
    case 'network':
      symbol = <><circle cx="12" cy="12" r="8.75" /><ellipse cx="12" cy="12" rx="3.65" ry="8.75" /><path d="M3.5 12h17" /></>;
      break;
    case 'sort':
      symbol = <path d="M4.25 7h15.5M4.25 12h11M4.25 17h6.5" />;
      break;
    case 'reset':
      symbol = <path d="M5 10a7.2 7.2 0 1 1 .5 5.7M5 5v5h5" />;
      break;
    case 'edit':
      symbol = <path d="m5 15.5 10.25-10.25a2.3 2.3 0 0 1 3.25 3.25L8.25 18.75l-4 .75L5 15.5Zm8.75-8.75L17 10" />;
      break;
    case 'chart':
      symbol = <path d="M4.5 5v13a1.5 1.5 0 0 0 1.5 1.5h13m-11.5-4.8 3.3-4.2 2.8 2.2L19 6.5" />;
      break;
  }

  return (
    <svg className="app-icon" viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth={active ? 1.9 : 1.7} strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" focusable="false">
      {symbol}
    </svg>
  );
}
