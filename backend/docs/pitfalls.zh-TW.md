# 踩過的坑與注意事項

最後更新：2026-11-06

這份文件記錄**已經實際踩過**的坑。每條都附「症狀 → 原因 → 解法/繞法」，因為這些坑的共同特色是**報錯訊息誤導**：你看到的錯誤幾乎都不是真正的原因。

排序原則：越容易再踩、越難診斷的排越前面。

---

## 一、bundler / ERC-4337

### 1.1 alto v1.2.8 的 SafeValidator 對 EntryPoint v0.7 是壞的程式碼 ⚠ 最難診斷

**症狀**
送 UserOp 時收到 HTTP 500：
```
An error occurred while executing user operation: HTTP request failed
```
alto log 只有一行：
```
AbiErrorSignatureNotFoundError: selector 0x99410554 not found on ABI
```

**真正的原因（跟錯誤訊息完全無關）**
`0x99410554` = `DelegateAndRevert(bool,bytes)`。把它解開會發現：
- `success = true`
- `ret` 是一個**完全合法**的 `ValidationResult`（`preOpGas=122717`、`prefund=305088000000000`、`validUntil=0xffffffffffff`）

**UserOp 本身沒有任何錯。** EntryPoint v0.7 的 `delegateAndRevert()` 設計上就是「固定 revert，把 delegatecall 的成功返回值包成 `DelegateAndRevert(true, ret)`」。

真正的 bug 在 alto：`SafeValidator` 拿 `pimlicoSimulationsAbi` 去 `decodeErrorResult`，而那個 ABI **有 0 個 `type:"error"` 條目**（實測 `grep -c 'type:"error"'` = 0）。viem 的 `decodeErrorResult` 只比對 `x.type === 'error'`，所以**任何 data 都必然丟 `AbiErrorSignatureNotFoundError`**。

**這是確定性的**：safe-mode=true 下**任何** UserOp 都會失敗，與 anvil、與 chainId 56 都無關，真實 BSC 上同樣。

**影響範圍**
v1.2.6 / v1.2.7 / v1.2.8 / main 全部有此問題（v1.2.6 重寫這段時引入的回歸）。上游有兩個 open issue 未被修：
- `pimlicolabs/alto#810`（2026-10-28）
- `pimlicolabs/alto#756`（2026-08-30）
- `#761` 那個 PR 只把 500 變成 RpcError，**不修驗證**，且未 merge。

**解法**
**用 alto v1.2.5**。v1.2.5 走完全不同的程式碼路徑（`src/lib/` 而非 `src/esm/`），用 `getSimulateValidationResult()` 做正確的兩段式解密，對 `pimlicoSimulationsAbi` 的引用數 = 0。已實測 v1.2.5 + `safe-mode=true` 可用，且違規 op 確實被擋（見 §1.2）。

**不要**以為「補上 `[...pimlicoSimulationsAbi, ...simulationErrors]` 就會好」——`simulationErrors` 只有 4 條（`Error` / `FailedOp` / `FailedOpWithRevert` / `CallPhaseReverted`），**沒有 `DelegateAndRevert`**。真正的修法是兩段式解密。

**版本差異備忘（v1.2.5 vs v1.2.8）**
| 項目 | v1.2.5 | v1.2.8 |
|---|---|---|
| 入口路徑 | `src/lib/cli/alto.js` | `src/esm/cli/alto.js` |
| `network-name` | 無 | 有 |
| `enable-cors` | 無 | 有 |
| `block-time` | 無 | 有 |
| image created | 2025-05-08 | 2026-08-18 |

把 v1.2.8 的設定檔直接餵 v1.2.5 會帶進無效鍵。

---

### 1.2 驗證 safe-mode 時：HTTP 200 不代表成功

**症狀**：以為 op 被接受了，其實被拒絕。

**原因**：JSON-RPC 的錯誤放在 body 的 `error` 物件裡，HTTP 狀態碼仍是 **200**。

**判斷方法**：看 body 裡**有沒有 `userOpHash`**。沒有就是被拒。
```
{"error":{"message":"AA23 reverted - 0x8baa579f","code":-32500}}   ← 被拒
```
`0x8baa579f` = OpenZeppelin `ECDSA.InvalidSignature()` → 簽章驗證**真的執行過並失敗**，不是靜默略過。

log 裡出現 `module:"validator"` 與 ERC-7562 規則標記（`[OP-012]` 等）才算 safe-mode 真的在做事。

---

### 1.3 alto v1.2.5 **沒有 CORS** —— 瀏覽器永遠無法直連 bundler ⚠ 架構層級的硬限制

**症狀**（瀏覽器裡）：
```
Access to fetch at 'http://127.0.0.1:3001/' from origin 'http://localhost:5173'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header
```

**原因**：alto v1.2.5 **完全沒有 CORS 支援** —— `--help` 沒有相關選項，`OPTIONS` 回 404 且零個 `access-control-*` 標頭。（v1.2.8 有 `enable-cors`，但它對 EP v0.7 的 SafeValidator 是壞的，見 §1.1。）

**這不是 dev 問題，生產環境一樣。** 任何瀏覽器都無法直接送 UserOp 給 alto。

**解法**：後端做 **bundler relay** —— `POST /bundler` 驗 token、查**方法白名單**、原樣轉發到 `BUNDLER_URL`。好處：alto 不必對外、可限流、複用既有認證、白名單擋掉 `debug_*` 這類危險方法。見 [decisions D-22](./decisions.zh-TW.md)。

⚠ 用 Vite dev proxy 只是把問題藏起來，不是解決 —— 真實部署時 proxy 不存在。

### 1.4 alto 的 revert 解析器也是壞的（`failed to parse failedOpError`）

**症狀**：UserOp 被拒，但 alto log 只給：
```
ERROR  failed to parse failedOpError   module: "executor"
error: { issues: [ { code: "invalid_union", unionErrors: [ ... "expected object, received undefined" ] } ] }
WARN   user operation rejected   reason: "INTERNAL FAILURE"
```
真正的失敗原因**完全看不到**。

**原因**：alto 用 Zod 解析 EntryPoint 的 revert。當 revert 的 **data 是空的**（`0x`）時，它沒有任何東西可解 → ZodError → 統稱 `INTERNAL FAILURE`。

**關鍵教訓**：看到 `INTERNAL FAILURE` **不要**以為是 op 有問題。先自己重放那筆 `handleOps`（alto 的 log 裡有完整 payload）拿到真正的 revert data。若拿到 `0x`，往下看 §2.3。

### 1.5 session key 那刀無論如何都需要 bundler

**注意**：受限 key 發出的 UserOp 只能經 EntryPoint + bundler 上鏈。所以「session key」這一步**無法沿用 v1 的 operator 直接發普通交易**架構，架構必然升級。

**未驗證的殘留風險**：只驗了簽章與 gas 兩類違規會被擋，**stake 相關的 ERC-7562 規則未驗**（例如 unstaked entity 存取外部 storage）。若 session key 會用到 validator / paymaster 這類需要 stake 的 entity，該規則的實際行為仍是未知。

---

## 二、anvil fork（本機開發環境）

### 2.1 fork 有約 75 分鐘的保存期限 ⚠ 最容易讓人以為「昨天還能跑」

**症狀**
合約查詢正常，但一查**鏈上不存在的新地址**就爆：
```
failed to get account for 0x...: HTTP error 403 with body:
{"error":{"code":-32602,"message":"Archive requests require a personal token.
  Get one at: https://www.allnodes.com/publicnode"}}
```
暖查詢（本地已快取）完全正常 → 很容易誤判成「限流」或「RPC 掛了」。

**真正的原因**
anvil 是拿**自己啟動當下釘住的塊號**去問上游，不是打 `latest` tag。fork 區塊一旦落後上游太遠，就被歸類成 archive 請求。

**實測窗口**
| 上游 | 歷史窗口 |
|---|---|
| `bsc-rpc.publicnode.com` | **約 75–80 分鐘**（`head−10000` 可，`head−11000` 起 403） |
| `bsc-dataseed.bnbchain.org` | **僅約 43–58 秒**（`head−96` 可，`head−128` 起 missing trie node）→ 不可用 |
| `bsc-mainnet.public.blastapi.io` | 能讀歷史，但 `eth_getLogs` 會 429 |

**解法**
跑 `bash backend/scripts/refresh-anvil.sh`（約 10 秒）。它會 dump → 重啟到最新塊 → loadState → 驗證。**每約 55 分鐘一次。**

**根因層面的建議**：這是「用免費公共 RPC 跑生產級工作流」的本質問題，換有 archive 的 keyed RPC（Alchemy / QuickNode / Infura 的 BSC 端點）才是正解。refresh 腳本只是止痛。

---

### 2.2 「無 fork」版 anvil 會靜默給出錯誤資料 ⚠ 比報錯危險

**症狀**：什麼都不報錯，但 `PancakeSwap Router` 的 `eth_getCode` 回 `0x`。

**原因**：無 fork 的 anvil 沒有上游，任何不在本地 state 的地址都回 `0x`（看起來像「這個地址沒有合約」，而不是「我不知道」）。

**後果**：未來 rebalance 要讀池子 / bStock 時，會拿到空資料而不自知。

**結論**：無 fork 版只能用在「不需要真實鏈狀態」的場景（例如只驗 Kernel 帳戶相關邏輯）。大聲的 403 比靜默的 `0x` 好得多。

---

### 2.3 fork 過期會表現成「UserOp 空白 revert」⚠ 極難歸因

**症狀**：送 UserOp 時 alto 回 `INTERNAL FAILURE`，自己重放 `handleOps` 得到 `execution reverted, data: "0x"`（空白 revert）。**op 本身沒有任何問題。**

**原因**：alto 的模擬要讀 EntryPoint / validator 的 **storage**。fork 的 75 分鐘窗口過期後，anvil 對冷 storage 回 `403 Archive requests`，模擬在中途失敗 → 回空資料。

**怎麼確認**：直接查一個需要 storage 的 view：
```bash
cast call <EntryPoint> "getNonce(address,uint192)(uint256)" <account> <key> --rpc-url http://127.0.0.1:8545
```
若回 `failed to get storage ... HTTP error 403` → 就是這個。跑 `bash backend/scripts/refresh-anvil.sh` 後重試即可。

**為什麼難查**：`403` 在 eRPC 層被 anvil 吞掉，最後表現成一個**毫無資訊的空白 revert**。這條要記住，不然會花很久懷疑 op 或簽章。

### 2.4 不要給 `--fork-block-number`

**症狀**：anvil 起不來。
**原因**：指定舊塊號後，開機抓 dev account 就會 403 退出。
**正確做法**：不給，讓它 fork 在啟動當下的最新塊。

---

### 2.5 `cre8-contracts/scripts/deploy-fork.sh` 會清掉整個 fork ⚠ 絕對不要跑

**原因**：那支腳本每次執行都**起一個全新的 anvil fork**，並覆寫 `deployments/fork.json`。
**後果**：現有 registry 與已部署帳戶會全部消失，DB 的 `strategies.onchain_id` 全部失效。

動它之前先確認你願意重跑整套部署 + DB 遷移。

---

### 2.6 `deployments/fork.json` 會 drift，而且沒人讀它

**曾經的狀態**：`fork.json` 記錄的 registry / executor / oracle 三個地址，在鏈上**全部是 `0x`**（根本沒部署過）。真正在用的是 `broadcast/DeployAtp.s.sol/56/run-latest.json` 那組。

**已修**：現在 `fork.json` 已與鏈上交叉驗證一致，並加了 `_note` 說明產生方式。

**注意**：沒有任何程式碼讀 `fork.json`（只有 `deploy-fork.sh` 的寫入端）。它純粹是人工紀錄，**不是 runtime 設定來源**。真正的設定來源是 backend 的 `REGISTRY_ADDRESS` 環境變數。

