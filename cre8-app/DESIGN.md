# CRE8 design system

本專案適用規格取自 CRE8 已核准的 [DESIGN.md](https://github.com/0xJoooe/bnb-agent-vaults/blob/0f3196d37821561050dee1176d9d33e3b51c5d5e/DESIGN.md)。來源 commit：`0f3196d37821561050dee1176d9d33e3b51c5d5e`（2026-11-11 同步）。下列只整理已決定的 App 規則；來源 P3–P6 等待確認提案不當作新規格。

## Typography and colour

- Geist：標題、內文、標籤與按鈕；Geist Mono：數字、代號、地址與期間切換；Anton 只用於 CRE8 字標。
- 按鈕為 sentence case、500 weight、0 letter spacing。一般按鈕 15px；小按鈕與錢包 14px。控制項與標籤至少 12px。
- 使用既有 token：ink `#16222D`、deep `#2B4254`、steel `#4E6A7F`、fog `#6F93AE`、snow `#EEF3F7`、paper `#F7F9FB`、white `#FFFFFF`。
- 次要文字為 steel；slate `#8297A8` 只用於 disabled。正／負／警告使用 positive `#2C7A68`、negative `#A04E58`、caution `#8A5A1F`。
- 頁面預設 paper、panel 白底、1px hair 邊框、無陰影。公開基金列表與詳情沿用已核准白底。

## Controls

| Control | Approved appearance |
| --- | --- |
| Main action | Ink background, snow text, ink border; 46px minimum, 22px horizontal padding; capsule |
| Secondary action | Transparent background, ink text, hair-2 border; hover ink border |
| Small action | 38px minimum, 16px horizontal padding, 14px type; coarse pointer 40px |
| Connect wallet | Shared across pages: 40px height, capsule, 16px horizontal padding, 14px Geist 500; ink/snow |
| Ticket action | 52px; capsule; 15px Geist 500 |
| Mobile fund action bar | 56px actions; existing ticket opens in a modal sheet |
| Segmented control | 32px options in a 3px-padded snow capsule (coarse pointer 36px); 14px horizontal padding; 12px Geist Mono, .04em letter spacing; capsule options; active ink/snow |
| Disabled | Snow background, slate text, hair border; no hover action |
| Focus | 2px fog outline, offset 3px; do not leave a focus ring after pointer-only clicks |

主導覽與桌面分頁標籤選中為平直 2px 底線（沒有外框，不需要形狀）。

## Layout, images and dialogs

- 一般手機 gutter 16px。基金探索白底、淡列線；桌面最多 1344px / 40px gutter，既有基金圖像規則保留。
- 基金縮圖 22% 圓角、桌面封面 12px、手機封面滿版方角。這是圖片例外，不延伸到分段控制與一般按鈕。
- 手機基金詳情主報酬 40px Geist、底部主要操作 56px。
- 抽屜使用現有 Radix Sheet，保留背景鎖定、Escape、focus trap 與關閉後還原焦點。關閉按鈕需有可辨識名稱及可操作範圍。
- 所有寬度不得整頁橫向溢出。驗收 320、360、390、430、768、1024、1440、1920px。
- `prefers-reduced-motion` 關閉非必要動畫與平滑捲動。

## CRE8 integration and data

- Vendor CSS 與 `src/reference/` 的同步來源保留；整合覆蓋放在本專案自己的樣式。Tailwind 不載入 preflight，shadcn token 保留 `sx-` 前綴。
- Native wallet、API、transaction handler、authorization 與 mutation invalidation 不因樣式調整而更動。
- 2026-11-11 使用者要求移除全站 Testnet phase 跑馬燈；保留既有模型／歷史資料性質的標示。
- Leaderboard 一列代表一個 creator，按 creator address 分組；公開人物與 X voices 是參考模型題材，不代表本人建立基金。
- Creator 的模型平均報酬必須明示口徑；不可把模型規模當成真實資金，或把各基金持有人數相加當作去重人數。

## Mobile app experiment

此試作分支在 720px 以下使用固定底部導覽；基金詳情改顯示入金／出金操作列。探索保留原有 URL 篩選，手機將資產、期間和排序放進同一個 Radix 底部抽屜。抽屜預留安全區，並保留 Escape、焦點限制及關閉後焦點還原。

手機基金票先顯示金額、收款帳戶與網路，再交給既有錢包流程。狀態區分已提交與鏈上已確認；入金和後續配置分開說明。Portfolio 用 Holdings / Activity 切換，手機用列表取代橫向表格；讀不到完整估值時，不顯示部分金額作為總值。

此分支的手機版採用 iOS 風格的共用線條圖示、圓角卡片、浮動導覽與分段控制；適用於探索、基金詳情、交易票券及 Portfolio。紙白與藍灰區隔資訊層級，狀態仍同時用文字表示。基金資料、錢包驗證和交易行為沿用既有流程。

手機版使用系統字體、中性分組背景、白色卡片，以及 CRE8 steel／deep 灰藍作為操作色。探索和 Portfolio 直接以頁面標題開始，基金頁只保留返回及分享圖示；入金／提領抽屜由入口決定模式，不重複呈現切換列。行動與桌面皆保留原本的導覽目的地。

## 2026-11-11 版面與 App 殼層調整

- 桌面（≥720px）頁首、Funds、Creators、Portfolio、Manage、Create、基金詳情共用同一條左緣：1344px／40px gutter（720–1023px 為 24px）。規則集中在 `design-controls.css` 末段。
- 基金列表桌面版是封面卡片格（720–1023px 兩欄、1024px 起三欄、1680px 起四欄）：16:10 封面為主角，下方名稱＋機構、報酬＋走勢、資產圖示；整張卡片是連結，人物介紹由滑過名字觸發。分類標籤與 Assets／Advanced／搜尋壓成同一列。手機維持列表。
- 頁標題一律使用 fog 句點（Explore funds. / Creators. / Portfolio. / Manage.），手機隱藏句點。桌面主導覽「Leaderboard」改稱 Creators，與頁標題及手機分頁一致。
- 手機分頁根目錄（Funds、Creators、Create、Portfolio、Manage）不顯示網站 logo 列：頁面 h1 作大標題，右上為玻璃圓鈕錢包。捲過約 56px 後出現 scroll edge 霧化與置中小標題。頁面已有大型連線按鈕時，右上錢包隱藏。
- 手機控制層採 Liquid Glass 語言：分頁列與基金頁 Deposit／Withdraw 為浮動玻璃膠囊（半透明白、模糊＋飽和＋提亮、內緣高光、柔和陰影），選中分頁為膠囊內的淡色膠囊。玻璃只用於浮在內容上的控制層，內容本身不用。瀏覽器無法在 iOS Safari 做真正折射，故不使用 SVG displacement；`prefers-reduced-transparency` 或不支援 `backdrop-filter` 時退回實心白。
- 兩個工作區：投資（Funds · Creators · Portfolio）與 Studio（Today · My funds · Create · Earnings）。模式由網址決定（`/studio`、`/create`、`/strategies` 屬於 Studio），右上角文字按鈕「Studio／Investing」切換，支援時以 View Transition 淡入淡出；localStorage 記住上次模式，manifest 的 `/start` 依此導向。Studio 以頂部「Studio」標記、桌面頁首底部深色線、手機深色玻璃分頁列區分。`/operator` 是 CRE8 內部營運後台，不在任何導覽中。列表與按鈕有按壓回饋，`prefers-reduced-motion` 時關閉。
- 手機 Funds 列表一屏約十檔：列高約 72px、縮圖 44px、名稱最多兩行（有機構名時三行）。分類（All／Themes／Public figures／X voices）捲動時固定在頂部列下方。
- 「人名 · 機構」在手機列表中拆成兩行。
- 支援加到主畫面：`public/manifest.webmanifest`（standalone、start_url `/vaults`）與 `public/app-icons/`。
- Studio 資料：My funds = `GET /strategies` 中 provider 等於目前錢包的策略；狀態取自使用者在該策略的帳戶（`/portfolios/:id/status`）。Today 只列需要處理的項目（無帳戶、權限到期／七天內到期、gas 不足、估值不完整、需要入金、需要再平衡），讀不到的值不當成正常或 0。Earnings 後端尚無資料，顯示說明，不放數字。
- 形狀系統（2026-11-11 使用者決定，取代原本的直角按鈕）：會按的東西一律膠囊（只有圖示時為正圓）；文字框與下拉選單為 12px 圓角矩形；卡片、抽屜、封面沿用各自較大的圓角；圖片縮圖維持既有比例。規則集中在 `mobile-app.css` 的 app-shapes layer 末段。
- 不用外框卡片堆版面：摘要區不加灰底外框與頂部粗線，只用底部細線；清單是連續列表、列間細線；狀態標籤為「色點＋文字」，不用外框等寬字小方塊；不放重複的裝飾圖示。
- 桌面頁首：未連錢包時 Connect wallet 為深色主要按鈕，連上後為淺色帳戶膠囊；Studio／Investing 為次要文字按鈕。桌面主要按鈕一律深色（ink）。
- 基金頁（桌面）：報酬標籤在數字上方（「Model return · 期間」），Max drawdown 與 Share price 並排；交易面板內的輸入區不再是框中框。
- Demo 期間，Community 策略（`/funds/strategy/:id`）與 `VITE_LIVE_FUNDS` 列出的範例基金走真實存入／提領；其餘範例基金可操作到送出，送出時顯示 whitelist 提示，不簽名、不送交易。
- 少讓使用者做決定：同一畫面只放一個 Connect wallet／Create fund；項目少時不顯示搜尋與篩選（Creators 9 位以上才顯示，網址已帶篩選時仍顯示以便清除）；Funds 桌面的篩選收成一顆 Filters（與手機一致），有套用時顯示數量。空狀態在桌面置中。
- 模式切換按鈕寫出動作：投資模式為「＋ Creator Studio」（品牌藍灰淡色底），Studio 內為「← Exit Studio」（中性文字按鈕），並附 title 說明。
- 首頁 `/` 在所有網域都是 landing（`public/landing/`）；帶查詢參數的 `/?…` 仍交給 App，保留 Funds 篩選深連結。App 內左上 logo 回到 landing。
