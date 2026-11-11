-- CRE8 ATP off-chain schema, migration 0016.
--
-- scheduler_alerts: 新增 portfolio_stuck。
--
-- Why this file exists
--   D-25 說「流動性/價格不適合就等」，但**等待沒有終點保證**。實測 #305：漂移 595 bps，
--   而每一輪規劃都回 noop（現貨偏離 TWAP 讓 impact 預算做不了事）—— 投組就停在那裡，
--   沒有任何人會知道。告警的三個既有種類都蓋不到它：
--     * portfolio_repeatedly_failing 只看 operations 的失敗（noop 根本沒有 operation）
--     * session_key_expiring / gas_low 是別的原因
--
-- 判定方式（不需要新計數器）
--   用**最新的那一張快照**：`needs_rebalance = true` 而且 `created_at` 已經超過 N 小時。
--   因為成功的執行會寫一張 `after` 快照，所以「最新快照仍需要再平衡而且很舊」=
--   「這段時間內沒有任何一次成功執行，而上一次觀測說它還需要動」。
--   這同時蓋到「排程器根本沒在跑」——那個症狀與「一直 noop」對人來說是同一件事。
--
-- Conventions
--   N = `ALERT_STUCK_HOURS`（預設 6）。>= 24 小時升 critical：那不是「今天運氣不好」，
--   是「這個投組已經一整天沒有進展」。

alter table scheduler_alerts
  drop constraint scheduler_alerts_kind_valid;

alter table scheduler_alerts
  add constraint scheduler_alerts_kind_valid
    check (kind in ('portfolio_repeatedly_failing', 'session_key_expiring', 'gas_low', 'portfolio_stuck'));

comment on constraint scheduler_alerts_kind_valid on scheduler_alerts is
  'portfolio_stuck：最新快照仍 needs_rebalance 且已超過 ALERT_STUCK_HOURS 沒有成功執行';
