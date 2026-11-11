import { QueryClient } from '@tanstack/react-query';

/**
 * Server state 一律交給 react-query。
 *
 * 兩個刻意設定：
 * - `retry: 1`：`GET /portfolios/:id/status` 會掃日誌＋讀池＋定價（實測 2–3 秒），失敗時重試一次
 *   就夠；重試太多次只會讓「後端掛了」變成「轉圈轉很久」。
 * - `refetchOnWindowFocus: false`：這個 app 的資料會動錢，切回視窗就自動重抓容易讓人以為
 *   「剛剛那筆沒生效」。要更新就明說（重新載入按鈕）。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

export const queryKeys = {
  portfolios: (token: string | null) => ['portfolios', token ?? 'anonymous'] as const,
  status: (token: string | null, id: number) => ['portfolio-status', token ?? 'anonymous', id] as const,
  plan: (token: string | null, id: number) => ['rebalance-plan', token ?? 'anonymous', id] as const,
};
