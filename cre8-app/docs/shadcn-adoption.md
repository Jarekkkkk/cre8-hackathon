# shadcn/ui 導入計畫

## 現況（2026-11）

基礎設施已就位：

| 項目 | 狀態 |
|---|---|
| `tailwindcss@4` + `@tailwindcss/vite` | ✅ |
| `components.json`（style: new-york、cssVariables） | ✅ |
| `@/` 別名（Vite + tsconfig） | ✅ |
| `cn()`（clsx + tailwind-merge） | ✅ `src/lib/utils.ts` |
| `src/components/ui/{sonner,button,badge,sheet,tabs,alert}.tsx` | ✅ CLI 產生 |
| Toast | ✅ **已換成 sonner**（`components/Toast.tsx` 是薄 adapter，11 處呼叫端未改） |

## ⚠ 最重要的決定：**跳過 Tailwind 的 Preflight**

`src/styles/shadcn.css` 只引入 `theme.css` + `utilities.css`，**刻意不引入 preflight**。

原因：這個專案的畫面是靠 `styles/vendor/design.css`（設計稿的逐字複本，4500 行）撐起來的。
Preflight 是全域 reset（margin / font / border / heading 全部歸零），一引入就會把已經對齊好的
版面打掉。實測：導入 Tailwind 後 `/vaults` 的截圖**位元組完全相同**。

代價：裸元素沒有 reset，所以引入 shadcn 元件時要確認它不依賴 preflight 的假設
（shadcn 的元件幾乎都顯式寫了 border/bg，實測 `sonner` / `button` / `badge` 都正常）。

## 分兩區，不要一次全換

這個 repo 的 UI 有兩種性質完全不同的區塊：

| 區域 | 靠什麼 | 方針 |
|---|---|---|
| **公開市集頁**（`/vaults`、`/funds/:slug`、`/portfolios`） | `design.css` + `fund-explore.css`（對齊參考站） | **保留手寫**。這些 class 是設計稿的一部分，換成 shadcn 等於重新設計 |
| **營運/工具頁**（`/operator`、`/create`、抽屜、表單） | 我們自己拼的 | **優先換 shadcn**。這裡的價值是 a11y、focus trap、鍵盤操作，不是像素級還原 |

## 建議的導入順序（依「省下多少手寫程式碼」排序）

| # | 元件 | 取代目前的 | 省下什麼 | 難度 |
|---|---|---|---|---|
| 1 | `sonner` | 手寫 Toast | 堆疊、自動消失、aria-live、動畫 | ✅ 已完成 |
| 2 | ~~`dialog` / `sheet`~~ | ~~`<dialog class="pros-drawer">`~~ | ✅ **已完成**（Fund facts / My position → `Sheet`，拿到 focus trap、背景鎖捲動、aria-modal） | — |
| 3 | ~~`tabs`~~ | ~~Deposit／Withdraw 手寫按鈕~~ | ✅ **已完成**（鍵盤左右鍵、`aria-selected`） | — |
| 4 | `dropdown-menu` | `WalletMenu` 的手寫下拉 | 焦點管理、outside click、鍵盤導航 | 中 |
| 5 | `alert` | `Note` / `ErrorNote`（3 種語氣自己寫） | 一致的語氣與圖示 | **暫緩**：`.note` 是 design.css 的一部分，市集頁也在用；換掉會同時改到兩種區域。等「只換營運頁」時再處理 | — |
| 6 | `select` | 提領時的 `<select>` | 原生 select 在深色底下的樣式問題 | 小 |
| 7 | `checkbox` / `switch` | operator 的「include paused / idle」 | 可存取性 | 極小 |
| 8 | `table` | `/operator` 的 `<table>` | 排序／空狀態的樣式一致 | 小 |
| 9 | `skeleton` | `Spinner` 的載入區塊 | 版面不跳動 | 極小 |
| 10 | `tooltip` | 目前用 `title=` 屬性 | 延遲、定位、觸控裝置 | 小 |

**不要換**：

* `asset-logo` / `Sparkline` / `VaultChart` —— 都是繪圖，shadcn 沒有對應物
* `.fund-row` / `.dk-table` / `.vault-where` 等市集頁結構 —— 設計稿的一部分
* `.ticket` 的 swap 表單 —— 與設計稿的 grid 綁在一起（`grid-area: sub`），換掉要重寫版面

## 一個踩過的坑（值得記住）

手寫 Toast 用 `className="toast"`，與 `design.css` 的 `.toast` **撞名**：那條規則有
`opacity: 0`，於是「元素在 DOM 裡、畫面上完全看不到」。排查花了三輪。

**教訓**：引入任何新元件的 class 前，先 `grep` 設計稿的 CSS。shadcn 的元件用的是
`bg-background`／`text-muted-foreground` 這種語意名稱，撞名機率低，但自訂 wrapper 仍要小心。

## 第二個坑：跳過 preflight 就必須自己寫 `@source`

只引入 `theme.css` + `utilities.css` 時，Tailwind 的**自動來源偵測也不會啟動** ——
`className="h-4 w-4 overflow-y-auto"` 這些工具類別完全不會被生成，症狀是
「元件有渲染、完全沒樣式」（實測：Sheet 的關閉鈕是瀏覽器預設灰框、寬度沒受限）。

`src/styles/shadcn.css` 裡的 `@source "../";` 是**必要配套**，不是可選項。
