import {lazy,Suspense,useEffect,useSyncExternalStore} from 'react';
import {refreshReferenceData,subscribeReference,referenceRevision} from './lib/reference-refresh';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';

/** /strategies/:id → /funds/strategy/:id 的重導向（保留 id，交給 FundPage 的 id 模式）。 */
function StrategyRedirect(): ReactNode {
  const { id } = useParams<{ id: string }>();
  return <Navigate replace to={`/funds/strategy/${id ?? ''}`} />;
}
import { Toaster } from './components/Toast';
import { TopBar } from './components/TopBar';
import { useAutoConnect } from './lib/use-auto-connect';
import { useAccountWatch } from './lib/use-account-watch';
import { FundPage } from './features/fund/FundPage';
import { OperatorPage } from './features/operator/OperatorPage';
import { PortfoliosPage } from './features/portfolios/PortfoliosPage';
const DesignFundPage=lazy(()=>import('./features/create/DesignFundPage').then(module=>({default:module.DesignFundPage})));
const ActivateFundPage=lazy(()=>import('./features/create/CreateFundPage').then(module=>({default:module.ActivateFundPage})));
import {CreatorPage} from './features/reference/CreatorPage';
import { Leaderboard } from './features/reference/Leaderboard';
const AssetPage=lazy(()=>import('./features/reference/AssetPage').then(module=>({default:module.AssetPage})));
import { VaultsPage } from './features/vaults/VaultsPage';
import { StudioEarningsPage, StudioFundsPage, StudioTodayPage } from './features/studio/StudioPages';
import { MODE_HOME, lastMode } from './lib/app-mode';

export function App(): ReactNode {
  useSyncExternalStore(subscribeReference,referenceRevision,referenceRevision);
  useEffect(()=>{void refreshReferenceData();},[]);
  // 重新整理後自動接回先前授權過的錢包（`eth_accounts` 不彈窗）。
  useAutoConnect();
  useAccountWatch();
  return (
    <>
      <Toaster />
      <TopBar />
      <Suspense fallback={<main className="page"><p role="status">Loading page…</p></main>}>
      <Routes>
        {/* 登入改由標頭的錢包選單處理；舊連結仍然可用，只是把使用者帶回目錄。 */}
        <Route path="/login" element={<Navigate to="/vaults" replace />} />
        <Route path="/" element={<VaultsPage />} />
        {/* 從主畫面打開 App 時回到上次用的模式（manifest 的 start_url）。 */}
        <Route path="/start" element={<Navigate to={MODE_HOME[lastMode()]} replace />} />
        <Route path="/vaults" element={<VaultsPage />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/creator/:id" element={<CreatorPage />} />
        <Route path="/portfolio" element={<PortfoliosPage />} />
        {/* `/create` 是**真的**建立基金（createStrategy → publishVersion → enroll → approve，
            每一步都簽名送交易）。設計稿的 builder 只能匯出設計（Download design），
            它退到 `/create/design`，並可把配置帶進 activate。 */}
        <Route path="/create" element={<ActivateFundPage />} />
        <Route path="/create/activate" element={<ActivateFundPage />} />
        <Route path="/create/design" element={<DesignFundPage />} />
        <Route path="/studio" element={<StudioTodayPage />} />
        <Route path="/studio/funds" element={<StudioFundsPage />} />
        <Route path="/studio/earnings" element={<StudioEarningsPage />} />
        {/* 內部營運後台：不在任何導覽裡，保留網址給營運團隊。 */}
        <Route path="/operator" element={<OperatorPage />} />
        <Route path="/rebalance" element={<Navigate to="/operator" replace />} />
        {/* Community 策略的詳情頁：與 /funds/:slug 同一套版面（含下單 ticket）。
            /strategies/:id 重導向到這裡，FundPage 用 strategyId 進入 id 模式。 */}
        <Route path="/strategies/:id" element={<StrategyRedirect />} />
        <Route path="/funds/strategy/:id" element={<FundPage />} />
        <Route path="/funds/:slug" element={<FundPage />} />
        <Route path="/vault/:slug" element={<FundPage />} />
        <Route path="/asset/:slug" element={<AssetPage />} />
        <Route path="/assets/:slug" element={<AssetPage />} />
        <Route path="/portfolios" element={<PortfoliosPage />} />
        <Route path="*" element={<Navigate to="/vaults" replace />} />
      </Routes>
      </Suspense>
    </>
  );
}