---

### 2.7 本機有兩個 backend，只有一個接鏈

- `:8081` → 接鏈（`RPC_URL` + `OPERATOR_PRIVATE_KEY` + `REGISTRY_ADDRESS` 都是啟動時 inline 帶入）
- `:8080` → `rpcConfigured: false`（讀 `backend/.env`，但那個檔沒有 `REGISTRY_ADDRESS`）

驗證前先確認你打的是 8081，否則會以為「後端沒接鏈」。

---

## 三、@zerodev/sdk

### 3.1 `useMetaFactory` 有靜默 fallback，會偷偷換掉帳戶地址 ⚠

**原始碼**（`createKernelAccount.js`）：
```js
if (isAddressEqual(accountAddress, zeroAddress) && useMetaFactory) {
  useMetaFactory = false;   // ← 靜默退回 KernelFactory 路徑
}
```
MetaFactory 模擬不出地址時會自動改走 `KernelFactory.createAccount`。兩條路徑的 CREATE2 輸入不同 → **地址不同**，而且**不會報錯**。

**後果**：同一組 `(owner, strategyId)` 算出第二個地址 → 使用者帳戶分裂。DB 的 `UNIQUE(chain_id, address)` 也擋不住（地址真的不一樣）。

**防護**：`backend/src/kernel.ts` 已加 sentinel —— 若 `factory !== MetaFactory` 就拋錯。`test/kernel.test.ts` 有兩條測試堵它（一條斷言相等/不相等，一條**主動誘發** fallback 後斷言拋錯）。

**遷移時要注意**：`index` 是 `bigint`，內部 `toHex(index, {size:32})`。
- ❌ 傳 `index: "0xa450…d38"` → viem 走 `stringToHex`（UTF-8），長度 66 > 32，`assertSize` 直接爆
- ✅ 傳 `index: BigInt("0xa450…d38")` → 產生完全相同的 32 bytes

### 3.2 不能用 `account.getFactoryArgs()` 取部署參數

**原因**：viem 的 `toSmartAccount` 一旦 `getCode` 有 code（就是冪等重跑那條路徑）就回 `{ factory: undefined }`，會讓冪等路徑炸掉。

**正確做法**：用 `account.factoryAddress` + `await account.generateInitCode()`。

---

## 三之二、`@zerodev/permissions`（session key）

### 3.3 `plugins.regular` 不改變地址，`initConfig` 才改變 ⚠ 最容易搞錯

三個設定對照（同 owner、同 index，實測）：

| 設定 | 算出的地址 |
|---|---|
| 只有 `sudo` | `0xCF0c37F1…704D02`（baseline） |
| `sudo` + `plugins.regular`（不給 `initConfig`） | **同上，不變** |
| `sudo` + `initConfig`（不給 `regular`） | `0x0Efb1a5e…1122A`（**變了**） |

- `plugins.regular` 決定「**誰簽**」→ 不影響地址
- `initConfig` 決定「**權限有沒有被安裝**」→ 唯一影響地址的東西

**production 兩者必須同時給**。只給 `regular` 會得到「一個沒安裝權限的帳戶，但用 session key 簽會失敗」——而且**不會有任何錯誤提示**，直到你真的發 op。

**副作用**：既有帳戶不能靠重算參數換到新地址。要加裝權限只能在原地址用 UserOp 自己執行那 2 筆 initConfig calldata，而那需要使用者簽名（我們沒有，見 decisions D-13）。

### 3.4 GasPolicy 是「一次性 wei 預算」，用完權限永久失效

**症狀**：session key 用了一段時間後突然全部 op 失敗，錯誤 `PolicyFailed(1)`，但帳戶有錢、簽章也對。

**原因**：`toGasPolicy({ allowed })` 的 `allowed` 是 **uint128、單位 wei、跨 op 累計、永不重置**。

實測：`allowed = 4e14` → 第 1 筆過（用掉約 2.46e14）、**第 2 筆立刻 `PolicyFailed(1)`**。`allowed = 1e6` → 連第一筆都不過（證明單位是 wei 不是 gas 計數）。

**注意它不是 gas 次數上限也不是單筆上限**，是「這個 session key 一生的 gas 預算」。

我們設 `1e18 wei`（BSC 約 1 gwei、單筆 ~250k gas → 約 4000 筆）。

**這是第二個倒數計時器**，與 `TimestampPolicy` 的到期並列。兩者任一觸發，該 portfolio 就失去執行能力。

### 3.5 CallPolicy 只驗 target + selector，**不驗參數**

**症狀**：op 回 `success: true`，但實際上沒有換任何幣。

**原因**：CallPolicy 的白名單是 `(target, selector)` 二元組。參數內容它完全不看。所以空 `steps` 的 `executeRebalance` 也會成功。

**含意**：**「op 成功」≠「真的完成了再平衡」**。金額層面的正確性只能靠 `AtpExecutor` 的 `minGross` 守。任何「看 UserOp success 就當作再平衡完成」的邏輯都是錯的。

### 3.6 越權是在「驗證期」被擋，不是執行期

實測越權呼叫 `AtpRegistry.setDefaultFeeBps`（不在白名單內）：
```
alto（safe-mode）→ eth_estimateUserOperationGas 階段就回 AA23 reverted 0x1c49f4d1
                    → 沒有上鏈、沒有浪費 gas
eth_call handleOps → 鏈上也會擋：FailedOpWithRevert(0x65c8fd4d) 內層 0x1c49f4d1
0x1c49f4d1        = CallPolicy 的 InvalidCallData()
debug_traceCall   → 最深 revert frame 是 CallPolicy v0.0.4
```

**好消息**：alto 的 safe-mode 是「多一層縱深」，**不是唯一安全邊界**。任何守規矩的 bundler 都會在模擬階段拒收，我方不必付 gas。

### 3.7 `permissionId` 只有 4 bytes，不能當唯一鍵

公式：`keccak256(abi.encode([toPolicyId(policies), flag, toSignerId(signer)]))[0..4]`

- 純 keccak、**不含 chainId、不含帳戶地址** → 可離線算、可存 DB
- 但**只有 4 bytes**。要當參照必須搭配 `(account, sessionKey)` 一起存，不可單獨當 key
- ⚠ **它會隨 `validUntil` 改變**。因為 timestamp policy 的 `getPolicyData()` 含 `validUntil`，而 `validUntil` 預設是「現在 + 365 天」。所以**每次 enroll 算出的 permissionId 都不同**，重算比對時必須用 DB 快照裡的值，不要用「現在」重算
- 也對 policy **陣列順序**敏感

### 3.8 `permissionConfig(permissionId).signer` 回的是**簽章器合約**，不是 session key 的 EOA ⚠ 很容易寫錯驗證

**症狀**：你寫了一個驗證「鏈上的 signer 等於我們的 session key」，它永遠 FAIL，而且兩邊都是合法的地址，看起來像實作壞了。

**原因**：`permissionConfig(bytes4)` 回 `(permissionFlag, signer, policyData)`，其中 `signer` 是 **`ECDSA_SIGNER_CONTRACT`**（`0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF`）—— 那個負責驗章的合約。**它對世界上每一把 session key 都相同**，所以它不綁定任何東西。

session key 的 EOA 只存在於 `signer.getSignerData()`，被 `toSignerId(signer) = concat([signerContractAddress, getSignerData()])` 哈希進 `permissionId`。

SDK 自己也是這樣判斷的（`@zerodev/permissions/toPermissionValidator.ts:110`，`isEnabled()` 比的是 `permissionConfig.signer === signer.signerContractAddress`）。

**正確的綁定證明**（三者缺一不可）：
1. 用 DB 快照（含 `sessionKeyAddress`、三層 policy、`validUntil`）**重建** permission validator → 取 `getIdentifier()`
2. 斷言 `重建的 permissionId == DB 存的 permissionId`
3. 斷言鏈上 `permissionConfig(重建的 permissionId)` 存在（`signer != address(0)`）
4. **外加負向控制**：把 permissionId 改一個 byte 再查，必須是空的（否則「查得到」這個斷言可能因為位址碰撞或讀錯而假通過）

再加上「用快照重建的 `initConfig` 算出的地址 == 實際部署地址」、「不帶 `initConfig` 算出的地址 != 實際地址」，才是完整證明。

### 3.9 `@zerodev/permissions/constants` 不是合法的 subpath export ⚠ typecheck 會過、runtime 會炸

**症狀**：`bun run typecheck` 乾淨，但執行時 `Cannot find module '@zerodev/permissions/constants'`。

**原因**：該套件的 `exports` 只開放 `.`、`./policies`、`./signers`。`constants` 在 TypeScript 的型別解析下看得到，但 runtime 沒有這個 subpath。

**做法**：從根 `@zerodev/permissions` import（它 `export *` 了常數）。

**這是「tsconfig 覆蓋不到的地方」的又一例** —— 見 §5.2。

### 3.10 UserOp 的 gas 由 `sender`（smart account）付，不是簽名者付 ⚠ 很容易搞錯誰該出錢

**症狀**：以為「operator 簽 op 所以 operator 付 gas」，但實際上 operator 錢包沒動，反而是 smart account 的餘額被扣；或是帳戶沒錢時 op 莫名送不出去。

**原因**：ERC-4337 的 UserOp **gas 由 `sender` 預付**。session key 只是「有權限指揮這個帳戶」，它不持有資產。

**沒 BNB 的帳戶會得到什麼錯誤**（對使用者毫無意義）：
```
AA21 didn't pay prefund
Smart Account does not have sufficient funds
```

**實測成本**：gasUsed ≈ 250,000、BSC 有效 gas price ≈ 1.22 gwei → **一次 op ≈ 0.0003 BNB**。

**正確的心智模型**（兩筆 gas，付的人不同）：

| 階段 | 誰發 | 誰付 |
|---|---|---|
| 建帳戶 + `enroll` | operator 的普通交易 | **operator** |
| 執行再平衡 | session key 簽的 UserOp | **使用者的 smart account** |

**與 GasPolicy 的陷阱**：GasPolicy 預算是 `1e18` wei（= 1 BNB 的 gas）且永不重置。所以**帳戶存超過 1 BNB 的部分是浪費** —— 會先被 GasPolicy 擋。兩者要一起算。

---

## 三之三、地址格式

### 3.11 混合大小寫但 EIP-55 不正確的地址會被 viem 直接 throw ⚠

**症狀**：`InvalidAddressError` 或類似的 checksum 錯誤，但地址「看起來是對的」。

**原因**：viem 對**混合大小寫**的地址會做 EIP-55 校驗，不符就 throw。全小寫是合法的（視為「無 checksum」），混合大小寫錯一字就爆。

**實際踩到**：本專案的 `AtpExecutor` 地址有多個版本在流傳：
```
❌ 0x60691760815c69D32C1f68146Fa11669F62a4b38   ← 曾出現在 docs 與 fork.json
✅ 0x60691760815C69d32c1f68146FA11669F62A4b38
```
`AtpOracle` 也有同樣問題：
```
❌ 0x3d79c9bE8c087097cbB1a8be0D2714CF8BA95B84
✅ 0x3D79c9BE8c087097Cbb1A8Be0D2714cf8BA95B84
```

**防護**：寫進任何檔案前先驗證：
```bash
cast to-check-sum-address <addr>   # 輸出必須等於輸入
```
或批次掃描（只標混合大小寫且不合法的，避免全小寫的誤報）：
```bash
grep -roh "0x[0-9a-fA-F]\{40\}" <dir> | sort -u | while read -r a; do
  b=${a#0x}
  if echo "$b" | grep -q '[A-F]' && echo "$b" | grep -q '[a-f]'; then
    [ "$a" != "$(cast to-check-sum-address "$a")" ] && echo "DANGER: $a"
  fi
done
```

