/**
 * 哪些基金真的開放存入／提領。
 *
 * Community 策略（`/funds/strategy/:id`，真的上鏈的 ATP 策略）不受這份清單限制，照常可以存入。
 *
 * Demo 期間其餘基金（範例基金）都是 whitelist-only：使用者可以完整操作到送出（輸入金額、手機的確認步驟），
 * 按下送出時才告訴他「這檔只開放給 whitelist 錢包」。這一步**不簽名、不送交易、不呼叫後端**，
 * 所以不會有人在 demo 時誤把真錢送進主網。
 *
 * 開放的基金用建置期變數設定（逗號分隔的 slug），與 VITE_CHAIN_ID 一樣放在 `.env.production`，
 * 建置設定只有一個來源。預設為空 = 全部都是 whitelist-only。
 */
const configured = (import.meta.env.VITE_LIVE_FUNDS ?? '')
  .split(',')
  .map((slug) => slug.trim())
  .filter(Boolean);

const LIVE_FUNDS = new Set(configured);

export function isLiveFund(slug: string | undefined): boolean {
  return slug !== undefined && LIVE_FUNDS.has(slug);
}

export const WHITELIST_COPY = {
  title: 'This fund is for whitelisted wallets only',
  deposit: 'Deposits are open to whitelisted wallets during the beta. Nothing was sent and your wallet was not charged.',
  withdraw: 'Withdrawals are open to whitelisted wallets during the beta. Nothing was sent from your wallet.',
} as const;
