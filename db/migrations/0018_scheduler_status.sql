-- CRE8 ATP off-chain schema, migration 0018.
--
-- scheduler_status: 排程器的心跳。單列（id = 1），每一輪更新。
--
-- Why this file exists
--   排程器是一個獨立的長駐進程（`bun run scripts/scheduler.ts --loop --live`），
--   而「它還活著嗎、它在跑什麼設定、上一輪結果如何」原本只存在於那個進程的 stdout 裡。
--   實際後果：
--     1. operator dashboard 上的 `scheduler heartbeat` 只能從 `portfolios.last_checked_at`
--        推算 —— 那在「所有投組都還沒到期」時是舊的，看起來像排程器死了。
--     2. 進程死掉與「沒有事要做」在畫面上長得一樣（我們在別的欄位踩過同一個坑）。
--     3. 部署後無法確認「線上跑的是 dry-run 還是 live、limit 多少」。
--
-- 設計
--   * **單列**（`id = 1` + CHECK）：排程器是單一邏輯角色，多列沒有意義。要跑多個實例時，
--     每一輪的 `last_summary` 會互相覆寫 —— 那是刻意的，見下面 `pid` 的說明。
--   * `last_summary` 用 jsonb：一輪的形狀（claimed / executed / noop / blocked / failed 的計數）
--     會隨版本演進，用欄位表達會變成每加一個計數就一次 migration。
--   * `alive` 由**讀取端**用 `last_finished_at` 與自己的時鐘判斷，不寫進 DB ——
--     寫進 DB 就需要一個「標記死亡」的人，而那個人正是死掉的那個進程。
--   * `pid` 只做診斷用（「剛剛跑的是哪個進程」）。多實例時它會被覆寫，這是可接受的：
--     這張表回答的是「最近一輪長什麼樣」，不是「有幾個實例」。

BEGIN;

CREATE TABLE scheduler_status (
    id                smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- 這個進程什麼時候啟動的。重啟後會變，用來分辨「同一支」與「新的」。
    started_at        timestamptz NOT NULL,
    -- 最近一輪**開始**與**結束**。結束時間是「還活著」的判準（見 alive_seconds）。
    last_round_at     timestamptz,
    last_finished_at  timestamptz,
    -- 累計輪數（重啟後從 1 開始）。
    rounds            bigint      NOT NULL DEFAULT 0,
    -- 這一輪的設定快照：dry-run 還是 live、limit、threshold。部署後要能核對。
    dry_run           boolean     NOT NULL,
    round_limit       integer     NOT NULL,
    threshold_bps     integer     NOT NULL,
    interval_seconds  integer     NOT NULL,
    -- 最近一輪的計數彙總（jsonb：claimed/executed/noop/blocked/failed/skipped）。
    last_summary      jsonb,
    -- 最近一輪的錯誤訊息（若有）。不寫入就留 null。
    last_error        text,
    pid               integer,
    updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scheduler_status IS
    '排程器心跳（單列）。last_finished_at 由讀取端換算成「幾秒前」，不存 alive 欄位。';
COMMENT ON COLUMN scheduler_status.last_summary IS
    '最近一輪的計數彙總；形狀隨版本演進，所以用 jsonb 而不是逐欄位。';

COMMIT;