**教訓**：地址的「值」對不代表「表示法」對。這種錯在 cast/call 時不一定炸，但 viem 會在 production 炸。

---

## 四、Kernel / 合約語意

### 4.1 Kernel v3.3 帳戶沒有 `owner()` view

**症狀**：`cast call <account> "owner()(address)"` → `InvalidSelector`（`0x7352d91c`）。`getOwner()` 也一樣。

**正確的權威讀法**（兩者搭配）：
```bash
# 帳戶的 root validator
cast call <account> "rootValidator()(bytes21)"       # => 0x01 ++ ecdsaValidator
# 該帳戶的 owner（存在 validator 合約的 storage 裡，不是帳戶本身）
cast call 0x845ADb2C711129d4f3966735eD98a9F09fC4cE57 \
  "ecdsaValidatorStorage(address)(address)" <account>
```
注意 `ecdsaValidatorStorage` 是**對 validator 合約**呼叫，不是對帳戶。對帳戶呼叫會 `InvalidSelector`。

**旁證**：counterfactual 地址本身就是 owner 的密碼學證明 —— 地址是 `f(initData 含 owner, salt)`，部署出來的碼落在預測地址，就證明 initData 裡的 owner 正確。

### 4.2 `AtpRegistry._enrollments` 是「一帳戶一筆註冊」，整筆覆寫

```solidity
_enrollments[account] = Enrollment({ strategyId: id, version: version, paused: false });
```
以 **account 為 key 整筆覆寫**。所以：
- 同一個 smart account 只能承載**一個**策略的註冊
- 若 salt 只由 owner 派生，同一 owner 的第二個策略會**靜默覆寫**第一個，而 DB 會有兩行 portfolio → 鏈上與 DB 永久不一致

**因此 salt 必須含 `strategyId`**：
```
keccak256(abi.encodePacked("cre8-atp:kernel-v3.3", owner, strategyId))
```
這實現的是「每人**每策略**一個帳戶」，不是字面上的「每人一個」。若未來產品要「每人全站一個帳戶」，**必須先改 Registry 的資料結構**。

### 4.3 enroll 的權限是 `msg.sender == account || msg.sender == owner`

`AtpRegistry.sol:177`。**owner 可以代為 enroll**，所以「operator 幫使用者的 smart account 註冊」不需要任何合約修改。這是本刀零合約改動的基礎。

但也意味著：`enroll` **不驗** provider 與 msg.sender 的關係、不驗 `isPublic`、**無簽章驗證**（合約註解已標 TODO 要換成 two-phase signed intent）。

### 4.4 MetaFactory 面對已存在的 CREATE2 目標**不會** revert（曾誤判為 bug）

一次 code review 從上游原始碼推論出：`SenderCreator` 會吞掉 factory revert → 回 `address(0)` → `getCode(0x0)` 守衛失效 → 冪等自癒不成立。推論鏈看起來完整，**但實測推翻**：
```
cast call 0x0000000071727De22E5E9d8BAf0edAc6f37da032 "getSenderAddress(bytes)" <已部署的 initData>
=> Error: execution reverted: SenderAddressResult(0x...正确地址)
```
Kernel MetaFactory 面對已存在目標不會 revert，所以 `getSenderAddress` 照樣回得出正確地址，`getCode` 守衛可達，冪等自癒成立。

**教訓**：讀上游原始碼可以產生假設，但涉及鏈上行為的結論必須實測。

### 4.5 `smart_accounts.address` 有 lowercase CHECK

```sql
constraint smart_accounts_address_lowercase_hex check (address ~ '^0x[0-9a-f]{40}$')
```
`computeCounterfactualAddress` 回的是 checksum 大小寫混合。**寫進 DB 前一定要 `.toLowerCase()`**，否則違反約束。

另外 `UNIQUE(chain_id, address)` 是大小寫敏感的。

### 4.6 counterfactual 地址依賴 `initConfig`，而 `initConfig` 含**時間** ⚠ 會產生不可回收的孤兒帳戶

**症狀**：同一個 `(owner, strategyId)` 在不同時間 enroll，得到**兩個不同的 smart account 地址**。鏈上留下一個孤兒帳戶（帶完整權限安裝與 registry 註冊），DB 完全不知道它存在。

**原因**：地址是 `f(initConfig, salt)`，而 `initConfig` 裡含 timestamp policy 的 `validUntil`。`validUntil` 預設是 `now + 365 天` —— **同一個帳戶在兩秒後重算就是另一個地址**。

實測（只改 `validUntil`，其他全同）：
```
validUntil = 1825508606 → 0x2b082FAd…d042   ← 與 DB 相符
validUntil = 1825512206 → 0x2017888D…f325   ← 只差 3600 秒
```

**失效模式**：
```
enroll → validUntil = now+365d → 地址 A → 部署 A → enroll A → DB 寫入被殺
重試   → validUntil = now'+365d → 地址 B → 部署 B → enroll B → DB 寫 B
```
→ 孤兒帳戶 A 留在鏈上，**無法回收**（我們沒有使用者的 sudo key 去撤銷它）。

**解法（已實作）**：在**任何鏈上動作之前**把 `validUntil` 寫進 `enrollment_intents` 表（key = `user_id + strategy_id + chain_id`），重試時讀回同一個值。見 [decisions D-21](./decisions.zh-TW.md)。

**教訓**：任何「進 initConfig 的東西」都必須是**可重建的**，否則地址就不可重建。時間不是。

### 4.7 要算「已部署帳戶」的地址，必須**帶**部署當時的 initConfig ⚠ 反直覺

這條很容易搞錯方向，兩個方向都試過：

| 情況 | 要帶 initConfig 嗎 | 算出的地址 |
|---|---|---|
| 部署**有**安裝權限的帳戶（現在的做法） | **帶**（且必須是當初那一組） | `0x2b082FAd…d042` ✅ |
| 同一個 (owner, salt) 但**不帶** | 不帶 | `0xd8eaBBD5…eDE3` ❌ 另一個未部署地址 |
| 部署**沒有**權限的早期帳戶 | 不帶 | `0xCF0c37F1…D02` ✅ |

`initConfig` 參與 CREATE2 的 init code，所以它在不在，就是兩個不同的地址。

**實務做法**：**不要重新推導地址**。DB 的 `smart_accounts.address` 是權威值 —— SDK 的 `createKernelAccount({ address })` 可以直接吃它並短路推導。地址在 DB 裡不是方便欄位，是**必要欄位**（因為它無法在不知道當初 `validUntil` 的情況下重建）。

### 4.8 `swapFeeBps()` getter 不存在

實際的 getter 是 `defaultSwapFeeBps()` 與 `effectiveFeeBps(uint256)`。呼叫 `swapFeeBps()` 會 revert。backend 目前沒用到，但之後要顯示費率時會踩。

---

## 五、backend

### 5.1 冪等查詢若用 `order by p.id limit 1`，legacy 列會擋住新列 ⚠ 確定性必爆

**症狀**：遷移後的使用者**第二次** re-enroll 回 HTTP 500。

**原因**：同一個 `(user, strategy)` 同時有 legacy `account_type='EOA'` 列（id 較小）與 `KERNEL` 列（id 較大）時，`order by p.id limit 1` **必選到 EOA 列** → JS 端不短路 → 重跑整條 enroll 路徑 → `INSERT smart_accounts` 撞 `UNIQUE(chain_id, address)` → 23505。

**解法**：WHERE 加 `and s.account_type = 'KERNEL'`（已修）。語意必須是：
- 有 KERNEL 列 → 命中短路（不論有沒有 legacy 列、不論 id 大小）
- 只有 legacy EOA 列 → **不命中**，走新流程（這是刻意的，legacy 列保留）
- 都沒有 → 不命中

### 5.2 `scripts/` 不在 typecheck 範圍

`tsconfig.json` 的 include 是 `["src/**/*.ts"]`、`tsconfig.test.json` 是 `["src/**/*.ts","test/**/*.ts"]`。

**後果**：一支 import 了已移除函式的腳本可以一路通過 `bun run typecheck`。`scripts/gen-kernel-golden.ts` 就是這樣壞掉的（SDK 遷移移除 `buildDeployFactoryData` 後它變成 TypeError，但 typecheck 從未察覺）。

**未修**：這是設定上的盲區，尚未處置。

### 5.3 EnrollDeps / ChainConfig 的 DI 縫可用於注入

`enrollPortfolio(strategyId, wallet, deps?: Partial<EnrollDeps>)` 與 `deploySmartAccount(owner, strategyId, chain?: ChainConfig)` 是最後兩個可選參數，用於單元測試注入替身。生產路徑不傳，走預設。

### 5.4 `getChain()` 是 cached 且不可注入

`chain.ts:92`。只有 `resetChain()` 清快取。所有鏈上函式內部自己呼叫 `getChain()`，無法從外部換掉 client。要測試只能靠 env + `resetChain()`，或走 §5.3 的 DI 縫。

**另外**：`getChain()` 現在會對 `chainId ∉ {56, 31337}` 直接 throw（因為要解析 Kernel 地址）。這連 `registerStrategy` / `publishVersion` 這些非 Kernel 操作也一起被限住 —— 屬範圍決策，但這是行為變更。

---

## 六、工具與環境

### 6.1 沙箱裡 `ps` 不可用

```
bash: /bin/ps: Operation not permitted
```
查進程用 `pgrep -fl` 或 `pgrep -f 'pattern'`。

### 6.2 macOS 內建 bash 是 3.2

- **不支援** `${var,,}` / `${var^^}` → 用 `tr '[:upper:]' '[:lower:]'`
- **變數緊接全形標點會吃字**：`$NEW_PID，` 會把 UTF-8 位元組當成變數名的一部分 → `unbound variable`

`refresh-anvil.sh` 第一版就因此失敗過一次，中途留下一個「活著但 9 個合約全 `0x`」的 anvil。現在已加 `trap on_exit EXIT` 安全網。

### 6.3 `docker pull ghcr.io/pimlicolabs/alto` 會被拒

```
denied: denied
```
即使換乾淨的 `DOCKER_CONFIG` 也一樣。但匿名 curl 對 GHCR manifest 是通的 → 這是 docker daemon 端問題。

**繞法**：`spike/alto/fetch-image.py` 抓匿名 token → OCI index → 對應 arch 的 manifest → blobs → 自組 docker-archive → `docker load`。它支援 `ALTO_TAG` 環境變數。

### 6.4 alto 日誌會印出整個合約 bytecode

grep 前務必過濾長 hex（`grep -v -E '0x[0-9a-f]{100,}'`），否則 context 會被吃光。

### 6.5 `cre8-protocol/` 本身不是 git repo

三個子目錄各自是獨立 repo（`cre8-contracts/`、`backend/`、`db/`）。在 `cre8-protocol/` 下跑 `git status` 會 `fatal: not a git repository`。

驗證「有沒有改到不該改的檔案」不能用 git，要用 mtime 比對。

---

## 七、前端 / 瀏覽器錢包

### 7.1 裝了多個錢包時，`window.ethereum` 會是**錯的那個**

**症狀**：點「連線瀏覽器錢包」，跳出來的是 Phantom，不是 MetaMask。

**原因**：`window.ethereum` 是單一屬性，多個錢包都往它寫，**最後注入的那個贏**。這不是誰的 bug，是整個生態十幾年的老問題。

**正確解法：EIP-6963（Multi Injected Provider Discovery）**

錢包主動廣播自己，dApp 收集後讓使用者選：
```ts
window.addEventListener('eip6963:announceProvider', (e) => {
  const { info, provider } = e.detail;   // info = { uuid, name, icon, rdns }
  // 以 info.rdns 去重（同一錢包會廣播多次）
});
window.dispatchEvent(new Event('eip6963:requestProvider'));   // 叫已載入的錢包回應
```
MetaMask（v11+）、Phantom、SafePal 都支援。實測一次偵測到 3 個並正確列出。

