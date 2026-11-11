# cre8-app 文件

這兩份是**讀程式之前先看**的文件：一份講使用者會走哪些路徑，一份講錢在哪裡、誰能動它。

| 文件 | 內容 | 什麼時候看 |
|---|---|---|
| [`user-flow.md`](./user-flow.md) | 使用者流程圖：登入、建基金、再平衡、續期、失敗時看到什麼 | 想知道「按下去會發生什麼」 |
| [`architecture.md`](./architecture.md) | 合約架構、ERC 標準、帳戶與安全模型、後端架構、DB schema | 想知道「錢在哪裡、誰能動」 |
| [`uiux-handoff.md`](./uiux-handoff.md) | 公開頁／工具頁的樣式邊界與完整 UI 接手規範 | 修改任何 UI 前 |
| [`public-ui-integration.md`](./public-ui-integration.md) | 30 檔來源基金、底層資產、完整設計器與 ATP 啟用界線 | 核對公開資料和真實帳戶如何整合 |

前兩份的流程圖使用 **Mermaid**，GitHub 會直接渲染成圖。

### 改完圖之後怎麼確認它真的渲染得出來

Mermaid 有兩個不容易自己看出來的陷阱（都真的發生過）：

| 寫法 | 為什麼錯 | 修法 |
|---|---|---|
| `G[/portfolios]` | `[/` 是**平行四邊形的起始符**，不是文字 → lexer 找不到結尾就報 `Lexical error` | `G["/portfolios"]` |
| `漂移 < 門檻` | 裸的 `<` 會被當成 HTML 標籤開頭 | 加引號 `{"漂移小於門檻?"}`，或改寫成文字 |

驗證方式（不用裝任何東西）：用 headless Chrome 開一個載入
`https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs` 的頁面，把每個區塊丟給
`await mermaid.parse(code)`，逐一收集成功／失敗。目前 **12 個區塊全部通過**。

⚠ 只看 Markdown 是看不出來的 —— 這兩個錯誤要真的解析才會現形。

## 三句話版本

1. **每個（使用者, 策略）組合得到一個 Kernel v3.3 智慧帳戶（ERC-4337）** —— 錢在帳戶裡，
   策略本身只是 registry 上的資料（**沒有為每個策略部署合約**）。
2. **後端只能提出意圖**：它用一把 session key 送 UserOp，而那把 key 的 CallPolicy
   只允許呼叫 `executeRebalance`；能換哪些幣、最少拿到多少，由 `AtpExecutor` 在鏈上驗。
3. **owner 私鑰是唯一完全控制者**：非託管。使用者只需要簽三種東西 —— SIWE 登入、
   安裝 session key、approve 資產。

## 不在這個 repo 的文件

`pitfalls`（實作踩過的坑）與 `decisions`（決策記錄）目前放在
`cre8-protocol/docs/`，**尚未納入任何 git repo**。上主網前應該一起版控 ——
那些是「為什麼這樣做」的唯一來源。
