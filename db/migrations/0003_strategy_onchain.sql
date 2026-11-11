-- ---------------------------------------------------------------------------
-- strategies.onchain_id: link a strategy row to its on-chain AtpRegistry id.
-- ---------------------------------------------------------------------------
-- NULL means "not yet mirrored to chain". createStrategy() sets it once
-- registerStrategyOnchain() succeeds, and it is unique so a DB strategy maps to
-- at most one on-chain strategy. The on-chain id is only valid together with
-- the registry address the backend is configured against (REGISTRY_ADDRESS).
alter table strategies add column onchain_id bigint unique;

comment on column strategies.onchain_id is
  'On-chain AtpRegistry strategy id; NULL until registerStrategyOnchain() succeeds. Scoped to the configured REGISTRY_ADDRESS.';