**順帶的好處**：連線後可以顯示錢包名稱（`0x90F7… (MetaMask)`）。只顯示地址的話，你不會知道那是哪個錢包給的 —— 除錯時很致命。

⚠ `info.icon` 是 data URI 且要直接塞進 `<img src>`，**必須檢查 `startsWith('data:image/')`**，否則等於開了注入面。

### 7.2 別把 `window.ethereum` 當連線入口，它只能是 fallback

即使做了 EIP-6963，仍要保留 `window.ethereum` 當「一個錢包都沒廣播」時的保底 —— 但要**明確標示風險**（你不知道那是哪個錢包）。把它的存在本身當成陷阱來對待：命名成 `fallbackInjectedProvider()`，加註解說它不是連線入口。

### 7.3 Phantom 會**拒簽** chainId 不符的 SIWE 訊息（MetaMask 不會）

**症狀**：用 Phantom 連線後，SIWE 簽名直接失敗：
```
InvalidInputRpcError: Missing or invalid parameters.
Details: The app's signature request cannot be shown as the chain ID does not
         match the provided chain ID for verification.
```

**原因**：Phantom 的錢包在 chainId 1（Ethereum），而 SIWE 訊息寫的是 chainId 56（BSC）。**Phantom 的政策是拒絕顯示「訊息宣告的鏈 ≠ 錢包當前鏈」的簽名請求。MetaMask 不會擋。**

⚠ **所以「`personal_sign` 不受 chainId 影響」這個常見說法只在 MetaMask 成立。** 我們的 app 當時還印了一行「personal_sign 不受 chain 影響」的提示 —— 那句話對 Phantom 是錯的。

**這不是我們的 bug**（Phantom 對這個 BSC 產品也不是目標錢包），但它揭示一個真實的 UX 缺口：

**正確做法**：連線後先比對 `wallet.eth_chainId` 與預期的 chainId，不符就**在簽名前**提示使用者切換網路（`wallet_switchEthereumChain`），而不是讓他在簽名那一刻吃到一個看不懂的錯誤。

---

### 7.4 `EntryPoint.getNonce` 的 key 是 24 bytes 且**省略前導零** ⚠ 我因此誤判兩次

**症狀**：查 `getNonce(account, key)` 一直回 0，但 op 明明用過非 0 的 nonce，於是以為 nonce 機制壞了。

**原因有兩層**：

1. **hex 表示會省略前導零**。日誌印出的是
   ```
   0x845adb2c711129d4f3966735ed98a9f09fc4ce5700000000000000000005
   ```
   只有 60 個 hex 字元，但它是 uint256，補齊到 64 後是
   ```
   0000 845adb2c711129d4f3966735ed98a9f09fc4ce57 0000 0000000000000005
   └── key（24 bytes，48 hex）──────────────────┘ └── seq（8 bytes）──┘
   ```
2. **key 的組成是 `0x0000 ++ validatorAddress ++ 0x0000`**，不是「validatorAddress 補零」。這兩者不同，用錯就一定查到 0（那是一個從未被使用的 key）。

**正確查法**（別靠肉眼對齊，直接從 nonce 值反推 key）：
```ts
const usedNonce = 9134799…935449093n;      // 從日誌的十進位值
const key = usedNonce >> 64n;              // 高 192 bits 就是 key
const n = await publicClient.readContract({ …, functionName: 'getNonce', args: [account, key] });
console.log(n & 0xFFFFFFFFFFFFFFFFn);      // 低 64 bits 才是 sequence
```

**教訓**：`getNonce` 回 `key << 64 | seq` 的**打包值**，不是單純的 sequence。任何「直接拿回傳值當次數」的判斷都會錯得離譜。

---

### 7.5 Kernel 的 `personal_sign` 是用真錢包驗過的（不需要 EIP-712）⚠ 這條解掉了一個架構風險

曾經擔心：`ECDSAValidator` 若只接受裸 hash 的 ECDSA recover，瀏覽器錢包就得用 `eth_sign`（多數錢包拒絕），那就得改用 EIP-712。

**實測結果**：不需要。`ECDSAValidator` 是**雙模式**（先試裸 hash，失敗再試 EIP-191），而 ZeroDev SDK 走的是 `personal_sign`。**真 MetaMask 對 32-byte UserOp hash 的 `personal_sign` 成功簽出並上鏈**，而且本地算的 `userOpHash` 與 bundler 回的一致。

⚠ 但使用者體驗上要注意：MetaMask 會把那個 32-byte hash 顯示成**一串不可讀的 hex**。硬體錢包（Ledger）預設拒絕簽盲 hash —— 純軟體錢包沒問題。

---

### 7.6 `vite build --mode development` **不會**讓 `import.meta.env.DEV` 變 true ⚠ 我誤判過

**常見但錯誤的認知**（我原本也這樣以為）：用 `--mode development` 打包，`import.meta.env.DEV` 就會是 `true`，於是「dev-only 的程式碼」會進產物。

**實測結果（Vite 7.3.7）**：`bun run build -- --mode development` 的產物**與 production 同 hash、同大小**，dev-only 的 chunk 完全沒產生。

**原因**：`import.meta.env.DEV = !isProduction`，而 `isProduction` 取自 **`NODE_ENV`**，不是 `mode`。
- `vite build` 一律把 `NODE_ENV` 設成 `production`
- `--mode` 只決定載入哪個 `.env.*` 檔，**不影響 `NODE_ENV`**

**真正的 footgun 是 `NODE_ENV`**：
```bash
NODE_ENV=development bun run build     # ← 這個才會讓 DEV=true
```
實測那個產物會多出一個 `assets/dev-<hash>.js` chunk，dev-only 的字串全部命中。

**所以：任何「用 `import.meta.env.DEV` 當安全開關」的設計，都必須再加一道執行期防線**（例如檢查 `location.hostname` 是不是本機）。單靠 build 期判斷不夠，因為打包者的環境變數可以改變結論。

`cre8-app` 的做法：
```ts
const DEV_WALLET_ENABLED =
  import.meta.env.DEV && /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(window.location.hostname);
if (DEV_WALLET_ENABLED) { void import('./dev.js') /* 才掛載 dev 面板 */ }
```
- `bun run build`（正常）→ `DEV=false` 恆假 → 整段被 tree-shake，**產物裡連 hostname 那段都沒有**
- `NODE_ENV=development` 打包 → dev chunk 存在，但 hostname 檢查讓它在非本機網域下不掛載

**驗證方式**：不要只 grep 原始碼，要 **grep 產物**：
```bash
bun run build && grep -rl "dev-private-key" dist/assets/*.js   # 應 0 檔
```

### 7.7 移除 UI 元素時，把 markup 搬進 JS 才搖得掉

`cre8-app` 原本把 dev 面板寫在 `index.html`，那樣就算 JS 被 tree-shake，**HTML 裡的 `id` 與字串仍在**。

正確做法：dev 的 markup 改成在 `dev.ts` 裡用 `createElement` 建、插進一個在 production 永遠是空的容器。這樣 production 的 HTML 也不含那些字串。

**教訓**：`import.meta.env.DEV` 只能搖掉 **JS**。任何寫在 `.html` 裡的東西都要另外處理。

---

## 八、索引器 / 排程器

### 8.1 空 `steps` 的 `executeRebalance` **會成功，而且什麼都不做** ⚠ 驗收最大陷阱

```solidity
for (uint256 i; i < steps.length; ++i) { ... }   // AtpExecutor.sol:157-166
```

`steps.length == 0` 時迴圈一次都不跑，`NotAccount` / `DeadlineExpired` / `NotEnrolled` / `Paused` 全部可通過 → **函式正常返回、不換任何幣、不 emit 任何 `SwapExecuted`**。

而那條「批次不能是空的」的檢查（`_checkCommands` 的 `count != 0`）**只在 per-step 路徑上被呼叫**，空陣列根本走不到。

**所以：`tx.status == 1` 不代表再平衡成功了。** 我們的 frontend 驗證流程當初就是用空 `steps` 成功的 —— 那證明了簽章與權限正確，但**沒有證明任何一顆幣被換掉**。

**排程器的驗收必須要求下列之一**：
- `SwapExecuted` 事件的數量等於預期的 step 數，或
- account 的 ERC-20 餘額在交易前後有預期的變化

合約層對「至少一個 step」**沒有任何保證**。

### 8.2 native BNB 不是投資部位，不能算進漂移

smart account 持有 BNB 是為了付 gas。把它算進持倉，**每個帳戶都會看起來嚴重超配 BNB**，漂移永遠超標 → 排程器瘋狂觸發再平衡。

而且這個錯**不會報錯**，它只會讓系統一直做無謂的事、一直燒 gas。這比拋錯危險得多。

正確做法：`nativeBalanceWei` 與 `holdings` 分開回傳，`computeDrift` 只吃 `holdings`。

⚠ 若策略目標包含 **WBNB**，那是 ERC-20 `balanceOf(WBNB)`，跟 native BNB 是兩個不同的東西，要照常讀。

### 8.3 目標權重的版本要用鏈上的 `enrollment.version`，**不是** `version(strategyId, 0)`

`registry.version(id, 0)` 會解析成**策略當前的 active 版本**。但使用者 enroll 時可能釘在**舊版**（`AtpRegistry.sol:8-9, 173-175` 的註解明說這件事）。

用 0 的話：策略一升級，所有跟著舊版的帳戶都會用**錯的目標權重**算漂移 —— 而且算出來的數字**看起來完全合理**。這是靜默錯誤。

正確做法：`registry.enrollments(account)` → 拿 `(strategyId, version, paused)` → 用那個 `version` 去查 `version(strategyId, version)` 或 DB 的 `strategy_versions(strategy_id, version)`。

### 8.4 DB 的 `portfolios.strategy_id` ≠ 鏈上的 strategy id

我們有兩層編號：DB 的 `portfolios.strategy_id`（例：**11**）與 `strategies.onchain_id`（例：**1**）。鏈上 `enrollments()` 回的是**後者**。

看起來像資料不一致，其實是那一欄在負責對應。比對時要用 `onchain_id`，不要直接拿 `portfolios.strategy_id` 去比。

### 8.5 `positions_snapshots` 原本沒有任何鍵 → 重跑會重複計入

原本的表只有 FK，**沒有 PK、沒有 UNIQUE**。同一 block 重跑一次快照，會多一列，漂移計算就把同一筆持倉算兩次 → 權重錯，**而且錯得很安靜**。

0005 migration 補了 `UNIQUE (portfolio_id, asset, block)`。寫入端用 `on conflict do update`。

⚠ 這類「衍生資料」表的鍵特別重要：因為它是重算出來的，重跑是常態而不是例外。

### 8.6 空倉時「一列都不寫」會讓下游分不出「沒跑」與「跑了但是空的」

`positions_snapshots` 只有明細列。空倉的 portfolio 寫入 0 列 → 下游無法回答「上次什麼時候檢查過、當時漂移多少」。

修法：加一張 header 表（`portfolio_snapshots`），**空倉也要寫一列**。

### 8.7 bStock 的 symbol 是 `<TICKER>B`，不是 `b<TICKER>`

`TSLAB`、`NVDAB`、`CRCLB` —— 不是 `bTSLA`。而且**全部 18 decimals**（不是美股的 6/8，別套美股慣例）。

**沒有官方 token list**（發行方只給 HTML 頁面，沒有 JSON 端點），所以白名單必須自建、自己維護。

---

### 8.8 `Multicall3` 對「沒有合約的地址」回 `success: true` + `returnData: 0x`

**症狀**：用 `aggregate3` 批次讀 `balanceOf`，其中一個地址根本沒有合約，但你只看 `success` 判斷成敗 → 一路到解碼才炸，錯誤訊息是 viem 的 `Cannot decode zero data ("0x")`，**指名不到是哪個地址**。

