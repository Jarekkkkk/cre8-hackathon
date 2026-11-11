import { useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AppIcon, type AppIconName } from './AppIcon';
import { WalletMenu } from './WalletMenu';
import { MODE_HOME, modeOf, rememberMode, type AppMode } from '../lib/app-mode';
import { useMobile } from '../lib/use-mobile';

/**
 * CRE8 字標：`CRE` + 一個滾動的骰子轉盤停在 8。
 *
 * 這是原站的 `.c8-logo`（純 HTML + CSS，見 design.css 的 `c8roll` keyframes）。原本我們只印了
 * 「CRE8 · ATP」這段文字 —— 那正是「logo 消失」的原因：樣式一直都在，缺的是這段 markup。
 *
 * 轉盤的 9 個 `<i>` 是必要的：`.c8-reel` 的靜態 transform 停在 `-8.952em`，那剛好是第 9 個
 * 數字（8）的位置；少一個就會停在別的數字上。
 */
function C8Logo(): ReactNode {
  return (
    <span className="c8-logo" role="img" aria-label="CRE8">
      <span className="c8-cre" aria-hidden="true">
        CRE
      </span>
      <span className="c8-tile" aria-hidden="true">
        <span className="c8-win">
          <span className="c8-reel">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((digit) => (
              <i key={digit}>{digit}</i>
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}

type Destination = { to: string; label: string; short?: string; icon: AppIconName; paths: string[]; exact?: boolean };

/**
 * 兩個工作區各自的導覽。投資模式只留三個常回來的地方；建立與管理整個搬到 Studio，
 * 一般投資者不會再看到用不到的分頁。
 */
const destinations: Record<AppMode, Destination[]> = {
  invest: [
    { to: '/vaults', label: 'Funds', icon: 'explore', paths: ['/vaults', '/funds', '/vault', '/assets', '/asset'] },
    { to: '/leaderboard', label: 'Creators', icon: 'creators', paths: ['/leaderboard', '/creator'] },
    { to: '/portfolios', label: 'Portfolio', icon: 'portfolio', paths: ['/portfolios', '/portfolio'] },
  ],
  studio: [
    { to: '/studio', label: 'Today', icon: 'activity', paths: ['/studio'], exact: true },
    { to: '/studio/funds', label: 'My funds', icon: 'holdings', paths: ['/studio/funds', '/strategies'] },
    { to: '/create', label: 'Create fund', short: 'Create', icon: 'create', paths: ['/create'] },
    { to: '/studio/earnings', label: 'Earnings', icon: 'chart', paths: ['/studio/earnings'] },
  ],
};

function isActive({ paths, exact }: Destination, pathname: string): boolean {
  return paths.some((path) => pathname === path || (!exact && pathname.startsWith(path + '/')));
}

/**
 * 各分頁根目錄在手機上的標題。這些頁面由頁面自己的 h1 當「大標題」，頂部列只放模式切換與錢包；
 * 捲過大標題後頂部列才出現小標題，跟原生 App 的導覽列一樣。
 */
const tabRootTitles: Record<string, string> = {
  // 首頁就是 Funds（main 的 6565628 讓 Pages 首頁直接開 Explore）。
  '/': 'Funds',
  '/vaults': 'Funds',
  '/leaderboard': 'Creators',
  '/portfolio': 'Portfolio',
  '/portfolios': 'Portfolio',
  '/studio': 'Today',
  '/studio/funds': 'My funds',
  '/studio/earnings': 'Earnings',
  '/create': 'Create a fund',
};

/** 捲過大標題（約 56px）才算「已捲動」；用 passive listener，不擋捲動。 */
function useScrolledPast(threshold: number, enabled: boolean): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setScrolled(window.scrollY > threshold);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [threshold, enabled]);
  return enabled && scrolled;
}

/**
 * 右上角的模式切換。用文字而不是圖示：旁邊已經有錢包圓鈕，再放一個看不懂的圖示只會混淆。
 * 支援 View Transitions 的瀏覽器會淡入淡出，讓「換了一個工作區」這件事看得出來。
 */
function ModeSwitch({ mode }: { mode: AppMode }): ReactNode {
  const navigate = useNavigate();
  const target: AppMode = mode === 'studio' ? 'invest' : 'studio';
  const to = MODE_HOME[target];
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof document.startViewTransition !== 'function' || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    document.startViewTransition(() => flushSync(() => navigate(to)));
  };
  // 文字直接說出按了會發生什麼：「Creator Studio」= 建立與管理自己的基金；「Exit Studio」= 回到投資。
  // 只寫「Studio」「Investing」時，沒用過的人看不出這是什麼、按了去哪。
  return (
    <Link
      className="app-mode-switch"
      to={to}
      onClick={onClick}
      title={target === 'studio' ? 'Create and manage your own funds' : 'Back to browsing and investing'}
      data-target={target}
    >
      <AppIcon name={target === 'studio' ? 'create' : 'left'} size={16} />
      {target === 'studio' ? 'Creator Studio' : 'Exit Studio'}
    </Link>
  );
}

export function TopBar(): ReactNode {
  const { pathname } = useLocation();
  const mobile = useMobile();
  const path = pathname.replace(/\/$/, '') || '/';
  const mode = modeOf(path);
  const rootTitle = mobile ? tabRootTitles[path] : undefined;
  const scrolled = useScrolledPast(56, rootTitle !== undefined);

  // 模式寫在 body 上，Studio 的視覺差異（深色分頁列、Studio 標記）全由 CSS 處理。
  useEffect(() => {
    rememberMode(mode);
    document.body.classList.toggle('studio-mode', mode === 'studio');
  }, [mode]);

  return (
    <>
      {rootTitle !== undefined ? (
        <header className="app-nav-bar" data-scrolled={scrolled ? 'true' : 'false'}>
          {mode === 'studio' && <span className="app-mode-label">Studio</span>}
          <span className="app-nav-bar-title" aria-hidden={!scrolled}>{rootTitle}</span>
          <div className="app-nav-bar-actions">
            <ModeSwitch mode={mode} />
            <WalletMenu iconOnly />
          </div>
        </header>
      ) : (
        <header className="masthead app-masthead">
          <div className="wrap">
            <a className="brand" href="/" aria-label="CRE8 home">
              <C8Logo />
            </a>
            {mode === 'studio' && <span className="app-mode-label">Studio</span>}

            <nav className="nav" aria-label="Main navigation">
              {destinations[mode].map((destination) => (
                <NavLink key={destination.to} to={destination.to} end={destination.exact}
                  className={() => (isActive(destination, path) || (destination.to === '/vaults' && path === '/') ? 'active' : '')}>
                  {destination.label}
                </NavLink>
              ))}
            </nav>

            <div className="head-right">
              <ModeSwitch mode={mode} />
              <WalletMenu iconOnly={mobile} />
            </div>
          </div>
        </header>
      )}
      <nav className="app-mobile-nav" aria-label="Main navigation" data-count={destinations[mode].length}>
        {destinations[mode].map((destination) => {
          const active = (destination.to === '/vaults' && path === '/') || isActive(destination, path);
          return (
            <Link key={destination.to} to={destination.to} aria-current={active ? 'page' : undefined}>
              <AppIcon name={destination.icon} active={active} size={23} />
              <span>{destination.short ?? destination.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