**原因**：EVM 的 `CALL` 到沒有 code 的地址**不會 revert**，只是回傳空資料。所以 `allowFailure: true` 的 `aggregate3` 會誠實地回 `success: true`、`returnData: 0x`。

**正確判斷**：`success === false` **或** `returnData === '0x'` 都算失敗。

```ts
const failed = !res.success || res.returnData === '0x';
if (failed) throw new Error(`讀不到 ${address} 在塊 ${block} 的 balanceOf/decimals：`
  + '這個地址不是 ERC-20（沒有合約或呼叫 revert），或節點拒絕 eth_call');
```

**這個坑的教訓**：`success` 回答的是「這個呼叫有沒有 revert」，不是「這個呼叫有沒有得到有意義的結果」。兩者不同。

### 8.9 漂移的宇宙是 `version.assets`，**不是**我們的白名單

一度把「讀取宇宙」設成 `priceable_assets(全域白名單) ∪ 目標資產`，並且把「發現策略外持倉」當成 blocker。**那是錯的**，而且方向錯得很根本。

**關鍵事實**（`AtpExecutor.sol:180-182`）：
```solidity
if (!registry.isAssetAllowed(enrollment.strategyId, enrollment.version, step.tokenIn)
    || !registry.isAssetAllowed(..., step.tokenOut)) revert AssetNotAllowed();
```
**執行器拒絕換任何不在 `version.assets` 裡的代幣。**

推論鏈：
1. 策略外的代幣（空投、使用者亂轉）我們的系統**賣不掉**
2. 所以它**不可能參與再平衡**
3. 所以它**不該進漂移的分母**

所以漂移只在 `version.assets` 內正規化。**一筆空投不影響漂移** —— 它不進 `holdings`、不進分母、`grossDriftBps` 與沒有空投時**逐位相同**。

白名單（`priceable_assets`）降級成「這個地址的價格怎麼查」的**查詢表**，不再是「要讀哪些資產」的來源。

⚠ **仍然要 blocked 的是**：`version.assets` 裡的資產**持有但無價**。那才是真正的問題 —— 不知道策略元件值多少，就算不出權重。

**我為此繞了一大圈**：先把 review 的「未知持倉不可見」當成 bug，建了游標表、候選表、還準備租專用 RPC 節點（因為公共節點拒絕不帶 address 的多塊 `getLogs`）。三輪工時裡有一輪半在修一個**投影錯誤**。

**教訓**：收到一份語氣肯定的 review，要回頭核對它依賴的**前提**。那份 review 用的是「總價值為分母」的模型，而那個模型在我們的合約約束下根本不可執行。

---

### 8.10 `permissionConfig(pid).signer` 是 **validator 合約位址**，不是 session key 的 EOA ⚠ 我用這個誤判過

**錯誤的檢查方式**（我用過，而且拿它向你報告了錯誤的結論）：
```bash
cast call $ACCOUNT "permissionConfig(bytes4)((bytes32,bytes32,bytes32,bytes))" $PID | grep -q "6a6f069e"
```
`0x6A6F069E…` 是 **ECDSA validator 合約**，**每一把 ECDSA session key 都一樣**。所以這個 grep 只證明「這個 `permissionId` 的 struct 裡有一個 policy 位址」，**不證明它綁的是哪把 key**，甚至不證明它還安裝著。

**正確的判讀**：
```
signer == 0x0  →  這個 permissionId 沒有安裝
signer == ECDSA validator 位址  →  有安裝一個 ECDSA permission，但「綁哪把 key」還沒證明
```

**要證明「這把 key 真的能用」，只有一條路：送一筆 op。**

而有一個很漂亮的鏈上旁證 —— **看 `UserOperationEvent.nonce` 的高 192 bits**：
```
0x01 ++ <validator 位址>       → sudo 簽的
0x02 ++ <permissionId>         → session key 的 permission validator 簽的
```
`0x02` 就是 `VALIDATOR_TYPE.PERMISSION`。這比讀程式碼「我設了 `regular:`」強得多，因為它是鏈上事實。

**實例**：本專案四把 key 裡，兩把 `signer != 0`（已安裝）、兩把 `signer == 0`（DB 有列但鏈上沒有）。用 grep 檢查的話四把都會「通過」。

### 8.11 DB 的 `session_keys` 有列 **不代表** 鏈上裝好了

`POST /portfolios/:id/renewal-result` 只把前端回報的結果寫進 DB。它寫入的那一刻可能真的是對的，但**之後鏈上狀態可以變**（reorg、fork 重置、合約被改）。

**所以 keeper 在挑 key 之前必須驗鏈上**，不能只看 DB 的 `status='active'`：
```
1. 從 DB 取候選 key（key_ref → 派生 EOA → 重建 permissionId）
2. permissionConfig(pid).signer != 0        ← 有安裝
3. 實際送一筆（或第一次送失敗就標記該 key 不可用）
```

⚠ 注意「取最新那把」是危險的預設：本專案最新那把（`…24806716`）就沒安裝，而**舊的**那把（`…24806714`）反而可用。

### 8.12 `RPC_URL=""` 會靜默打到錯的節點

`process.env.RPC_URL ?? default` **保留空字串**（`??` 只擋 `null`/`undefined`）。`http('')` 不會報錯，會打到某個不是 anvil 的地方，症狀是「讀到 BNB 0、送交易回 insufficient funds」—— **看起來像鏈上沒錢，其實是打錯節點**。

用 `firstNonEmpty()` 之類的輔助：空字串一律當沒設。

### 8.13 真再平衡的驗收必須綁在「代幣真的動了」

見 §8.1（空 `steps` 會成功）。實際可用的三重證據：

| 證據 | 怎麼看 |
|---|---|
| `SwapExecuted` 事件數 == steps 數 | 解 receipt 的 logs，比 `status` 強得多 |
| ERC-20 餘額差 | `Δ in == amountIn`、`Δ out == net`，一位不差 |
| `grossDriftBps` 下降 | 重跑索引器，權重真的往目標收斂 |

實測一次成功的再平衡：`WBNB −249999999996402377`（== `amountIn`）、`USDT +173627601129317533692`（== `net`）、`grossDriftBps 5000 → 1`。

---

### 8.14 `a ? b : c` 形式的邊界檢查，只驗了一邊 ⚠ 通過 33 個測試的合約也有

**實例**（`PancakeV3TwapOracle.sol:167`，修前的原貌）：
```solidity
bool inIsToken0 = tokenIn == token0;
if (inIsToken0 ? tokenOut != token1 : tokenOut != token0) revert UnsupportedPair();
//   ↑ 只驗了 tokenOut                    ↑ 完全沒驗 tokenIn 是不是 pool 的幣
```

`tokenIn` 是陌生代幣時 `inIsToken0 = false`，只檢查 `tokenOut == token0` → **通過** → 用 token1 那一側的價格替一個完全無關的代幣報價。

**實測**：`previewSwap(NVDAB, USDT, 1e18)` 與 `previewSwap(WBNB, USDT, 1e18)` 回**逐位相同的數字**。它不報錯，回一個看起來正常的價格。

**安全影響**：`AtpExecutor` 用 `minimum` 當 `amountOutMin` 的下界。若某資產的真實價格**高於** pool 的 token1，floor 被算**太低** → 那道 per-step bound 形同放寬。

**為什麼測試沒抓到**：測試驗了「正常 pair 能報價」與「明顯錯的組合 revert」。而「陌生人 + token0」這個組合**看起來像正常 pair**（`tokenOut` 真的是 pool 的幣），正好落在盲區。

**這個形狀值得記住**：三元運算式的邊界檢查在視覺上很對稱，所以 review 時容易滑過去。看到 `cond ? X != y : X != z` 就問一句：**`cond` 本身被驗過了嗎？**

**修法**（兩邊都驗）：
```solidity
bool inIsToken0 = tokenIn == token0;
bool inIsToken1 = tokenIn == token1;
if (!inIsToken0 && !inIsToken1) revert UnsupportedPair();
if (inIsToken0 ? tokenOut != token1 : tokenOut != token0) revert UnsupportedPair();
```

**教訓**：「這個合約有 33 個測試」不是安全保證。測試覆蓋的是「我們想到要驗的事」，不是「所有可能壞的事」。

### 8.15 換 Executor 地址 = 所有 session key 權限失效

`CallPolicy` 的 `target` 釘在 executor 地址上。所以任何產生新 executor 的改動（換 oracle、改簽名、換實作）都會讓**所有既有 session key 失效** —— 它們指向舊地址。

這不是 bug，是設計的必然。但它意味著合約升級有一個**系統不可用的窗口**：新 executor 部署後、權限重建完成前，排程器會全部 `blocked`（fail closed，不會亂動錢）。

**生產環境的遷移順序應該是**：
1. 部署新 executor
2. 讓每個使用者重新簽一次權限（指向新 executor）
3. 才把後端的 `EXECUTOR_ADDRESS` 切過去
4. 舊 executor 保留一段時間（還沒有權限但它沒有資產）

**不要**在第 3 步之後才做第 2 步 —— 那會讓排程器對著一個沒有任何帳戶授權的 executor 空跑。

---

### 8.16 `tx.status == 1` **不代表 op 成功** —— EntryPoint 會吞掉執行失敗 ⚠

§8.1 說的是「空 `steps` 會成功但什麼都不做」。**還有一個更陰的版本**：

**EntryPoint 的 `handleOps` 對「驗證通過但執行失敗」的 op 不會讓整筆交易 revert**，它會 emit `UserOperationEvent(success = false)` 然後繼續。所以：

```
tx.status          = 1        ← 交易成功上鏈
UserOperationEvent.success = false   ← 這個 op 失敗了
SwapExecuted 筆數   = 0        ← 什麼都沒換
帳戶付的 gas        = 54 萬     ← 真的花了
```

**實測成因**：`eth_estimateUserOperationGas` 對「一筆 op 裡跑完整個 DeFi 路徑」估太少。
```
executeRebalance → UniversalRouter.execute(0x3593564c) → pool.swap(0x128acb08)
  → "out of gas: not enough gas for reentrancy sentry"
```
`callGasLimit` 不夠走完 swap。alto 的估算低估了這一趟。

**為什麼特別危險**：`confirmed` 在 `operations` 的冪等閘門裡代表「這組參數已經成功上鏈，永不再送」。把一個「上鏈但什麼都沒做」的 op 記成 `confirmed`，等於**永久放棄了那組參數**，而且報表會顯示「已執行」。

**驗收標準（三層，缺一不可）**：
1. `receipt.status == 1`
2. `UserOperationEvent.success == true`
3. **`SwapExecuted` 的筆數 == steps 的筆數**

只驗第 1 層就是 §8.1 的假成功；只驗 1+2 仍然可能是「op 成功但 steps 是空的」。

**這個專案裡曾經只有 `scripts/execute-rebalance.ts` 驗到第 3 層，`src/scheduler.ts` 只驗第 1 層** —— 同一套系統的兩條路徑，驗收深度不同，就是這種 bug 的溫床。

### 8.17 地板是活的：plan → execute 之間它會變

`PancakeV3TwapOracle.previewSwap` 的 `minimum` 是
```
max( ceil(TWAP 30 分鐘 × (1−slippage)), ceil(近 5 分鐘均值 × (1−slippage)) )
```
**「近 5 分鐘均值」會追著池價跑。** 所以規劃時算出的 `amountOutMin` 到了 40 秒後執行時，可能已經低於執行那一刻的地板 → `BelowFloor`。

**實測**：同一個 leg 在規劃塊與執行塊之間，地板差 **13 bps**（`4628813433787421742` → `4622800186438454886`）。

**正確做法：送出前立刻重問地板**，不要用規劃時凍結的值。而且 —— **`amountOutMin` 在 calldata 裡出現兩次**（`step.amountOutMin` 給合約、`inputs[0]` 裡給 UniversalRouter），只改前者會被 router 用舊地板擋掉（`Too little received`）。

⚠ 兩個方向的地板移動方向相反：買入時均值往下收斂（地板變低），賣出時均值往上追（地板變高）。所以「只有某一側會壞」不代表另一側安全。

---

### 8.18 `bun test` **不印 skip 的原因**，只印測試名

```
(skip) DB: strategy and version round trip      ← 為什麼 skip？怎麼開？看不到
```

原因字串寫在原始碼裡（`{ skip: '...' }`），但 bun 1.4.4 只印測試名。

**修法**：在測試檔 module-level 印 banner（bun 會顯示）：
```ts
if (gate !== false) {
  console.log('[skip] 鏈上寫入測試未執行：RUN_CHAIN_TESTS=1 bun test --timeout=120000 才會跑');
  console.log('[skip] 要跑請用：RUN_CHAIN_TESTS=1 bun test --timeout=120000（不要加 --concurrent）');
}
```

**印兩行而不是一行**：第一行帶真實原因（`String(gate)`），第二行是可複製的指令。只印指令的話，`DATABASE_URL is not set` 這種情況會被誤講成「去設 RUN_CHAIN_TESTS」。

### 8.19 `bun test --concurrent 1` **不是**「循序執行」

bun 1.4.4 的 `--concurrent` **不吃值**：
```
$ bun test --concurrent 1
The following filters did not match any test files: 1     ← 1 被當成檔名 filter
```
結果是**一支測試都不跑**，看起來像「全綠」。

⚠ 而且 bun 預設是**一檔跑完再換下一檔**，所以「多檔並行撞 nonce」這個直覺是錯的。

**真正的凶手是 per-test timeout**：bun 預設 5 秒。這條鏈一輪 `enroll` 要 13–15 秒 → 測試逾時，但**底層送交易不會被取消**，在背景繼續跑 → 下一個測試讀到 `latest` nonce 時它還沒上鏈 → 等它上鏈後就變成 `NonceTooLow`。

**所以跑會寫鏈的測試要**：`RUN_CHAIN_TESTS=1 bun test --timeout=120000`。
「被放棄但還在跑的測試」才是 nonce 相撞的來源，不是並行。

### 8.20 同一份邏輯的第二份實作：顯示用的可以接受，但要在程式裡寫死理由

`operator.ts` 的 `resolveStatusSessionKey` 是 `scheduler.ts` 私有 `resolveSessionKey` 的**第二份**（後者沒 export、而 `scheduler.ts` 是受保護檔）。

**這個重複是可接受的，因為**：它是唯讀顯示，**不參與任何放行判斷** —— 真正決定會不會動錢的仍是排程器自己的前置檢查。即使兩邊分岔，最壞後果是面板顯示錯的 key 名字。

⚠ **但這個論證必須寫在程式碼裡**，否則下一個人會以為它也是權威、或以為可以直接改其中一邊。改一邊要改另一邊。

**判準**：複製一份邏輯可以，前提是「它的錯誤不會造成不可逆的後果」＋「理由寫在旁邊」。

---

### 8.21 帳戶地址只認得「部署當時」的 initConfig，續期過就重算不出來

`renew-session-key.ts` 用「DB 裡最新的那把 session key」的 initConfig 去反推帳戶地址，作為「我沒有送錯 op」的守衛。但：

```
帳戶 0x2b08… 是用第一把（0x4ddb1075）的 initConfig 部署的
DB 最新那把是 0x7db20115（第三次續期）
→ 帶 0x7db20115 的 initConfig 重算 → 0x52C8471E… ≠ 0x2b08…
→ 腳本 throw，拒絕送 op
```

**停下是對的**（`pitfalls §4.7`：帳戶地址取決於部署時的 initConfig）。但它讓「續期過很多次的帳戶」無法再走這支腳本。

**根因**：DB 沒有記錄「部署當時用的是哪一把」。`enrollment_intents` 釘了 `validUntil`，但沒有釘 `key_ref`。

**實務影響**：帳戶的續期應該走**前端那條路**（`POST /portfolios/:id/renewal-params` → 簽名 → 上鏈），它不需要重算部署地址，因為它拿的是鏈上的 `enrollment` 與現有的 `permissionConfig`，不是 DB 的推測。

⚠ 這也解釋了為什麼 `scripts/renew-session-key.ts` 只適合「全新帳戶的第一次續期」。

### 8.22 換 executor 之後，舊 portfolio 需要**重裝權限**，不是重新 approve

實測 `#5`（session key 綁在舊 executor）：

```
[ALLOWANCE_TOO_LOW]  → 修好了（重新 approve 新 executor）
permissionId 不符：重建 0x839a6ba5 != DB 0xf67556bf
```

**第二個修不掉。** 因為 `permissionId` 是從 policy 內容（**含 CallPolicy 的 target**）算出來的 —— executor 一換，那把 key 就在數學上不屬於新的 executor 了。

**所以換 executor 的遷移是三步，不是兩步**：
1. 部署新 executor
2. 每個帳戶**重裝** session key 權限（sudo 簽名的 `installValidation`，target = 新 executor）
3. 每個帳戶**重新 approve**（allowance 的 spender = 新 executor）

只做 2 或只做 3 都會卡住，而錯誤訊息不同（`permissionId 不符` vs `ALLOWANCE_TOO_LOW`）。

⚠ 這也代表 `renew-session-key.ts` 的那個地址守衛在「換 executor 後」還多一個障礙（§8.21）—— 所以遷移應該走前端那條續期路徑。

---

### 8.23 一個**永遠在叫**的檢查，和一個永遠通過的檢查一樣沒有資訊量

第一版告警上線後，`/health` 立刻變成 `degraded` 且**永遠不會恢復**：

```
[ALERT][critical] portfolio 3   只剩 0 次操作的 gas
[ALERT][critical] portfolio 4   只剩 0 次操作的 gas
…（6 筆，全部是空的舊測試 portfolio，從來沒有成功執行過）
```

功能正確（那些帳戶真的沒 gas），但**語意錯了**：「還沒設定好」與「本來好好的、突然缺 gas」都叫 critical。

**後果**：一個永遠 degraded 的健康檢查會訓練所有人忽略它 —— 然後真正出事時沒人看。

**修法：用「有沒有成功執行過」分流嚴重度。**

| 有過 `confirmed` | 從沒有 `confirmed` |
|---|---|
| **critical** —— 這是回歸，不會自己好 | **warn** —— 還沒開始運作，不是緊急事件 |

而且 critical 的 detail 要帶**上次成功執行的時間** —— 那是人看到之後最需要的第一個資訊。

⚠ 同一家族的第三個版本：`§8.14`（永遠通過的單邊檢查）、`§8.16`（`tx.status` 代理）、
`execute-rebalance.ts` 的餘額方向誤報（會叫錯的檢查）—— **檢查本身失去資訊量**。

### 8.24 兩份輸出裡的數字對不上時，先問「它們是同一次執行的嗎」

我看到告警輸出裡同時有：
```
portfolio 305 … （門檻 100000000 次…）
portfolio 3   … （門檻 10 次…）
```
門檻是**同一個參數**，不可能在一次執行裡有兩個值 → 我先判斷是 bug。

實際上是**兩次不同執行的輸出被貼在一起**（其中一次帶了 env 覆寫）。同樣地，
`session_key_expiring` 的「400 天 vs 門檻 30 天」也是同一個原因。

**教訓**：在宣告「這是 bug」之前，先確認兩份輸出**來自同一個環境、同一次執行**。
一份混了多次執行的 log，比沒有 log 更容易誤導 —— 因為它看起來像一個連貫的事實。

⚠ 這也適用於工人回報：當一份回報貼了多段輸出，問一句「這些是同一次跑的嗎」比直接比對數字有效。

---

### 8.25 部署腳本的「重用」邏輯會讓改了合約卻還在跑舊 bytecode

`script/DeployAtp.s.sol` 的 `_reuseExecutor`（`:187-212`）判斷「這個地址有 code 而且 `oracle()`/`registry()` 對得上」就重用常數 `EXECUTOR_MULTI_POOL = 0x9C41…`。

**陷阱**：改了 `AtpExecutor.sol` 但**沒有換那個常數**（或沒更新 `deployments/fork.json`）→ 腳本會**安靜地繼續用舊 bytecode**，而輸出看起來完全正常（「REUSE 0x9C41…」）。

**同樣的形狀**也適用於 oracle：`REUSE` 只驗「有沒有 code + 幾個 immutable 對不對」，不驗 bytecode hash。

**修法**：要嘛把「預期的 code hash」也納入重用條件，要嘛改完合約就**明確換掉常數**並在回報裡寫出來。`_reuseExecutor` 的註解已經提到「重用前把讓重用安全的那個 pin 讀回來比對」—— 但那個 pin 不包括實作。

### 8.26 我寫錯過的事實：Permit2 **沒有** 30 天上限

`IPermit2.sol:18` 原本寫「Permit2 caps it at 30 days」。**錯的** —— canonical Permit2 的 `expiration` 是 `uint48`，沒有上限（可到西元 ~890 萬年）。

那 30 天是**我們自己**後端的 `MAX_DEADLINE_SECONDS`（`rebalance-plan.ts`）加上去的。

**為什麼會寫錯**：`AtpExecutor` 傳給 `permit2.approve` 的是 `uint48(deadline)`，而那個 deadline 受我們的 30 天約束 —— 我把自己系統的約束**投射成外部合約的性質**了。

**教訓**：寫「某個外部合約有 X 限制」之前，去讀那個合約，不要從自己的呼叫端反推。

---

### 8.27 「悲觀估計」被拿去當**拒絕的依據**時，就從保守變成 bug

`driftAfterSteps` 只走**既有持倉**來算執行後的漂移。要買進一個現在沒有的資產時，那筆到手量沒有地方可加
—— 只有賣掉的一邊被扣掉，等於宣稱「賣掉的憑空消失」，漂移算成 5000 bps（單一資產佔滿）。

程式註解本來就寫了「目標有、持倉 0 的資產仍以 0 計，於是改善被低估 —— 同樣是悲觀方向」。**在只用來顯示
的時候那是對的取捨**；一旦「不改善就不送」的守衛拿它當依據，它就變成「**永遠不買你沒持有的資產**」。

**判準**：一個估計值被用來**做決定**時，「偏保守」不再是安全的 ——
保守在「多說一點壞消息」時安全，在「因此什麼都不做」時是故障。

**修法**：算不出來就回 `null`（語意 = 不知道），呼叫端**不套用**該守衛（fail-open），並在 rationale 裡
寫出來。誤擋一個正常的新建倉，比多付一次 gas 貴得多。

### 8.28 探針只做暖查詢 → 過期後仍回報「健康」，然後測試一起紅

`snapshot.integration` 的 `probeFork()` 本來讀 chainId + 塊高 + 池子 TWAP。fork 的 archive 視窗過期
（上游 403）之後，這些**暖查詢仍然成功**（anvil 直接回快取），於是探針回 null → 不 skip →
6 條測試在真正冷讀時一起變紅。

**探針必須走一條「真的會回源」的路徑**：讀一個沒被任何測試碰過的位址
（`eth_getBalance(0x…DeaDBeef)`）—— anvil 沒有它的快取，必須回上游的 fork 塊要，那裡才是 403 發生的地方。

⚠ 這個坑咬過兩次（一次讓我差點退掉一份正確的交付）。**「跳過」與「失敗」的界線要由探針畫對。**

### 8.29 `backend` 有 44 個 untracked 檔 —— 工人改壞時**無法 diff、無法還原**

```
backend:  11 已追蹤但修改、44 untracked
src/ 25 個檔裡 15 個 untracked（rebalance-plan / impact / scheduler / alerts / drift 全部在裡面）
```

所以「工人中止在半成品狀態」不是「還原就好」，而是**沒有任何基準可以判斷他改了什麼**。實測一次：
兩個工人同時改 `src/rebalance-plan.ts`，其中一個中止，測試從 450 綠變成 20 紅，而 `git diff` 是空的。

**做法**：
1. **同一個檔不要派給兩個工人**（並行只在檔案互斥時才安全）。
2. 派工涉及 `src/` 之前先 `git add` 一份基準（不必 commit），中止時 `git diff` 才有東西可比。

---

### 8.30 續期腳本重用 key index → DB **靜默 duplicate** → 帳戶卡死在舊 policy

`renew-session-key.ts` 原本用 `newIndex = baseIndex + 1`。帳戶續期過幾次之後那個 index 早就被用掉了，
而 `session_keys.key_ref` 是唯一鍵：

```
新權限在鏈上裝好了（新 permissionId、target = 新 executor）
寫 DB → on conflict (key_ref) do nothing → 回 duplicate: true（看起來成功）
DB 那一列描述的仍是**換 executor 之前**的 CallPolicy target
排程器重建 pid → 0x839a6ba5 != DB 0xf67556bf（或反過來）→ 每次 blocked/failed
```

**症狀**：葉面上「續期成功」，排程器卻永遠說 `permissionId 不符`。鏈上與 DB 各說各話。

**修法**：從 `baseIndex + 1` 往上找**第一個沒被 `session_keys` 用過**的 index（`firstFreeIndex()`），
並在安裝成功後把 `policySnapshot` 寫進 DB（腳本現在有 `[8b]` 這一步）。

⚠ 這也說明：**「寫 DB 失敗」被設計成 `duplicate: true` 是善意的（重送不該報錯），但它讓「key_ref 撞到
別的 policy」與「同一次續期重送」長得一樣。** 分辨方法是比對 `permissions->'call'->'permissions'[0].target`
與當前的 executor —— 不一樣就是撞了。

---

### 8.31 前端的型別是**斷言**，不是驗證 —— 契約錯誤只有真的打一次才抓得到

新 app 的 `getPortfolios()` 型別寫成 `Promise<Portfolio[]>`，`tsc` 一句話都沒說。實際後端回的是：

```json
{ "portfolios": [ … ] }        ← 物件，不是裸陣列
```

執行期 `Array.isArray(data)` 是 false → `data.map` 直接 throw → **畫面全白**。而 build、typecheck、
lint 全綠。

**根因**：`request<T>()` 裡的 `return parsed as T` 是**型別斷言**，TypeScript 對 `cast` 不檢查任何東西。
所有「我照著以為的契約寫型別」的地方，都有這個風險。

**為什麼這次抓到了**：驗證時不是跑測試，而是**照 app 真實會走的路徑打一次**（經 vite proxy 的
`/api/auth/nonce` → `/login` → `/portfolios`），並且**印出 `Object.keys(response)`**。

**做法**：
1. 寫 API 層時，把 **wire 形狀**（`{ portfolios: [] }`）寫成一個具名型別，再在客戶端拆掉 ——
   形狀的註解本身就是文件。
2. 驗證前端資料層不要只看 typecheck，要**印出真實回應的頂層 key**。`Object.keys()` 五行就結束。

⚠ 同一個道理的另一個版本：`§8.14`（單邊 pair 檢查）、`§8.16`（`tx.status` 代理）——
**「看起來對」與「是對的」之間，隔著一次真實觀測。**

---

### 8.32 前端接續期時踩到的兩件事：relay 要認證、SDK 的 entryPoint 要**物件**

**(a) `POST /bundler` 不是公開端點。** 少了 `Authorization: Bearer <token>` 直接 401；它還有六個方法的
白名單（`eth_sendUserOperation` / `eth_estimateUserOperationGas` / `eth_getUserOperationReceipt` /
`eth_getUserOperationByHash` / `eth_supportedEntryPoints` / `eth_chainId`）。
viem 的寫法：`http(url, { fetchOptions: { headers: { authorization: ... } }, timeout: 60_000 })`
—— 預設 10 秒對「估 gas + 送 op + 等 receipt」不夠。

**(b) ZeroDev SDK 的 `entryPoint` 是物件，不是位址字串。**

```ts
{ address, version: '0.7' }                     // ✓
'0x0000000071727De22E5E9d8BAf0edAc6f37da032'    // ✗ → Error: Unsupported entry point version
```

**那句錯誤訊息完全沒提「你傳的是字串」** —— 它假設呼叫端知道型別。這類訊息的價值是零：
看到的人只會去查「哪個 entry point 版本不支援」，而不會懷疑「我傳錯型別」。

⚠ 通則：**SDK 的錯誤訊息通常描述「它做了什麼判斷」，不是「你哪裡錯了」。**
遇到「不支援 X」時，第一個要檢查的是自己傳進去的**型別與形狀**，不是 X 的支援表。

---

### 8.33 探針自己把「冷位址」查暖了 —— 一個只能用一次的檢查

`snapshot.integration` 的 fork 探針原本讀一個固定 sentinel（`0x…DeaDBeef`）當冷讀。
第一版有效；**跑過一次之後那個位址就在 anvil 的快取裡了**，於是過期的 fork 也回報「健康」→
6 條測試紅（而不是 skip）。實測發生在 2026-11-08 05:0x。

**這是 `§8.23` 的同一個家族**：檢查本身失去資訊量 —— 但這次更陰險，
**因為它第一次是對的**，所以沒有人會再去看它。

**修法**：位址必須**每次不同**（隨機 20 bytes）。隨機位址永遠不在快取裡 → 要回答它就得回上游 →
那正是 403 發生的地方。

**判準**：一個「探針 / 快取 / 短路」要能持續有效，它的輸入就不能被它自己或別人**變成熱的**。
設計時問一句：**這個檢查跑第二次的時候，還會做同一件事嗎？**

---

### 8.34 「沒有瀏覽器工具」不是「看不到畫面」—— 用 headless Chrome 自己截圖

這一輪的瀏覽器工具從頭到尾回 `DevTools socket closed`。我因此**連續好幾輪用猜的**改 UI：
看 CSS 規則推斷哪裡壞、改一版、請使用者回報。三輪之後還是「still looks buggy」。

真正有用的做法（一次就結束猜測）：

```bash
mkdir -p .shots/home
HOME=$PWD/.shots/home \
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --disable-crash-reporter --disable-breakpad \
  --user-data-dir=$PWD/.shots/profile --virtual-time-budget=18000 \
  --window-size=1280,1400 --screenshot=$PWD/.shots/page.png http://localhost:5173/vaults
```

⚠ 兩個必須的旗標：`--user-data-dir`（否則 `Failed to create a unique user data directory`）與
`HOME`（否則 Chrome 想寫 `~/Library/Application Support/Google/Chrome/Crashpad` 被沙箱擋）。

**要看「登入後」的頁面**：加一個 DEV-only 的 `?devSession=<json>` 注入（`src/dev-session.ts`，
必須是 `main.tsx` 的**第一個 import** —— zustand 的 persist 在模組求值時就 rehydrate 了，
寫在函式體內已經太晚）。

**截圖一次看到的東西**，比讀 4506 行 CSS 三輪還多：
- `Risk` 用了 `.fund-row-return strong`（25px 等寬，設計給報酬率）→ 巨大紅字
- 搜尋框被截斷（`.explore-search` 是固定 190px 膠囊）
- `.field > span` 把提示抓去當標籤（輸入框被推到右邊）
- 查詢失敗與「沒有投組」長得一樣
- `Connect wallet` 與 `Signed in` 同時出現

**判準**：當你發現自己在「推斷畫面長怎樣」，停下來找一條能**真的渲染**的路。
用猜的改 UI，等於用猜的除錯。

---

### 8.35 新建的投組**沒有 allowance** —— enrol 不開，session key 也開不了

`POST /portfolios` 會部署 smart account、安裝 session key，但**不會開 ERC-20 allowance**。而
`AtpExecutor._swap` 用 `safeTransferFrom` 從帳戶拉幣，所以第一次再平衡必然：

```
[ALLOWANCE_TOO_LOW] allowance(0xac40cb3a… → executor 0x9c41…, USDT) = 0 < amountIn 6600
   ：執行器的 safeTransferFrom 一定 revert
```

**為什麼 session key 不能自己開**：它的 CallPolicy 只白名單 `executeRebalance`（target + selector），
`approve` 是另一個 target + selector。放寬 CallPolicy 等於讓那把 key 可以對任意代幣開任意額度 ——
那是把一個受限的權限換成一個更大的。

**所以 allowance 只能由 owner 簽一次。** 目前的補救是 `scripts/fund-portfolio.ts --approve`
（內部呼叫 `approve-assets.ts`）。⚠ **這是補丁，不是產品**：正確做法是把兩個 `approve` 放進
**enroll 的同一個 UserOp**（兩者都是 sudo 呼叫，本來就可以 batch），這樣「建好就能用」。

**驗收這條路的完整指令**（少一步就會卡在 ALLOWANCE_TOO_LOW）：
```
create 頁 → POST /strategies → /versions → /portfolios   （帳戶 + session key）
fund-portfolio.ts --usd N --approve                       （錢 + allowance）
Re-analyse → Confirm and send                             （真的再平衡）
```

### 8.36 用「目標值」探測 storage slot 會假陽性 —— 餘額剛好相同就永遠猜對第一個

`fund-portfolio.ts` 用 `anvil_setStorageAt` 直接改 `balanceOf`。問題是**代幣的 balance mapping 在哪個
slot 不一定**：BSC 的 USDT 是 proxy，實測在 **slot 1**，不是 OZ 標準的 slot 0。

第一版探測方式：把**目標值**寫進候選 slot，回讀 `balanceOf` 看是否等於目標值。第一次跑（餘額 0）正確
找到 slot 1。**第二次跑**（餘額已經是 20000）卻印出「mapping 在 slot 0」—— 因為任何 slot 讀回來都是
20000，**第一個候選就「符合」**。

**修法**：用一個不可能剛好等於現有餘額的**哨兵值**定位 slot，找到後再寫目標值並再次確認。

**判準**：一個探測必須讓「錯誤的答案」與「正確的答案」產生**不同的觀測**。若兩者可能撞在一起，
那個探測就只能用一次。

### 8.37 兩個查詢的新鮮度不同，看起來就像系統自相矛盾

實測畫面：「總值 $0.00 / drift 5000」旁邊掛著一份剛算好的 `ready` 計畫。

真相：`/status` 有 10 秒快取（`STATUS_CACHE_TTL_MS`），而「Re-analyse」只重算 `/plan`。
兩個查詢各自正確，**只是取樣時間不同**。

**修法**：任何「重算」按鈕都要把**同一畫面上的其他查詢**一起刷新，否則使用者會看到一個不存在的矛盾。
這一類問題 typecheck 抓不到、API 也完全正確 —— 只有看畫面才會發現。

---

### 8.38 fork 刷新之後 alto 的 executor nonce 會對不上 —— UserOp 靜默 timeout

症狀：`eth_sendUserOperation` **回了一個 userOpHash**，然後等 receipt 等到 30 秒 timeout；
`debug_bundler_dumpMempool` 是空的；鏈上沒有那筆 op 的 `UserOperationEvent`。

alto 的日誌才有真相：

```
ERROR executor: error submitting bundle transaction
  err: NonceTooLowError: Nonce provided for the transaction (25528)
       is lower than the current nonce of the account. "transaction already imported"
```

`refresh-anvil.sh` 會把鏈的狀態換掉，alto 快取的 executor nonce 就過期了。它會一直重送、
一直撞到 dedupe，而**客戶端只看得到 timeout**（錯誤訊息完全不提 nonce）。

修法：`bash backend/scripts/refresh-anvil.sh` **然後** `docker restart alto-app`，順序不要顛倒。
驗證：`cast nonce <alto executor> --rpc-url …` 與 alto 日誌一致，再送一筆 op。

**教訓**：當一個 RPC 回 200 但行為錯時，答案在**服務端的日誌**，不在客戶端的錯誤訊息裡。
而且 `eth_sendUserOperation` 回 hash **不代表 op 會被執行** —— hash 只代表「收下了」。

---

### 8.39 「算不出來」被寫成「沒有改善」—— 一個數字造成的三重錯誤

實測（portfolio #1682）：投組只持有 USDT，這一輪要買進兩個**沒持有**的資產。結果卡寫：

```
Partial execution: estimated drift is still 6600 bps after this round
(the gap was skipped rather than shrunk); next_run_at moved up to … (1800s)
```

而快照顯示那一輪把漂移 **6600 → 6 bps**，總值只少了 $5.31。三件事同時錯：

1. **錯的數字**：`postDrift === null`（買到的量沒有價格可估 → 算不出執行後漂移）時，
   程式拿**執行前的漂移** `drift.grossDriftBps` 當剩餘量。
2. **錯的措辭**：`describePostDrift` 把它講成「estimated drift is still …」，讀起來像預測。
3. **錯的調度**：據此把 `next_run_at` 提前到 1800s —— 用一個算不出來的缺口做調度，等於用猜的。

修法：`PlanPartial.remainingDriftBps` 改成 `number | null`。`null` 就說 `null`：

```
the drift after this round cannot be estimated yet (it buys assets the portfolio did not hold,
so the received amount has no price to value it). Kept the full interval; the next round will measure it.
```

**判準**：「算不出來」與「算出來是 0／沒改善」是兩個不同的狀態，型別要分得開。
把它們壓成同一個 `number`，下游一定會有一個地方開始說謊 —— 而這裡有三個。

---

### 8.40 型別有、DB 的 CHECK 有、執行期的白名單沒有 → 監控在最該看見時瞎掉

新增 `portfolio_stuck` 告警時改了三個地方：`AlertKind` 型別、migration 0016 的 CHECK、
以及偵測函式。**漏了第四個地方**：`asKind()` 裡的執行期字串比對。於是：

```
$ bun run scripts/scheduler.ts --alerts
失敗：scheduler_alerts.kind 不是已知種類（收到 "portfolio_stuck"）
GET /health → alerts: null
```

不是「少一則告警」，是**讀取全部失敗** —— 只要有一筆 stuck，CLI 拋錯、`/health` 的 alerts 變 null。
告警系統在「真的有東西要看」的那一刻瞎掉，而且 `typecheck` 完全抓不到（型別是對的）。

修法：讓型別**從陣列推導**，兩者共用同一個來源：

```ts
export const ALERT_KINDS = ['portfolio_repeatedly_failing', 'session_key_expiring', 'gas_low', 'portfolio_stuck'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
```

**判準**：任何「型別 + 執行期檢查」成對出現的清單，都應該讓型別從執行期那份推導。
寫兩份就一定會有一份過期，而過期的那份在 `typecheck` 眼裡是正確的。

### 8.41 DB 測試「借」了別人的資料，只有在那份資料還在時才會過

用乾淨的資料庫（`cre8_atp_test`，18 個 migration）跑被 skip 的 DB 測試，一次浮出三支：

| 測試 | 借了什麼 | 症狀 |
|---|---|---|
| `scheduler.test.ts` 的 `seedPortfolio` | 任何一個 strategy（外鍵） | `DB 裡沒有任何 strategy，造不出測試用的 portfolio` |
| `holdings-scan.test.ts` | `portfolio_id = 5` 寫死 | 撞 FK：`Key (portfolio_id)=(5) is not present` |
| `snapshot.integration.test.ts` | portfolio 5 的鏈上策略與 smart account | **unhandled error between tests** → 報「1 error」而且沒有測試名 |
| `alerts.test.ts` 的形狀測試 | 「DB 裡只有我插入的 2 列」 | dev DB 有 7 筆真實告警 → `7 !== 2`，紅的原因與它要驗的東西無關 |

這些在 dev 機器上一直是綠的，因為那裡剛好有那些資料。**不是測試通過，是巧合成立。**

**判準**：一個測試如果「換一個空資料庫就紅」，那它測的不是程式，是這台機器的歷史。
第三種症狀最惡劣：unhandled error 讓整個檔案中止，還沒有測試名可查 —— 所以那支改成
檔案層級 skip 並說清楚缺什麼（自足化的成本記在 D-35）。

---

### 8.42 try/catch 包住「建 probe」不等於包住「用 probe」

`GET /assets` 回 500，日誌只有一句 `ContractFunctionExecutionError: "oracleOf" reverted … 403`。

成因有兩層：

1. **環境**：anvil fork 的 75 分鐘 archive 窗口過了，`oracleOf`（mapping 讀取 → 需要歷史
   storage）被 publicnode 以 403 拒絕。這是我知道的既有事實（§ fork 保存期限）。
2. **我的 bug**：`defaultListAssets` 寫了 `try { … } catch { probe = undefined }`，
   但那個 try 只包住**建構 probe**（讀 executor 的 `oracle()`）。真正的鏈上讀取是
   `probe.oracleOf` 這個 **lambda**，它在 `listPriceableAssets` 裡才被呼叫 —— 在 try 之外。

**判準**：把「取得一個會拋錯的東西」包在 try 裡，只保證**取得**不會炸。lambda / callback /
async 函式被**呼叫**的時候才是真正的失敗點，而那通常發生在別的函式裡。
包裝時要問：「這個 try 涵蓋的是建構，還是執行？」

而且這裡的**正確語意本來就是「查不到 ≠ 壞掉」**：端點回答的是「有哪些資產可以選」，
不是「鏈現在好不好」。單一資產查不到 → `tradable: null`（UI 顯示 unknown），
比整頁 500 好得多。

### 8.43 一個「不該壞」的端點壞掉時，先問它本來要回答什麼

同一件事的另一面：`/assets` 的 500 讓 **create fund 整頁不能建基金**（選單空的），
而真正壞掉的只是「這個資產有沒有註冊 oracle」這一個附加欄位。

外掛欄位（`tradable`、`gas`、`sessionKey` 這類「順便問一下」的資訊）**不該有能力**
讓主要答案變成 500。它們的失敗模式應該是 `null` + 前端顯示未知 —— 這個 repo 已經
對 `gas` 與 `sessionKey` 這樣做了（見 `Portfolio.gas` 的註解），`tradable` 是漏掉的那一個。

---

## 附錄：診斷心法

這輪踩到的坑有一個共同模式：**錯誤訊息指向的位置，幾乎都不是真正的原因**。

| 你看到的 | 真正的原因 | 看哪節 |
|---|---|---|
| `AbiErrorSignatureNotFoundError` | 不是簽章問題，是 alto 的 ABI 解碼器壞了 | §1.1 |
| `HTTP 500 HTTP request failed` | 不是網路問題，是驗證結果被誤解碼 | §1.1 |
| `Archive requests require a personal token` | 不是權限問題，是 fork 區塊變舊了 | §2.1 |
| 合約查得到、新地址回 `0x` | 不是「沒有合約」，可能是無 fork 版 anvil 不知道 | §2.2 |
| `InvalidSelector` on `owner()` | 不是合約壞了，是 Kernel v3.3 沒這個 view | §4.1 |
| `23505 duplicate key` | 不是併發，是冪等 SQL 選錯列 | §5.1 |
| `PolicyFailed(1)` | 不是設定錯，是 GasPolicy 的 wei 預算用完了 | §3.4 |
| `InvalidAddressError` / checksum | 地址混大小寫但不合 EIP-55；值對但表示法錯 | §3.11 |
| 驗證「鏈上 signer == session key」永遠 FAIL | `permissionConfig.signer` 是簽章器**合約**，不是 EOA | §3.8 |
| `Cannot find module '@zerodev/permissions/constants'` | 該 subpath 沒開放；tsc 看得到但 runtime 沒有 | §3.9 |
| `AA21 didn't pay prefund` / `insufficient funds` | 不是設定錯，是 smart account 沒 BNB（gas 由 sender 付） | §3.10 |
| op 回 `success` 但沒換幣 | 不是鏈的問題，CallPolicy 不驗參數 | §3.5 |
| session key 簽章一直失敗 | 只給了 `plugins.regular` 沒給 `initConfig` | §3.3 |
| 連線跳出不是你要的錢包 | `window.ethereum` 被最後注入的錢包佔用 | §7.1 |
| 錢包拒簽一筆「無法閱讀的資料」 | 那是 UserOp hash（32-byte），不是文字訊息 | §7.5 |
| `chain ID does not match` 而簽名失敗 | 錢包當前鏈 ≠ 訊息宣告的鏈（Phantom 會擋、MetaMask 不會） | §7.3 |
| `getNonce` 回 0 但 op 用過非 0 nonce | key 是 24 bytes 且 hex 省略前導零；key ≠ 位址補零 | §7.4 |
| UserOp `success` 但餘額沒變 | 空 `steps` 是合法的 no-op，合約不保證至少一步 | §8.1 |
| 每個帳戶都嚴重超配 BNB | 把 gas 用的 native BNB 算進投資部位了 | §8.2 |
| 策略升級後漂移算得「很合理」但其實錯了 | 用了 `version(id,0)` 而不是 `enrollment.version` | §8.3 |
| `Cannot decode zero data ("0x")` 指名不到地址 | Multicall3 對空地址回 `success:true` + `0x` | §8.8 |
| 空投讓投組停止再平衡 | 把策略外持倉算進漂移分母了（執行器根本賣不掉它們） | §8.9 |
| `permissionConfig` 看起來有東西但 op 一直被拒 | `signer` 是 validator 合約不是 EOA，grep 它證明不了什麼 | §8.10 |
| DB 說 key 是 active，送出卻失敗 | DB 有列 ≠ 鏈上裝好；要驗 `signer != 0` | §8.11 |
| 「鏈上沒錢」但轉帳一直失敗 | `RPC_URL=""` 打到別的節點 | §8.12 |
| 陌生代幣也能報價 | `a ? b : c` 的邊界檢查只驗了一邊 | §8.14 |
| 換 executor 後所有 op 被拒 | CallPolicy target 釘在舊地址 | §8.15 |
| `tx.status=1` 但什麼都沒換 | EntryPoint 吞掉執行失敗，只 emit `success=false` | §8.16 |
| 同一組參數昨天能送、今天 `BelowFloor` | 地板是活的，規劃時凍結的值會過期 | §8.17 |
| dev-only 程式碼出現在產物裡 | 不是 `--mode` 的問題，是 `NODE_ENV`；要另加執行期防線 | §7.6 |

遇到這類訊息時，**先確認錯誤訊息是誰產生的、它在什麼假設下產生**，通常比順著訊息往下追快得多。

### 一個更具體的心法

這輪至少四次「從原始碼推出的結論被鏈上實測推翻」：
1. MetaFactory 面對已存在的 CREATE2 目標**不會** revert（推論說會）→ §4.4
2. alto safe-mode 的根因是 ABI 解碼器，不是 anvil 模擬缺口 → §1.1
3. loadState 之後頭塊**不會**回捲到 dump 的頭（推論說會，但只有無 fork 版才回捲）→ §2.1
4. `plugins.regular` **不影響**地址，只有 `initConfig` 影響 → §3.3

**所以：涉及鏈上行為的結論，讀碼只能產生假設，必須實測才能定案。** 這不是要你不讀碼 —— 而是讀完之後要設計一個能在 5 分鐘內證偽的實驗。
