"use client";
// Create a fund: pick the assets, give each one a strategy, set the fund-wide rules, then review. The logic lives in
// lib/fund-builder.ts; this component renders it. Nothing here signs or sends a transaction: the mixed composite
// stack is not deployed on BNB Chain mainnet yet, so the review ends with a downloadable design.
import Image from "./Image";
import { createContext, Fragment, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as B from "../lib/fund-builder";
import { chartSvg, type ChartKind } from "../lib/fund-builder-charts";
import type { SupportLine } from "../lib/support-line";

import styles from "./fund-builder.module.css";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "../../components/ui/sheet";
import { useSearchParams } from "react-router-dom";
import FundCoverEditor, { FundCoverPreview } from "./fund-cover-editor";
import FundSourceEditor, { XProfilePreview } from "./x-profile";
import { normalizeXHandle, X_MODEL_DISCLAIMER } from "../lib/x-profile";
import { underlyingSlug } from "../lib/asset-navigation";

const base = "";
const app = "";
// The guided creator: the testnet site's Create page, or /create/testnet/ where examples and testnet share a site.
const testnetCreate = "/create/activate";
const SWATCH = ["var(--ink)", "var(--steel)", "#6F93AE", "#2C7A68", "#8C7A4E", "#9C6F62", "#B7CDDE"];
const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
const assetSrc = (key: string) => base + B.logoPath(key === B.CASH.key ? { category: "crypto", key, symbol: key } : B.assetOf(key));
const venueSrc = (venue: string) => `${base}/logos/${venue === "stake" ? "lista" : venue}.webp`;

// The saved draft is read once on the client; the server and the first client render both see none.
const noSubscribe = () => () => {};
const readDraft = (key: string | null) => {
  if (!key) return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
};

/**
 * The testnet Create page (components/testnet-creator.tsx): the same builder on BNB testnet, either on the sandbox
 * copies of the mainnet holdings (sUSD, mock venues) or on the real venues deployed there (Venus, Aave, Lista,
 * PancakeSwap, test USDT). Review ends by handing the design to the testnet launch instead of a download. The
 * testnet rules come in from the page, so this component imports nothing of the testnet SDK.
 */
export type TestnetMode = {
  /** Asset keys with a testnet route; null while the testnet record loads. */
  offered: ReadonlySet<string> | null;
  /** Whether idle cash can be lent (an idle-cash lending key is admitted). */
  idle: boolean;
  /** True on the sandbox record (copies and mock venues); false on the real venues deployed on testnet. */
  sandbox: boolean;
  /** The accounting asset's symbol. */
  cash: string;
  /** Holding venues a row of this asset may use on testnet. */
  venues: (key: string) => B.Venue[];
  /** Venues idle cash can be lent on; empty when only the sandbox's generic lending vault is admitted. */
  idleVenues: B.LendVenue[];
  /** The (borrow on, lend on) pairs Borrow & earn is admitted with for this asset. */
  carryPairs: (key: string) => [B.LendVenue, B.LendVenue][];
  /** The PancakeSwap ranges Earn fees is admitted with for this asset. */
  lpWidths: (key: string) => B.Settings["lp"]["width"][];
  /** The re-centerings this asset's admitted pool keys of a range run: each key fixes its own for good. */
  lpRecenters: (key: string, width: B.Settings["lp"]["width"]) => B.LpRecenter[];
  /** The first thing that keeps the design from testnet, or "". */
  problem: (state: B.Builder) => string;
  /** Something about the design on testnet that does not stop it (a venue's current limit), or "". */
  notice: (state: B.Builder) => string;
  /** Why a strategy cannot run on this asset on testnet yet, or null. */
  playBlock: (play: B.Play, key: string) => string | null;
  /** Why a whole-fund rule cannot be switched on for a testnet fund yet, or null. */
  ruleBlock: (rule: keyof B.FundRules) => string | null;
  /** What CRE8's keeper can run of each row and each rule that is on (lib/fund-worker-support.ts); null while the record loads. */
  support: (state: B.Builder) => SupportLine[] | null;
  /** The share symbol suggested for a name. */
  symbolFor: (name: string) => string;
  /** The IANA time zone schedule times are in: this browser's, which the design keeps when the creator continues. */
  timeZone: string;
  /** Why testnet funds cannot be created right now (the record did not load), or "". */
  unavailable: string;
  /** Where this browser keeps the testnet design: one per chain and factory; null while the record loads. */
  draftKey: string | null;
  /** Review is done: the launch takes the design from here. */
  start: (state: B.Builder, terms: { fee: number; stake: number; symbol: string }) => void;
};
const Testnet = createContext<TestnetMode | null>(null);
/** Where idle cash is lent on testnet, in words: a named venue, or the sandbox's generic vault. */
const testnetIdle = (t: TestnetMode, venue: B.LendVenue) => B.idleWhere(t.idleVenues, venue);

function Logo({ src, size, className }: { src: string; size: number; className?: string }) {
  return <Image src={src} width={size} height={size} alt="" unoptimized className={cx("logo", className)} />;
}

function Chart({ kind, w, h, mini = false }: { kind: ChartKind; w: number; h: number; mini?: boolean }) {
  const id = "c" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const html = useMemo(() => chartSvg(kind, w, h, mini, (name) => styles[name] ?? name, id), [kind, w, h, mini, id]);
  return <span className={cx(styles.chart, mini && styles.chartMini)} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Seg<T extends string | number | boolean>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (value: T) => void; label: string }) {
  return (
    <span className={styles.seg} role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={String(option)} type="button" aria-pressed={option === value} onClick={() => onChange(option)}>{text}</button>
      ))}
    </span>
  );
}

/** A number typed by hand: kept as typed while it is out of range, brought inside it when the box is left. */
function NumberBox({ label, value, limit, pre, post, onChange }: { label: string; value: number; limit: B.Limit; pre?: string; post?: string; onChange: (value: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const read = (raw: string) => (raw.trim() === "" ? null : Number(raw));
  function commit(raw: string) {
    const next = read(raw);
    if (next !== null && Number.isFinite(next)) onChange(B.clampTo(limit, next));
    setText(null);
  }
  return (
    <span className={styles.numBox}>
      {pre}
      <input type="number" inputMode="decimal" min={limit.min} max={limit.max} step={limit.step ?? 1} value={text ?? value} aria-label={`${label} (${limit.min} to ${limit.max})`}
        onChange={(event) => {
          setText(event.target.value);
          const next = read(event.target.value);
          if (next !== null && B.clampTo(limit, next) === next) onChange(next);
        }}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); }} />
      {post}
    </span>
  );
}

function Range({ label, value, limit, unit, onChange }: { label: string; value: number; limit: B.Limit; unit: Unit; onChange: (value: number) => void }) {
  const top = limit.slide ?? limit.max;
  return (
    <div className={styles.rangeRow}>
      <input type="range" min={limit.min} max={top} step={limit.step ?? 1} value={Math.min(value, top)} aria-label={label} aria-valuetext={`${unit.pre ?? ""}${value}${unit.post}`} onChange={(event) => onChange(Number(event.target.value))} />
      <NumberBox label={label} value={value} limit={limit} pre={unit.pre} post={unit.post} onChange={onChange} />
      {limit.hard && value >= limit.max && <span className={styles.note}>{limit.hard}</span>}
    </div>
  );
}

function Field({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
      {note && <span className={styles.note}>{note}</span>}
    </div>
  );
}

function Beta() {
  return <span className={styles.beta} title="Tested on a local chain; not yet run against BNB Chain protocols on a fork.">Beta</span>;
}

/** A dialog that follows `open`: native modal behavior (focus, Escape, inert page), closed by the parent. */
function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

type Unit = { pre?: string; post: string };
const unit = {
  pct: { post: "%" }, plus: { pre: "+", post: "%" }, minus: { pre: "−", post: "%" }, n: { post: "" }, h: { post: " h" },
  days: { post: " days" }, pm: { pre: "±", post: "%" }, buys: { post: " buys" }, times: { post: " times" }, ltv: { post: "% LTV" }, perDay: { post: " / day" },
} satisfies Record<string, Unit>;

type Drawer = null | { mode: "edit"; id: number };

/**
 * Without props this is the Create page. CRE8 AI embeds it beside its chat: `value`/`onChange` hand the design to the
 * chat, `embedded` drops the page heading, and `flash` highlights the rows a reply just changed.
 */
export default function FundBuilder({ embedded = false, value, onChange, flash = [], testnet = null, headingAction }: {
  embedded?: boolean;
  value?: B.Builder;
  onChange?: (next: B.Builder) => void;
  flash?: readonly number[];
  testnet?: TestnetMode | null;
  headingAction?: ReactNode;
} = {}) {
  // Testnet keeps its own draft: on a site with both pages, a mainnet design can hold assets testnet does not have,
  // and a redeployed testnet factory can admit other venues than the previous one.
  const draftKey = testnet ? testnet.draftKey : B.DRAFT_STORAGE_KEY;
  const mode: B.BuilderMode = testnet ? "execution" : "demo";
  const limits = B.builderLimits(mode);
  const stored = useSyncExternalStore(noSubscribe, () => readDraft(draftKey), () => null);
  const restored = useMemo(() => {
    if (!stored) return null;
    try { return B.reviveBuilder(JSON.parse(stored), mode); } catch { return null; }
  }, [stored, mode]);
  const requestedAsset = useSyncExternalStore(noSubscribe, () => new URLSearchParams(window.location.search).get("asset"), () => null);
  const seeded = useMemo(() => {
    if (!requestedAsset || embedded || testnet) return null;
    const asset = B.ASSETS.find(a => a.key === requestedAsset && B.canPickAsset(a));
    if (!asset) return null;
    const draft = restored ?? EMPTY;
    return draft.rows.some(row => row.key === asset.key) ? draft : B.addAsset(draft, asset.key, mode);
  }, [requestedAsset, embedded, testnet, restored, mode]);
  const [edited, setEdited] = useState<B.Builder | null>(null);
  const state = value ?? edited ?? seeded ?? restored ?? EMPTY;
  const commit = (next: B.Builder) => (onChange ? onChange(next) : setEdited(next));
  const update = (change: (current: B.Builder) => B.Builder) => (onChange ? onChange(change(state)) : setEdited((previous) => change(previous ?? state)));

  const [drawerParams, setDrawerParams] = useSearchParams();
  const readDrawer = (): Drawer => { const id = Number(drawerParams.get("strategy")); return drawerParams.has("strategy") && state.rows.some(row => row.id === id) ? {mode:"edit",id} : null; };
  const [drawer, setDrawerState] = useState<Drawer>(readDrawer);
  const setDrawer = (next: Drawer) => { setDrawerState(next); const params = new URLSearchParams(window.location.search); if(next) params.set("strategy",String(next.id)); else params.delete("strategy"); setDrawerParams(params,{replace:true}); };
  useEffect(() => { setDrawerState(readDrawer()); }, [drawerParams]);
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [query, setQuery] = useState("");
  const [assetTab, setAssetTab] = useState<B.AssetClass>("crypto");
  const [fee, setFee] = useState<number>(B.FEE.default);
  const [stakeText, setStakeText] = useState(String(B.STAKE.default));
  const [agreed, setAgreed] = useState(false);
  const [symbolText, setSymbolText] = useState("");
  const drawerFocus = useRef<HTMLElement | null>(null);
  const pickerRef = useModal(adding);
  const reviewRef = useModal(reviewing);

  // Keep the draft in this browser so a reload does not lose it.
  useEffect(() => {
    const draft = edited ?? seeded;
    if (!draft || !draftKey) return;
    try { window.localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* the draft then lasts this visit only */ }
  }, [edited, seeded, draftKey]);

  const keys = B.assetKeys(state.rows);
  const issue = testnet ? testnet.problem(state) : B.problem(state, mode);
  const sourceIssue = state.xHandle?.trim() && !normalizeXHandle(state.xHandle) ? "Enter a valid X handle." : state.collection === "x-voices" && !normalizeXHandle(state.xHandle) ? "Add the X handle that inspired this index." : "";
  const notice = testnet ? testnet.notice(state) : "";
  const cashName = testnet ? testnet.cash : B.CASH.symbol;
  const symbol = symbolText || (testnet ? testnet.symbolFor(state.name) : "");
  const symbolValid = /^[A-Z0-9]{1,16}$/.test(symbol);
  const cash = B.cashShare(state.rows);
  const room = B.capacity(state);
  const roomUsed = Math.min(100, Math.round(Math.max(room.positions / limits.positions, testnet ? room.gas / B.JOIN_LIMIT : 0) * 100));
  const color = (key: string) => SWATCH[keys.indexOf(key) % SWATCH.length];
  const editing = drawer?.mode === "edit" ? state.rows.find((row) => row.id === drawer.id) ?? null : null;
  const previews = keys.map(B.assetOf).filter(B.isPlanningOnly);
  const stake = Math.max(B.STAKE.min, Math.round(Number(stakeText) || 0));
  const stakeValid = Number(stakeText) >= B.STAKE.min;
  // Testnet review only: what CRE8's keeper can run of the design, row by row and rule by rule.
  const keeperLines = reviewing && testnet ? testnet.support(state) : null;

  function openAdd() {
    setQuery("");
    setAdding(true);
  }
  function pick(key: string) {
    if (testnet ? !B.canAdd(B.assetOf(key)) || !testnet.offered?.has(key) : !B.canPickAsset(B.assetOf(key)) && !state.rows.some(row => row.key === key)) return;
    const next = B.addAsset(state, key, mode);
    if (next === state) return;
    commit(next);
    setAdding(false);
    // The new row is the one with the id the state handed out.
    setDrawer({ mode: "edit", id: state.nextId });
  }
  function openReview() {
    setAgreed(false);
    setReviewing(true);
  }
  function download() {
    const design = B.fundDesign(state, { fee, stake }, new Date().toISOString(), mode);
    const blob = new Blob([JSON.stringify(design, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url;
    link.download = `cre8-fund-${(design.name || "design").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design"}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Testnet.Provider value={testnet}>
    <Shell embedded={embedded}>
      {!embedded && (
        <div className={styles.head}>
          <h1>Create a fund</h1>
          <p>
            Choose holdings and a strategy for each asset.
            {testnet && (testnet.sandbox
              ? <> On BNB Chain testnet every asset is a sandbox copy at its real price, paid for with free {testnet.cash}.</>
              : <> On BNB Chain testnet the fund runs on Venus, Aave, Lista and PancakeSwap deployed there, with test tokens at their real prices, paid for with free test {testnet.cash}.</>)}
          </p>
          {headingAction && <div className={styles.headAction}>{headingAction}</div>}
          {testnet?.unavailable && <p className={styles.issue} role="alert">{testnet.unavailable}</p>}
        </div>
      )}

      <div className={styles.grid}>
        <div className={styles.main}>
          <FundCoverEditor value={state.cover} name={state.name} onNameChange={name => update(s => ({ ...s, name }))} onChange={cover => update(s => {
            const next = { ...s }; if (cover) next.cover = cover; else delete next.cover; return next;
          })} />
          <FundSourceEditor state={state} onChange={commit} />
          <section className={styles.panel} aria-label="Holdings">
            <div className={styles.ptop}>
              <h2>Holdings</h2>
              <span className={styles.label}>{keys.length} of {limits.assets} assets</span>
            </div>
            {state.rows.length === 0 ? (
              <div className={styles.empty}>
                <button className={cx("btn", "sm", styles.lineBtn)} type="button" onClick={openAdd} disabled={!!testnet && !testnet.offered}>{testnet && !testnet.offered ? "Reading the testnet catalog…" : "+ Add asset"}</button>
              </div>
            ) : (
              <>
                <div className={styles.thead} aria-hidden="true"><span className={styles.label}>Asset</span><span className={styles.label}>Share</span><span className={styles.label}>Strategy</span><span /></div>
                <ul className={styles.rows}>
                  {state.rows.map((row) => {
                    const asset = B.assetOf(row.key), twins = state.rows.filter((other) => other.key === row.key);
                    const nth = twins.findIndex((other) => other.id === row.id) + 1;
                    return (
                      <li key={row.id} className={cx(styles.row, flash.includes(row.id) && styles.flash)} data-flash={flash.includes(row.id) || undefined}>
                        <div className={styles.who}>
                          <Logo src={assetSrc(asset.key)} size={32} className={styles.logo32} />
                          <span>
                            <b><a className={styles.assetInfo} href={`${app}/asset/${underlyingSlug(asset)}/?returnTo=${encodeURIComponent(`${base}/create/`)}`} target="_blank" rel="noopener noreferrer" aria-label={`About ${asset.name} (opens a new tab)`}>{asset.name} ↗</a>{twins.length > 1 && <span className={styles.slice}>{nth === 1 ? "Core" : `Slice ${nth}`}</span>}</b>
                            <small>{B.displayAssetSymbol(asset.symbol)}{asset.issuer === "ondo" && " · Ondo"}{testnet && asset.status !== "ready" && <span className={styles.pending} title={B.STATUS_DETAIL[asset.status]}> · Pending</span>}</small>
                          </span>
                        </div>
                        <div className={styles.shareCell}>
                          <label className={cx(styles.share, row.auto && styles.shareAuto)}>
                            <input type="number" min={1} max={100 - B.cashMin(state.rows)} value={row.share} aria-label={`${asset.name} share of the fund`} onChange={(event) => { const value = Number(event.target.value); update((s) => B.setShare(s, row.id, value)); }} />
                            <span>%</span>
                          </label>
                          {row.auto && <small>Auto</small>}
                        </div>
                        <button type="button" className={styles.strat} aria-label={`Strategy for ${asset.name}: ${B.PLAYS[row.play].name}. Edit`} onClick={() => setDrawer({ mode: "edit", id: row.id })}>
                          <Chart kind={row.play} w={76} h={34} mini />
                          <span><b>{B.PLAYS[row.play].name}{B.rowBeta(row) && <Beta />}</b><small>{B.summary(row, testnet?.timeZone)}</small></span>
                          <span className={styles.go} aria-hidden="true">Edit</span>
                        </button>
                        <button type="button" className={styles.x} aria-label={`Remove ${asset.name}`} onClick={() => update((s) => B.removeRow(s, row.id))}>×</button>
                      </li>
                    );
                  })}
                </ul>
                <div className={styles.cashRow}>
                  <Logo src={assetSrc(B.CASH.key)} size={22} className={styles.logo22} />
                  <span><b>Cash buffer</b> · <span className={styles.num}>{cash}%</span> {cashName}{state.rules.idle.on ? (testnet ? `, lent ${testnetIdle(testnet, state.rules.idle.venue)} while it waits` : `, lent on ${B.VENUE_NAME[state.rules.idle.venue]} while it waits`) : ""}. {B.cashMin(state.rows) ? `Minimum ${B.cashMin(state.rows)}% because the fund borrows.` : "No minimum: a fund that does not borrow can invest all of it."}</span>
                </div>
                <div className={styles.foot}>
                  <button className={cx("btn", "sm", styles.lineBtn)} type="button" onClick={openAdd} disabled={keys.length >= limits.assets}>+ Add asset</button>
                  {state.rows.some((row) => row.auto) ? <span className={styles.note}>Shares marked Auto split the rest evenly until you set them.</span>
                    : <button type="button" className={styles.softBtn} onClick={() => update(B.splitEvenly)}>Split evenly</button>}
                  <button type="button" className={styles.clear} onClick={() => { if (window.confirm("Clear this fund design and start over?")) commit(B.emptyBuilder()); }}>Start over</button>
                </div>
              </>
            )}
          </section>

          {state.rows.length > 0 && <Rules state={state} update={update} />}
        </div>

        <aside className={cx(styles.panel, styles.side)} aria-label="Summary">
          <div className={styles.sec}>
            <span className={styles.label}>Allocation</span>
            <div className={styles.bar} role="img" aria-label={state.rows.length ? [...keys.map((key) => `${B.assetOf(key).name} ${state.rows.filter((row) => row.key === key).reduce((sum, row) => sum + row.share, 0)}%`), `Cash ${cash}%`].join(", ") : "No assets yet"}>
              {state.rows.length > 0 && <>
                {keys.map((key) => <span key={key} style={{ width: `${Math.min(100, state.rows.filter((row) => row.key === key).reduce((sum, row) => sum + row.share, 0))}%`, background: color(key) }} />)}
                <span className={styles.cashBar} style={{ width: `${cash}%` }} />
              </>}
            </div>
            {state.rows.length ? (
              <div className={styles.legend}>
                {keys.map((key) => (
                  <div key={key}><i style={{ background: color(key) }} /><Logo src={assetSrc(key)} size={18} className={styles.logo18} /><span>{B.assetOf(key).name}</span><b>{state.rows.filter((row) => row.key === key).reduce((sum, row) => sum + row.share, 0)}%</b></div>
                ))}
                <div><i className={styles.cashBar} /><Logo src={assetSrc(B.CASH.key)} size={18} className={styles.logo18} /><span>Cash buffer</span><b>{cash}%</b></div>
              </div>
            ) : <p className={styles.note}>Your allocation shows here as you add assets.</p>}
          </div>
          <div className={styles.sec}>
            <dl className={styles.kv}>
              <div><dt>Lending income</dt><dd className={styles.posText}>{!state.rows.length ? "—" : testnet ? (state.rules.idle.on ? (testnet.idleVenues.includes(state.rules.idle.venue) ? B.VENUE_NAME[state.rules.idle.venue] : "Sandbox lending vault") : "None") : B.lendingIncome(state) > 0 ? `≈ ${B.pct(B.lendingIncome(state))} / yr` : "None"}</dd></div>
              <div><dt>Strategies</dt><dd>{state.rows.length ? `${state.rows.length} on assets${B.rulesOn(state.rules).length ? ` + ${B.rulesOn(state.rules).length} fund-wide` : ""}` : "—"}</dd></div>
              <div><dt title="Every deposit has to fit in one BNB Chain transaction, which limits how many positions a fund runs.">Room used</dt><dd>{state.rows.length ? `${roomUsed}% · ${room.positions} of ${limits.positions} positions` : "—"}</dd></div>
              <div><dt>Deposit fee</dt><dd>{B.FEE.depositPct}% · to CRE8</dd></div>
              <div><dt>Performance fee</dt><dd>CRE8 {B.FEE.platform}% + yours</dd></div>
            </dl>
            {(issue || sourceIssue) && <p className={styles.issue} role="status">{issue || sourceIssue}</p>}
            {notice && <p className={styles.note} role="status">{notice}</p>}
            <button className={cx("btn", styles.wide)} type="button" disabled={!state.rows.length || !!issue || !!sourceIssue} onClick={openReview}>Review fund</button>
          </div>
        </aside>
      </div>

      {/* Choosing an asset is a centered dialog; its strategy then opens in the side panel. */}
      <dialog ref={pickerRef} className={styles.picker} aria-label="Add asset" onClose={() => setAdding(false)} onClick={(event) => { if (event.target === event.currentTarget) setAdding(false); }}>
        {adding && <AddAsset state={state} query={query} setQuery={setQuery} tab={assetTab} setTab={setAssetTab} pick={pick} close={() => setAdding(false)} />}
      </dialog>

      <Sheet open={drawer !== null} onOpenChange={(open) => { if(!open) setDrawer(null); }}><SheetContent side="right" showCloseButton={false} className={cx(styles.drawer,"public-builder-strategy p-0")} onOpenAutoFocus={() => { drawerFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={(event) => { if(drawerFocus.current?.isConnected) {event.preventDefault();drawerFocus.current.focus();} }}><SheetTitle className="sr-only">{editing ? B.assetOf(editing.key).name + " strategy" : "Strategy"}</SheetTitle><SheetDescription className="sr-only">Choose a strategy for this asset.</SheetDescription>
        {editing && <EditRow row={editing} state={state} update={update} close={() => setDrawer(null)} split={() => { const next = B.addSlice(state, editing.id, mode); if (next === state) return; commit(next); setDrawer({ mode: "edit", id: next.nextId - 1 }); }} />}
      </SheetContent></Sheet>

      <dialog ref={reviewRef} className={styles.modal} aria-labelledby="review-title" onClose={() => setReviewing(false)} onClick={(event) => { if (event.target === event.currentTarget) setReviewing(false); }}>
        {reviewing && (
          <div className={styles.modalBody}>
            <div className={styles.modalTop}>
              <div><span className={styles.tag}>For fund creators</span><h2 id="review-title">Review your fund</h2></div>
              <button className={styles.x} type="button" aria-label="Close" onClick={() => setReviewing(false)}>×</button>
            </div>
            <label className={styles.field}><span className={styles.label}>Fund name</span>
              <input className={styles.bigInput} type="text" maxLength={64} value={state.name} placeholder="Name your fund" onChange={(event) => { const name = event.target.value; update((s) => ({ ...s, name })); }} />
            </label>
            {testnet && (
              <label className={styles.field}><span className={styles.label}>Share symbol</span>
                <input className={styles.bigInput} type="text" maxLength={16} value={symbol} spellCheck={false} onChange={(event) => setSymbolText(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
                <span className={styles.note}>{symbolValid ? "Holders' shares carry this ticker." : "Up to 16 capital letters or digits."}</span>
              </label>
            )}
            <div className={styles.field}><span className={styles.label}>Your performance fee</span>
              <div className={styles.feeLine}><input type="range" min={B.FEE.min} max={B.FEE.max} step={1} value={fee} aria-label="Your performance fee" onChange={(event) => setFee(Number(event.target.value))} /><b>{fee}%</b></div>
              <span className={styles.note}>CRE8 adds {B.FEE.platform}%, so holders pay {fee + B.FEE.platform}% of their realized profit when they withdraw.</span>
            </div>
            <label className={styles.field}><span className={styles.label}>Your stake · {cashName}</span>
              <input className={styles.bigInput} type="number" min={B.STAKE.min} step={B.STAKE.step} value={stakeText} onChange={(event) => setStakeText(event.target.value)} />
              <span className={styles.note}>{stakeValid ? `The fund can take up to ${(stake * B.STAKE.capacityMultiple).toLocaleString("en-US")} ${cashName} in deposits. You keep at least 2% of the fund while others are in.` : `The minimum stake is ${B.STAKE.min} ${cashName}.`}</span>
            </label>
            <FundCoverPreview cover={state.cover} name={state.name} />
            {state.xHandle && <XProfilePreview handle={state.xHandle} />}
            {state.collection === "x-voices" && <p className={styles.note}>{X_MODEL_DISCLAIMER}</p>}
            <div className={styles.field}><span className={styles.label}>Holders will read</span>
              <div className={styles.quote}>
                <p><b>{state.name.trim() || "Your fund"}</b> holds:</p>
                {state.rows.map((row) => { const words = B.sentence(row, testnet?.timeZone); return <p key={row.id}><b>{words.lead}</b>{words.text}</p>; })}
                <p>{B.fundSentences(state, testnet ? { cash: testnet.cash, idle: testnetIdle(testnet, state.rules.idle.venue) } : {}).join(" ")}</p>
              </div>
              {B.launchPriceNote(state.rows) && <span className={styles.note}>{B.launchPriceNote(state.rows)}</span>}
            </div>
            {testnet && keeperLines && (
              <div className={styles.field}><span className={styles.label}>What CRE8&apos;s keeper can run</span>
                <ul className={styles.support}>
                  {keeperLines.map((line) => (
                    <li key={line.key} data-verdict={line.verdict}><b>{line.subject}</b><span>{line.text}</span>{line.note && <small>{line.note}</small>}</li>
                  ))}
                </ul>
                <span className={styles.note}>No CRE8 keeper runs testnet funds yet, so until one does the fund keeps your stake in {testnet.cash}. This is what it can run once it does.</span>
              </div>
            )}
            <div className={styles.field}><span className={styles.label}>Fixed once the fund is live</span>
              <span className={styles.fixed}>{B.fixedOnceLive(state).join(" · ")}</span>
              <span className={styles.note}>New deposits buy into every asset in its current proportions.</span>
            </div>
            {testnet && state.rows.some((row) => B.assetOf(row.key).category === "stock" && B.assetOf(row.key).issuer !== "ondo" && !B.isPlanningOnly(B.assetOf(row.key))) && (testnet.sandbox
              ? <p className={styles.notice}>On testnet the stock copies are priced by CRE8&apos;s sandbox feed, which follows the real price every 10 minutes. On mainnet they are priced by their PancakeSwap pool&apos;s 30-minute average.</p>
              : <p className={styles.notice}>Stocks are priced by their PancakeSwap pool&apos;s 30-minute average, not an oracle. A trade waits whenever the pool is more than 1% away from that average.</p>
            )}
            {testnet && <label className={styles.consent}><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><span>{B.consent(state)}</span></label>}
            {testnet ? <>
              <div className={styles.launch}>
                <b>Runs on BNB Chain testnet.</b>
                <span>{testnet.sandbox ? "Every asset is a sandbox copy at its real price" : "Every token is a test token at its real price, on the protocols' own code deployed on testnet"}, and nothing here has real value. Next you sign each setup step in your wallet (a little testnet BNB pays the gas), CRE8 reviews the fund, and you open it with your stake of free {testnet.cash}.</span>
              </div>
              <button className={cx("btn", styles.wide)} type="button" disabled={!agreed || !state.name.trim() || !stakeValid || !symbolValid || !!testnet.unavailable || !!issue || !!sourceIssue} onClick={() => { setReviewing(false); testnet.start(state, { fee, stake, symbol }); }}>Continue to setup</button>
              {(!state.name.trim() || !stakeValid || !symbolValid) && <span className={styles.note}>{!state.name.trim() ? "Give your fund a name to continue." : !stakeValid ? `Set a stake of at least ${B.STAKE.min} ${testnet.cash}.` : "Choose a share symbol."}</span>}
            </> : <>
              <button className={cx("btn", styles.wide)} type="button" disabled={!state.name.trim() || !stakeValid || !!sourceIssue} onClick={download}>Download design</button>
              {(!state.name.trim() || !stakeValid) && <span className={styles.note}>{!state.name.trim() ? "Give your fund a name to continue." : `Set a stake of at least ${B.STAKE.min} USDT.`}</span>}
              {previews.length === 0 && !B.problem(state) && <a className={styles.textLink} href={testnetCreate}>Activate a target-weight strategy →</a>}
            </>}
            <div className={styles.field}><span className={styles.label}>At launch</span>
              <ol className={styles.steps}>
                <li><span className={styles.n}>1</span><b>Set up the fund</b><small>Creates your fund&apos;s contracts.</small></li>
                <li><span className={styles.n}>2</span><b>Save your strategies</b><small>Writes each asset, its share and its rules.</small></li>
                <li><span className={styles.n}>3</span><b>Deposit your stake</b><small>CRE8 reviews new funds{testnet ? "" : " (about 24 hours)"}, then you deposit {stake.toLocaleString("en-US")} {cashName} and the fund opens.</small></li>
              </ol>
            </div>
          </div>
        )}
      </dialog>
    </Shell>
    </Testnet.Provider>
  );
}

/** The Create page is a page; beside the CRE8 AI chat the builder is a panel that sizes to its column. */
function Shell({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  return embedded ? <div className={cx(styles.page, styles.embedded)}>{children}</div> : <main className={cx("wrap", styles.page)}>{children}</main>;
}

const EMPTY = B.emptyBuilder();
type Update = (change: (current: B.Builder) => B.Builder) => void;

const ASSET_TABS = [["crypto", "Crypto"], ["stock", "Stock"], ["rwa", "RWA"]] as const;
function AddAsset({ state, query, setQuery, tab, setTab, pick, close }: { state: B.Builder; query: string; setQuery: (value: string) => void; tab: B.AssetClass; setTab: (value: B.AssetClass) => void; pick: (key: string) => void; close: () => void }) {
  const testnet = useContext(Testnet);
  const tabsId = useId();
  const have = new Set(B.assetKeys(state.rows)), q = query.trim().toLowerCase();
  const match = (asset: B.Asset, text: string) => !text || `${asset.key} ${asset.name} ${B.assetPickerName(asset)} ${asset.symbol} ${B.displayAssetSymbol(asset.symbol)} ${asset.issuer ?? (asset.category === "stock" ? "bstock" : "")} ${B.classifyAsset(asset).searchTerms}`.toLowerCase().includes(text);
  // Ondo identities may be planned in the App. Testnet still offers only its deployed sandbox copies.
  const available = B.ASSETS.filter((asset) => testnet ? B.canAdd(asset) && !!testnet.offered?.has(asset.key) : B.canPickAsset(asset))
    .map(asset => testnet ? asset : B.stockSourceInDesign(asset, state.rows));
  const open = available.filter(asset => match(asset, q));
  function search(value: string) {
    setQuery(value);
    const text = value.trim().toLowerCase(), matches = available.filter(asset => match(asset, text));
    if (text && matches.length) {
      const exact = matches.find(asset => [asset.key, asset.symbol, B.displayAssetSymbol(asset.symbol), B.assetPickerName(asset)].some(name => name.toLowerCase() === text));
      if (exact) setTab(B.classifyAsset(exact).assetClass);
      else if (!matches.some(asset => B.classifyAsset(asset).assetClass === tab)) setTab(B.classifyAsset(matches[0]).assetClass);
    }
  }
  function selectTab(value: B.AssetClass) { setTab(value); setQuery(""); }
  const enabledTabs = ASSET_TABS.filter(([key]) => available.some(asset => B.classifyAsset(asset).assetClass === key));
  const groups: [string, string, B.Asset[]][] = testnet ? [
    ["Crypto", testnet.sandbox ? "Sandbox copies of the mainnet tokens, at their real prices." : "Test tokens at their real prices, on testnet's Venus, Aave, Lista and PancakeSwap.", open.filter((asset) => asset.category === "crypto")],
    ["US stocks", testnet.sandbox ? "Sandbox copies of the tokenized shares (bStocks), at their real prices." : "Test copies of the tokenized shares (bStocks), priced by their own PancakeSwap pool like on mainnet.", open.filter((asset) => asset.category === "stock")],
  ] : [
    ["Crypto", "", open.filter((asset) => B.classifyAsset(asset).assetClass === "crypto")],
    ["US stocks · bStock", "", open.filter((asset) => B.classifyAsset(asset).assetClass === "stock" && asset.issuer !== "ondo").sort((a, b) => Number(B.hasStockLiquidity(b)) - Number(B.hasStockLiquidity(a)))],
    ["US stocks · Ondo", "", open.filter((asset) => B.classifyAsset(asset).assetClass === "stock" && asset.issuer === "ondo")],
    ["RWA", "", open.filter((asset) => B.classifyAsset(asset).assetClass === "rwa").sort((a, b) => B.rwaPickerOrder(a) - B.rwaPickerOrder(b) || a.name.localeCompare(b.name))],
  ];
  const mode: B.BuilderMode = testnet ? "execution" : "demo", limits = B.builderLimits(mode);
  const full = have.size >= limits.assets, positions = B.positionsFull(state, mode);
  return (
    <>
      <div className={styles.dHead}>
        <div><h2>Add asset</h2><small>{have.size} of {limits.assets} assets · {B.capacity(state).positions} of {limits.positions} positions</small></div>
        <button className={styles.x} type="button" aria-label="Close" onClick={close}>×</button>
      </div>
      <div className={styles.dBody}>
        <div className={styles.pickerTabs} role="tablist" aria-label="Asset categories">
          {ASSET_TABS.map(([key, title]) => <button key={key} id={`${tabsId}-${key}-tab`} type="button" role="tab" aria-selected={tab === key} aria-controls={`${tabsId}-${key}-panel`} tabIndex={tab === key ? 0 : -1} disabled={!enabledTabs.some(([value]) => value === key)} onClick={() => selectTab(key)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = enabledTabs.findIndex(([value]) => value === key), nextIndex = event.key === "Home" ? 0 : event.key === "End" ? enabledTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + enabledTabs.length) % enabledTabs.length;
            const next = enabledTabs[nextIndex][0]; selectTab(next); document.getElementById(`${tabsId}-${next}-tab`)?.focus();
          }}>{title}<small>{open.filter(asset => B.classifyAsset(asset).assetClass === key).length}</small></button>)}
        </div>
        <input className={styles.search} type="search" placeholder="Search name or symbol" aria-label="Search assets" value={query} onChange={(event) => search(event.target.value)} autoFocus />
        {ASSET_TABS.map(([key]) => <div key={key} id={`${tabsId}-${key}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${key}-tab`} hidden={tab !== key} tabIndex={0}>
        {tab === key && groups.filter(([, , items]) => items.length > 0 && B.classifyAsset(items[0]).assetClass === key).map(([title, line, items]) => (
          <div key={title}>
            <div className={styles.groupHead}><b>{title}</b><span>{line}</span></div>
            <div className={cx(styles.assets, key === "rwa" && styles.rwaAssets)}>
              {items.map((asset) => {
                const venues = testnet ? testnet.venues(asset.key).filter((v): v is B.LendVenue => v !== "hold" && v !== "stake") : B.venuesOf(asset), added = have.has(asset.key);
                return (
                  <div className={styles.assetChoice} key={asset.key}><button type="button" disabled={positions || (full && !added) || (!!testnet && added && B.isPlanningOnly(asset))} onClick={() => pick(asset.key)} aria-label={`${B.assetPickerName(asset)}, ${B.displayAssetSymbol(asset.symbol)}${B.assetPickerName(asset) !== asset.name ? `, ${asset.name}` : ""}${asset.issuer === "ondo" ? ", Ondo" : ""}${added ? ", already in the fund: add another strategy" : ""}${venues.length ? `, earns on ${venues.map((venue) => B.VENUE_NAME[venue]).join(", ")}` : ""}${asset.status === "history" ? ", price history pending" : ""}`}>
                    <Logo src={assetSrc(asset.key)} size={28} className={styles.logo28} />
                    <span><b title={asset.name}>{B.assetPickerName(asset)}</b><small>{added ? `${B.displayAssetSymbol(asset.symbol)} · Added` : asset.status === "history" ? `${B.displayAssetSymbol(asset.symbol)} · pending` : B.displayAssetSymbol(asset.symbol)}</small></span>
                    {!testnet && B.classifyAsset(asset).assetClass === "stock" && <span className={styles.liquidityDot} data-verified={asset.issuer !== "ondo" && B.hasStockLiquidity(asset)} title={`${B.hasStockLiquidity(asset) ? "Liquidity checked" : "Liquidity data pending"} · ${B.STOCK_LIQUIDITY_CHECKED_AT.slice(0, 10)}`} aria-hidden="true" />}
                    {venues.length > 0 && <span className={styles.venueLogos} title={`Earns on ${venues.map((venue) => B.VENUE_NAME[venue]).join(", ")}`}>{venues.map((venue) => <Logo key={venue} src={venueSrc(venue)} size={18} className={styles.logo18} />)}</span>}
                  </button><a className={styles.assetChoiceInfo} href={`${app}/asset/${underlyingSlug(asset)}/?returnTo=${encodeURIComponent(`${base}/create/`)}`} target="_blank" rel="noopener noreferrer" aria-label={`About ${asset.name} (opens a new tab)`}>ⓘ</a></div>
                );
              })}
            </div>
          </div>
        ))}</div>)}
        {positions && <p className={styles.notice}>All {limits.positions} positions are in use. Remove a row, or turn off earning on idle cash, to add another.</p>}
        {!open.length && <p className={styles.note}>Nothing matches the available assets.</p>}
        {testnet && <p className={styles.note}>{testnet.sandbox ? "Each asset is a sandbox token on BNB Chain testnet with no value. CRE8 sets its price to the real one every 10 minutes, and the fund trades it on a sandbox pool." : "Each asset is a test token on BNB Chain testnet with no value, priced by Chainlink's testnet feed (stocks by their pool), and traded on PancakeSwap's testnet pools."}</p>}
      </div>
    </>
  );
}

function EditRow({ row, state, update, close, split }: { row: B.Row; state: B.Builder; update: Update; close: () => void; split: () => void }) {
  const testnet = useContext(Testnet);
  const asset = B.assetOf(row.key), words = B.sentence(row, testnet?.timeZone);
  // On testnet an Earn fees row re-centers only as an admitted pool key of its range does (the key fixes it for good):
  // after each change its re-centering moves onto the nearest such key's.
  const set = (field: string, value: unknown) => update((s) => {
    const next = B.setSetting(s, row.id, field, value);
    return testnet ? B.fitRecenter(next, row.id, testnet.lpRecenters) : next;
  });
  const room = B.capacity(state);
  const settingsRef = useRef<HTMLDivElement>(null);
  const sources = !testnet ? B.stockSourceChoices(asset) : [];
  const recommendation = sources.length > 1 ? B.stockSourceRecommendation(asset) : null;
  // Cards sit two to a row; the chosen strategy's settings open right under its row, pointing at its card.
  const chosen = B.PLAY_ORDER.indexOf(row.play), rowEnd = Math.min(B.PLAY_ORDER.length - 1, chosen | 1);
  function choose(play: B.Play) {
    update((s) => {
      const next = B.setPlay(s, row.id, play, testnet ? "execution" : "demo");
      // A new Earn fees row starts on a re-centering its range's testnet pool keys run.
      return testnet ? B.fitRecenter(next, row.id, testnet.lpRecenters) : next;
    });
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.requestAnimationFrame(() => settingsRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" }));
  }
  return (
    <>
      <div className={styles.dHead}>
        <Logo src={assetSrc(asset.key)} size={40} className={styles.logo40} />
        <div><h2>{asset.name}</h2><small>{B.displayAssetSymbol(asset.symbol)}{asset.category !== "crypto" ? ` · ${B.classifyAsset(asset).label}` : ""}{testnet && asset.status !== "ready" ? ` · ${B.STATUS_TEXT[asset.status]}` : ""}</small></div>
        <label className={cx(styles.share, styles.dShare)}>
          <input type="number" min={1} max={100 - B.cashMin(state.rows)} value={row.share} aria-label="Share of the fund" onChange={(event) => { const value = Number(event.target.value); update((s) => B.setShare(s, row.id, value)); }} />
          <span>%</span>
        </label>
        <button className={styles.x} type="button" aria-label="Close" onClick={close}>×</button>
      </div>
      <div className={styles.dBody}>
        {recommendation && <div className={styles.field}>
          <span className={styles.label}>Stock source</span>
          <Seg label="Stock source" value={asset.issuer ?? "bstock"} options={sources.map(source => [source.issuer ?? "bstock", `${source.issuer === "ondo" ? "Ondo" : "bStock"}${(source.issuer ?? "bstock") === recommendation.issuer ? " · preferred" : ""}`] as ["bstock" | "ondo", string])} onChange={issuer => update(s => B.switchStockSource(s, row.key, issuer, row.id, "demo"))} />
        </div>}
        <div>
          <span className={styles.label}>Strategy</span>
          <div className={styles.plays} role="group" aria-label="Strategy">
            {B.PLAY_ORDER.map((play, index) => {
              const block = (testnet?.playBlock(play, asset.key) ?? null) || B.playBlock(play, asset, testnet ? "execution" : "demo");
              const preview = { ...row, play, p: B.defaults(play) } as B.Row;
              return (
                <Fragment key={play}>
                  <button type="button" className={styles.play} aria-pressed={row.play === play} disabled={!!block} onClick={() => choose(play)}>
                    <Chart kind={play} w={220} h={84} />
                    <b>{B.PLAYS[play].name}{B.rowBeta(preview) && <Beta />}</b>
                    <small>{block ?? B.PLAYS[play].line}</small>
                  </button>
                  {index === rowEnd && (
                    <div className={styles.settings} data-side={chosen % 2 ? "right" : "left"} ref={settingsRef} role="region" aria-label={`${B.PLAYS[row.play].name} settings`}>
                      <Settings row={row} set={set} />
                      {testnet && B.settingWarnings(row).map((warning) => <p key={warning} className={styles.notice}>{warning}</p>)}
                      <div className={styles.explain}><b>{words.lead}</b>{words.text}</div>
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
        {testnet && <p className={styles.note}>Charts illustrate how each strategy trades. They are not past results.</p>}
      </div>
      <div className={styles.dFoot}>
        <button className={cx("btn", "sm", styles.lineBtn)} type="button" onClick={split} disabled={(!!testnet && B.isPlanningOnly(asset)) || room.positions >= B.builderLimits(testnet ? "execution" : "demo").positions || row.share < 2} title="Give this asset a second strategy with half of its share.">+ Another strategy</button>
        <button className="btn sm" type="button" onClick={close}>Done</button>
      </div>
    </>
  );
}

/** One batched request of read calls; null when any answer is missing. */
function ethCalls(calls: { to: string; data: string }[]): Promise<string[] | null> {
  return fetch(B.PRICE_RPC, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify(calls.map((call, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [call, "latest"] }))),
  }).then((response) => response.json() as Promise<{ id?: unknown; result?: unknown }[]>).then((answers) => {
    if (!Array.isArray(answers)) return null;
    const results = calls.map((_, id) => answers.find((answer) => answer.id === id)?.result);
    return results.every((result) => typeof result === "string") ? (results as string[]) : null;
  }).catch(() => null);
}
/** A read cached for a minute; a failed one can be tried again. */
const reads = new Map<string, { at: number; value: Promise<unknown> }>();
function cachedRead<T>(key: string, read: () => Promise<T | null>): Promise<T | null> {
  const cached = reads.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.value as Promise<T | null>;
  const value = read();
  reads.set(key, { at: Date.now(), value });
  value.then((result) => { if (result === null) reads.delete(key); });
  return value;
}
// Whether each lending market takes deposits now.
function readRoom(venue: B.LendVenue, market: string): Promise<boolean | null> {
  const calls = B.roomCalls(venue, market);
  return cachedRead(`room:${venue}:${market}`, async () => (calls ? (await ethCalls(calls).then((results) => (results ? B.decodeRoom(venue, results) : null))) : null));
}
// USDT that can be borrowed now on each market a borrowing position may use.
function readBorrowRoom(venue: B.LendVenue, key: string): Promise<bigint | null> {
  const calls = B.borrowCalls(venue, key);
  return cachedRead(`borrow:${venue}:${venue === "lista" ? key : ""}`, async () => (calls ? (await ethCalls(calls).then((results) => (results ? B.decodeBorrowRoom(venue, results) : null))) : null));
}
function useBorrowRoom(asset: B.Asset): Map<B.LendVenue, number> {
  const [room, setRoom] = useState<{ key: string; venues: Map<B.LendVenue, number> }>({ key: "", venues: new Map() });
  useEffect(() => {
    let live = true;
    const venues = asset.borrow ?? [];
    Promise.all(venues.map((venue) => readBorrowRoom(venue, asset.key).then((raw) => [venue, raw] as const))).then((found) => {
      if (!live) return;
      const out = new Map<B.LendVenue, number>();
      for (const [venue, raw] of found) if (raw !== null) out.set(venue, Number(raw / 10n ** 15n) / 1000);
      setRoom({ key: asset.key, venues: out });
    });
    return () => { live = false; };
  }, [asset]);
  return room.key === asset.key ? room.venues : new Map();
}
/** Markets of `asset` known to be full right now. */
function useFullMarkets(asset: B.Asset): Set<B.LendVenue> {
  const [full, setFull] = useState<{ key: string; venues: Set<B.LendVenue> }>({ key: "", venues: new Set() });
  useEffect(() => {
    let live = true;
    const venues = Object.entries(asset.market ?? {}) as [B.LendVenue, string][];
    Promise.all(venues.map(([venue, market]) => readRoom(venue, market).then((room) => (room === false ? venue : null)))).then((found) => {
      if (live) setFull({ key: asset.key, venues: new Set(found.filter((venue): venue is B.LendVenue => venue !== null)) });
    });
    return () => { live = false; };
  }, [asset]);
  return full.key === asset.key ? full.venues : new Set();
}

/** On Venus the collateral is supplied to the asset's own market, so a full supply cap stops borrowing too. */
function CarryRoom({ asset, venue }: { asset: B.Asset; venue: B.LendVenue }) {
  const full = useFullMarkets(asset);
  if (venue !== "venus" || !full.has("venus")) return null;
  return <p className={styles.notice}>Venus&apos;s {B.displayAssetSymbol(asset.symbol)} market is full right now, so it can&apos;t take {asset.name} as collateral until it has room again.</p>;
}

/** How much USDT each borrowing market can lend now, read live; a market with little left is flagged. */
function BorrowOn({ asset, value, set }: { asset: B.Asset; value: B.LendVenue; set: (field: string, value: unknown) => void }) {
  const borrow = asset.borrow ?? [], room = useBorrowRoom(asset), left = room.get(value);
  return (
    <Field label="Borrow USDT on" note={left !== undefined ? `About ${B.compactUsd(left)} USDT can be borrowed there now${value === "lista" ? " (this Lista market alone)" : ""}.` : undefined}>
      <Seg label="Borrow on" value={value} options={borrow.map((venue) => [venue, room.has(venue) ? `${B.VENUE_NAME[venue]} · ${B.compactUsd(room.get(venue)!)}` : B.VENUE_NAME[venue]] as [B.LendVenue, string])} onChange={(next) => set("borrowOn", next)} />
      {left !== undefined && left < B.BORROW_ROOM_LOW && <span className={styles.notice}>Only about {B.compactUsd(left)} can be borrowed on {B.VENUE_NAME[value]} right now, so a fund would borrow little or nothing there.</span>}
      {B.BORROW_NOTE[asset.key] && <span className={styles.note}>{B.BORROW_NOTE[asset.key]}</span>}
    </Field>
  );
}

function Venues({ row, venue, set }: { row: B.Row; venue: B.Venue; set: (field: string, value: unknown) => void }) {
  const testnet = useContext(Testnet);
  // On testnet only the admitted lending markets and staking are offered (the sandbox copies have none), and the
  // mainnet market reads do not apply.
  const asset = B.assetOf(row.key), choices: B.Venue[] = testnet ? testnet.venues(row.key) : B.venueChoices(asset, "demo"), mainnetFull = useFullMarkets(asset);
  const demoStock = !testnet && asset.category !== "crypto";
  const full = testnet || demoStock ? new Set<B.LendVenue>() : mainnetFull;
  const stock = asset.category === "stock";
  const detail: Record<B.Venue, string> = {
    hold: "Stays in the fund as the token.",
    venus: stock ? "Venus takes stocks as collateral only, so lending them pays nothing; it backs “Borrow & earn”." : "Interest from borrowers; the rate moves daily.",
    aave: "Interest from borrowers; the rate moves daily.",
    lista: "A curated vault. Withdrawals can wait in a short queue.",
    stake: "Staking rewards. Unstaking takes 7–15 days; opens once the slisBNB pool has enough price history.",
  };
  const title = (option: B.Venue) => (option === "hold" ? "Just hold it" : option === "stake" ? "Stake as slisBNB" : stock && option === "venus" ? "Collateral on Venus" : option === "lista" ? asset.lista ?? "Lista vault" : `Lend on ${B.VENUE_NAME[option]}`);
  return (
    <>
      <div className={styles.venues} role="radiogroup" aria-label="While it's held">
        {choices.map((option) => {
          const rate = option === "hold" || option === "stake" || testnet || demoStock ? undefined : asset.earn[option];
          return (
            <button key={option} type="button" role="radio" className={styles.venue} aria-checked={venue === option} onClick={() => set("venue", option)}>
              <i aria-hidden="true" />
              {option === "hold" ? <span className={styles.holdDot} aria-hidden="true">—</span> : <Logo src={venueSrc(option)} size={24} className={styles.logo24} />}
              <b>{title(option)}</b>
              <em>{rate !== undefined ? B.pct(rate) : ""}</em>
              <small>{option !== "hold" && option !== "stake" && full.has(option) ? "Full right now. " : ""}{demoStock && option === "venus" ? "Collateral only · no lending interest." : detail[option]}</small>
            </button>
          );
        })}
      </div>
      {venue !== "hold" && venue !== "stake" && full.has(venue) && <p className={styles.notice}>{B.VENUE_NAME[venue]}&apos;s {B.displayAssetSymbol(asset.symbol)} market is full right now. Until it has room again, the fund can&apos;t take deposits.</p>}
      {choices.length === 1 && !demoStock && <p className={styles.note}>{testnet ? `Lending comes later on testnet: ${asset.name} has no lending market there yet.` : `${asset.name} has no lending market on BNB Chain that a fund can use yet.`}</p>}
    </>
  );
}

// Today's price, read once a minute at most per asset from its Chainlink feed or (stocks) its pool. It only helps
// the creator pick levels: the fund itself prices everything on-chain when it trades.
const prices = new Map<string, { at: number; value: Promise<number | null> }>();
function readPrice(key: string): Promise<number | null> {
  const cached = prices.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const call = B.priceCall(key);
  const value: Promise<number | null> = !call ? Promise.resolve(null) : fetch(B.PRICE_RPC, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [call, "latest"] }),
  }).then((response) => response.json() as Promise<{ result?: unknown }>).then((json) => (typeof json.result === "string" ? B.decodePrice(key, json.result) : null)).catch(() => null);
  prices.set(key, { at: Date.now(), value });
  value.then((result) => { if (result === null) prices.delete(key); });
  return value;
}
/** undefined while reading, null when the price could not be read. */
function useLivePrice(key: string): number | null | undefined {
  const [read, setRead] = useState<{ key: string; value: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    readPrice(key).then((value) => { if (live) setRead({ key, value }); });
    return () => { live = false; };
  }, [key]);
  return read?.key === key ? read.value : undefined;
}

function Now({ asset, now }: { asset: B.Asset; now: number | null | undefined }) {
  const source = B.PRICE_SOURCE[asset.key];
  if (now === undefined) return <span className={styles.note}>Reading today&apos;s price…</span>;
  if (now === null) return <span className={styles.note}>Today&apos;s price could not be read; enter the levels you want.</span>;
  return <span className={styles.note}>{B.displayAssetSymbol(asset.symbol)} is about <b>{B.usd(now)}</b> now ({source && "feed" in source ? "Chainlink" : "PancakeSwap pool"}).</span>;
}

/** A USDT price typed by hand; the text is kept as typed so "0." and "0.0" can lead to 0.05. */
function PriceInput({ label, value, now, onChange }: { label: string; value: number; now: number | null | undefined; onChange: (value: number) => void }) {
  const [text, setText] = useState(value > 0 ? String(value) : "");
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (Number(text) !== value) setText(value > 0 ? String(value) : "");
  }
  const away = now && value > 0 ? ((value - now) / now) * 100 : null;
  return (
    <label className={styles.priceRow}>
      <span>{label}</span>
      <span className={styles.priceBox}>$<input type="number" min={0} step="any" inputMode="decimal" placeholder="0.00" value={text} aria-label={`${label} (USDT)`} onChange={(event) => {
        setText(event.target.value);
        const next = Number(event.target.value);
        onChange(Number.isFinite(next) && next > 0 ? next : 0);
      }} /></span>
      {away !== null && <small>{away >= 0 ? "+" : "−"}{Math.abs(away).toFixed(1)}% from now</small>}
    </label>
  );
}

function ExitField({ row, p, set }: { row: B.Row; p: B.ExitSettings; set: (field: string, value: unknown) => void }) {
  const asset = B.assetOf(row.key), now = useLivePrice(row.key);
  // A lent or staked asset exits on a % move of its share value; prices are for a token held as itself.
  const canPrice = !(B.usesVenue(row) && B.rowVenue(row) !== "hold"), priced = B.pricedExit(row);
  function levelsBy(by: B.LevelBy) {
    if (by === "price" && now && p.tpPrice === 0 && p.slPrice === 0) {
      set("tpPrice", B.roundPrice(now * (1 + p.tp / 100)));
      set("slPrice", B.roundPrice(now * (1 - p.sl / 100)));
    }
    set("by", by);
  }
  return (
    <Field label="When to sell">
      <Seg label="When to sell" value={p.exit} options={[["none", "Never"], ["trail", "Trailing stop"], ["target", "TP / stop"]]} onChange={(value) => set("exit", value)} />
      {p.exit === "trail" && <><span className={styles.note}>Sell after it falls this much from its high</span><Range label="Trailing stop" value={p.trail} limit={B.EXIT_LIMITS.trail} unit={unit.pct} onChange={(value) => set("trail", value)} /></>}
      {p.exit === "target" && <>
        {canPrice
          ? <Seg label="Set take profit and stop loss as" value={p.by} options={[["pct", "% from buy price"], ["price", "Price"]]} onChange={levelsBy} />
          : <span className={styles.note}>While it&apos;s lent or staked, it sells at a % move in its value from when the position opened.</span>}
        {priced ? <>
          <PriceInput label="Take profit at" value={p.tpPrice} now={now} onChange={(value) => set("tpPrice", value)} />
          <PriceInput label="Stop loss at" value={p.slPrice} now={now} onChange={(value) => set("slPrice", value)} />
          <Now asset={asset} now={now} />
          {now && p.tpPrice > 0 && p.tpPrice <= now && <span className={styles.notice}>The take-profit price is at or below today&apos;s price, so it would sell as soon as it&apos;s bought.</span>}
          {now && p.slPrice >= now && <span className={styles.notice}>The stop-loss price is at or above today&apos;s price, so it would sell as soon as it&apos;s bought.</span>}
          <span className={styles.note}>Leave one empty to use only the other.</span>
        </> : <>
          {canPrice && <span className={styles.note}>Measured from {B.AVERAGE_BUY_PRICE}.</span>}
          <span className={styles.note}>Take profit at</span><Range label="Take profit" value={p.tp} limit={B.EXIT_LIMITS.tp} unit={unit.plus} onChange={(value) => set("tp", value)} />
          <span className={styles.note}>Stop loss at</span><Range label="Stop loss" value={p.sl} limit={B.EXIT_LIMITS.sl} unit={unit.minus} onChange={(value) => set("sl", value)} />
        </>}
      </>}
    </Field>
  );
}

function RangeField({ row, p, set }: { row: B.Row; p: B.Settings["range"]; set: (field: string, value: unknown) => void }) {
  const asset = B.assetOf(row.key), now = useLivePrice(row.key);
  function rangeBy(by: B.LevelBy) {
    if (by === "price" && now && p.low === 0 && p.high === 0) {
      set("low", B.roundPrice(now * (1 - p.width / 100)));
      set("high", B.roundPrice(now * (1 + p.width / 100)));
    }
    set("by", by);
  }
  return (
    <Field label="Range">
      <Seg label="Set the range as" value={p.by} options={[["pct", "± % around launch"], ["price", "Low and high price"]]} onChange={rangeBy} />
      {p.by === "price" ? <>
        <PriceInput label="Low" value={p.low} now={now} onChange={(value) => set("low", value)} />
        <PriceInput label="High" value={p.high} now={now} onChange={(value) => set("high", value)} />
        <Now asset={asset} now={now} />
        {now && p.low > 0 && p.high > p.low && (now < p.low || now > p.high) && <span className={styles.notice}>Today&apos;s price is outside this range; trading starts once the price is inside it.</span>}
      </> : <>
        <Range label="Range" value={p.width} limit={B.LIMITS.range.width} unit={unit.pm} onChange={(value) => set("width", value)} />
        <span className={styles.note}>Around the launch price: {B.LAUNCH_PRICE}.</span>
      </>}
    </Field>
  );
}

function BelowField({ row, p, set }: { row: B.Row; p: B.Settings["custom"]; set: (field: string, value: unknown) => void }) {
  const asset = B.assetOf(row.key), now = useLivePrice(row.key);
  function belowBy(by: B.LevelBy) {
    if (by === "price" && now && p.belowPrice === 0) set("belowPrice", B.roundPrice(now * (1 - p.below / 100)));
    set("buyBy", by);
  }
  return <>
    <Seg label="Set the buy level as" value={p.buyBy} options={[["pct", "% below launch"], ["price", "Price"]]} onChange={belowBy} />
    {p.buyBy === "price" ? <>
      <PriceInput label="Buy below" value={p.belowPrice} now={now} onChange={(value) => set("belowPrice", value)} />
      <Now asset={asset} now={now} />
      {now && p.belowPrice >= now && <span className={styles.notice}>Today&apos;s price is already below this, so it would buy right away.</span>}
    </> : <>
      <Range label="Below launch price" value={p.below} limit={B.LIMITS.custom.below} unit={unit.minus} onChange={(value) => set("below", value)} />
      <span className={styles.note}>The launch price is {B.LAUNCH_PRICE}.</span>
    </>}
  </>;
}

function Reinvest({ value, set, label = "Interest and rewards" }: { value: number; set: (field: string, value: unknown) => void; label?: string }) {
  return <Field label={label} note="Fixed once the fund is live."><Seg label={label} value={value} options={[[100, "Reinvest"], [50, "Half"], [0, "Keep"]]} onChange={(next) => set("reinvest", next)} /></Field>;
}

function More({ children }: { children: ReactNode }) {
  return <details className={styles.more}><summary>More settings</summary><div>{children}</div></details>;
}

function Schedule({ p, set, quarterly = true }: { p: { every: B.Every; day?: number; date?: number; time?: string }; set: (field: string, value: unknown) => void; quarterly?: boolean }) {
  const options: [B.Every, string][] = [["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ...(quarterly ? [["quarterly", "Quarterly"] as [B.Every, string]] : [])];
  return (
    <div className={styles.inline}>
      <Seg label="How often" value={p.every} options={options} onChange={(value) => set("every", value)} />
      {p.every === "weekly" && p.day !== undefined && <select aria-label="Day of the week" value={p.day} onChange={(event) => set("day", Number(event.target.value))}>{B.DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select>}
      {(p.every === "monthly" || p.every === "quarterly") && p.date !== undefined && <label>day <NumberBox label="Day of the month" value={p.date} limit={B.LIMITS.stack.date} onChange={(value) => set("date", value)} /></label>}
      {p.time !== undefined && <input type="time" aria-label="Time" value={p.time} onChange={(event) => set("time", event.target.value || "09:00")} />}
    </div>
  );
}

function Settings({ row, set }: { row: B.Row; set: (field: string, value: unknown) => void }) {
  const testnet = useContext(Testnet);
  const asset = B.assetOf(row.key);
  switch (row.play) {
    case "hold": {
      const p = row.p;
      return <>
        <Field label="While it's held"><Venues row={row} venue={p.venue} set={set} /></Field>
        {p.venue !== "hold" && <Reinvest value={p.reinvest} set={set} />}
        <More>
          <ExitField row={row} p={p} set={set} />
          <Field label="Spread the first buy over"><Range label="Spread the first buy over" value={p.hours} limit={B.LIMITS.hold.hours} unit={unit.h} onChange={(value) => set("hours", value)} /></Field>
        </More>
      </>;
    }
    case "stack": {
      const p = row.p;
      return <>
        <Field label="How often" note={`Your local time${testnet ? ` (${testnet.timeZone})` : ""}. A missed buy is skipped, not made up later.`}><Schedule p={p} set={set} /></Field>
        <Field label="Fill its share in" note="Each buy spends what's left for it divided by the buys remaining, so new deposits spread over the rest."><Range label="Number of buys" value={p.buys} limit={B.LIMITS.stack.buys} unit={unit.buys} onChange={(value) => set("buys", value)} /></Field>
        <More>
          <ExitField row={row} p={p} set={set} />
          <Field label="Pause buying above (USD)" note={`0 leaves the limit to CRE8, which sets one above the launch price: ${B.LAUNCH_PRICE}.`}><input className={styles.numInput} type="number" min={0} value={p.ceiling} aria-label="Pause buying above" onChange={(event) => set("ceiling", Math.max(0, Number(event.target.value) || 0))} /></Field>
        </More>
      </>;
    }
    case "dips": {
      const p = row.p;
      return <>
        <Field label="Buy after it drops from its recent high"><Range label="Drop" value={p.dip} limit={B.LIMITS.dips.dip} unit={unit.pct} onChange={(value) => set("dip", value)} /></Field>
        <Field label="Sell each buy at"><Range label="Take profit" value={p.tp} limit={B.LIMITS.dips.tp} unit={unit.plus} onChange={(value) => set("tp", value)} /></Field>
        <More>
          <Field label="Then wait for a bounce of"><Range label="Bounce" value={p.bounce} limit={B.LIMITS.dips.bounce} unit={unit.pct} onChange={(value) => set("bounce", value)} /></Field>
          <Field label="Buy back after a pullback of"><Range label="Buy back" value={p.rebuy} limit={B.LIMITS.dips.rebuy} unit={unit.pct} onChange={(value) => set("rebuy", value)} /></Field>
          <Field label="Open buys at most"><Range label="Open buys" value={p.lots} limit={B.LIMITS.dips.lots} unit={unit.n} onChange={(value) => set("lots", value)} /></Field>
          <Field label="A dip signal stays valid for"><Range label="Signal valid for" value={p.valid} limit={B.LIMITS.dips.valid} unit={unit.days} onChange={(value) => set("valid", value)} /></Field>
        </More>
      </>;
    }
    case "range": {
      const p = row.p;
      return <>
        <RangeField row={row} p={p} set={set} />
        <Field label="Buy and sell levels"><Range label="Levels" value={p.lines} limit={B.LIMITS.range.lines} unit={unit.n} onChange={(value) => set("lines", value)} /></Field>
        <More>
          <Field label="Level spacing"><Seg label="Level spacing" value={p.spacing} options={[["even", "Even price"], ["pct", "Even %"]]} onChange={(value) => set("spacing", value)} /></Field>
          <Field label="If price breaks out above"><Seg label="If price breaks out above" value={p.follow} options={[[false, "Stay put"], [true, "Move range up"]]} onChange={(value) => set("follow", value)} /></Field>
          <Field label="Sell all if it falls below the range by"><Range label="Stop below the range" value={p.stop} limit={B.LIMITS.range.stop} unit={unit.pct} onChange={(value) => set("stop", value)} /></Field>
        </More>
      </>;
    }
    case "trend": {
      const p = row.p;
      return <>
        <Field label="Buy when it breaks its high of the last" note="Shorter windows act sooner but catch more false breakouts."><Seg label="Lookback" value={p.lookback} options={B.LOOKBACK.map(([value, text]) => [value, text] as [B.Lookback, string])} onChange={(value) => set("lookback", value)} /></Field>
        <Field label="Sell if it falls from its peak"><Range label="Trailing stop" value={p.trail} limit={B.LIMITS.trend.trail} unit={unit.pct} onChange={(value) => set("trail", value)} /></Field>
        <More>
          <Field label="Add up to"><Range label="Adds" value={p.adds} limit={B.LIMITS.trend.adds} unit={unit.times} onChange={(value) => set("adds", value)} /></Field>
          <Field label="Each add after a further rise of"><Range label="Step" value={p.step} limit={B.LIMITS.trend.step} unit={unit.pct} onChange={(value) => set("step", value)} /></Field>
          <Field label="Hard stop below the launch price" note={`The launch price is ${B.LAUNCH_PRICE}.`}><Range label="Hard stop" value={p.stop} limit={B.LIMITS.trend.stop} unit={unit.minus} onChange={(value) => set("stop", value)} /></Field>
        </More>
      </>;
    }
    case "lp": {
      const p = row.p;
      // On testnet the pool key fixes its re-centering for good: only what an admitted key of this range runs is offered.
      const recenters = testnet ? testnet.lpRecenters(row.key, p.width) : null;
      const sameHours = recenters?.filter((r) => r.outside === p.outside) ?? [];
      return <>
        <Field label="Price range" note="Narrow ranges earn more fees but drift out of range more often."><Seg label="Price range" value={p.width} options={([["full", "Full"], ["wide", "Wide ±20%"], ["narrow", "Narrow ±5%"]] as [B.Settings["lp"]["width"], string][]).filter(([width]) => !testnet || testnet.lpWidths(row.key).includes(width))} onChange={(value) => set("width", value)} /></Field>
        <Reinvest value={p.reinvest} set={set} label="Fees and rewards" />
        <More>
          <Field label="When price leaves the range"><Seg label="When price leaves the range" value={p.recenter} options={([[true, "Re-center"], [false, "Wait"]] as [boolean, string][]).filter(([option]) => !option || !recenters || recenters.length > 0)} onChange={(value) => set("recenter", value)} /></Field>
          {p.recenter && (recenters ? recenters.length > 0 && <>
            <Field label="Re-center after it's out of range for" note="On testnet the pool position fixes this for good."><Seg label="Out of range for" value={p.outside} options={[...new Set(recenters.map((r) => r.outside))].map((hours) => [hours, `${hours} h`] as [number, string])} onChange={(value) => set("outside", value)} /></Field>
            <Field label="At most"><Seg label="Re-centers per day" value={p.perDay} options={[...new Set((sameHours.length ? sameHours : recenters).map((r) => r.perDay))].map((times) => [times, `${times} / day`] as [number, string])} onChange={(value) => set("perDay", value)} /></Field>
          </> : <>
            <Field label="Re-center after it's out of range for"><Range label="Out of range for" value={p.outside} limit={B.LIMITS.lp.outside} unit={unit.h} onChange={(value) => set("outside", value)} /></Field>
            <Field label="At most"><Range label="Re-centers per day" value={p.perDay} limit={B.LIMITS.lp.perDay} unit={unit.perDay} onChange={(value) => set("perDay", value)} /></Field>
          </>)}
        </More>
      </>;
    }
    case "carry": {
      const p = row.p, borrow = B.borrowChoices(asset, testnet ? "execution" : "demo");
      // On testnet the pairs are the admitted keys; mainnet's live market reads do not apply there.
      const pairs = testnet ? testnet.carryPairs(row.key) : [];
      const lendChoices = testnet ? [...new Set(pairs.filter(([b]) => b === p.borrowOn).map(([, l]) => l))] : B.carryLendChoices(p.borrowOn);
      return <>
        {testnet
          ? <Field label="Borrow USDT on"><Seg label="Borrow on" value={p.borrowOn} options={[...new Set(pairs.map(([b]) => b))].map((venue) => [venue, B.VENUE_NAME[venue]] as [B.LendVenue, string])} onChange={(next) => set("borrowOn", next)} /></Field>
          : asset.category !== "crypto"
            ? <Field label="Borrow USDT on"><Seg label="Borrow on" value={p.borrowOn} options={borrow.map(venue => [venue, B.VENUE_NAME[venue]] as [B.LendVenue, string])} onChange={next => set("borrowOn", next)} /></Field>
            : <>
            <CarryRoom asset={asset} venue={borrow.includes(p.borrowOn) ? p.borrowOn : borrow[0]} />
            <BorrowOn asset={asset} value={borrow.includes(p.borrowOn) ? p.borrowOn : borrow[0]} set={set} />
          </>}
        <Field label="Borrow up to" note="Debt is paid down automatically before it nears liquidation, and the fund only borrows while lending pays more than the loan costs."><Range label="Loan to value" value={p.ltv} limit={B.LIMITS.carry.ltv} unit={unit.ltv} onChange={(value) => set("ltv", value)} /></Field>
        <Field label="Lend the borrowed USDT on"><Seg label="Lend on" value={p.lendOn} options={lendChoices.map((venue) => [venue, B.VENUE_NAME[venue]] as [B.LendVenue, string])} onChange={(value) => set("lendOn", value)} /></Field>
        {testnet && <p className={styles.notice}>A borrowing position uses most of what one fund can run, so the fund holds only this asset.</p>}
      </>;
    }
    case "custom": {
      const p = row.p;
      return <>
        <Field label="How it's bought">
          <Seg label="How it's bought" value={p.buy} options={[["once", "At launch"], ["dca", "Schedule"], ["dip", "After drops"], ["below", "Below a price"]]} onChange={(value) => set("buy", value)} />
          {p.buy === "dca" && <Schedule p={{ every: p.every }} set={set} quarterly={false} />}
          {p.buy === "dip" && <Range label="Drop" value={p.dip} limit={B.LIMITS.custom.dip} unit={unit.pct} onChange={(value) => set("dip", value)} />}
          {p.buy === "below" && <BelowField row={row} p={p} set={set} />}
        </Field>
        {p.buy === "once" ? <>
          <Field label="While it's held"><Venues row={row} venue={p.venue} set={set} /></Field>
          {p.venue !== "hold" && <Reinvest value={p.reinvest} set={set} />}
        </> : <p className={styles.note}>Lending and staking are for assets bought once at launch.</p>}
        <ExitField row={row} p={p} set={set} />
      </>;
    }
  }
}

function Rules({ state, update }: { state: B.Builder; update: Update }) {
  const testnet = useContext(Testnet);
  const rules = state.rules, keys = B.assetKeys(state.rows), on = B.rulesOn(rules);
  const setRule = <K extends keyof B.FundRules>(key: K, patch: Partial<B.FundRules[K]>) => update((s) => ({ ...s, rules: { ...s.rules, [key]: { ...s.rules[key], ...patch } } }));
  const toggle = (key: keyof B.FundRules, value: boolean) => {
    if (key === "pair" && value) setRule("pair", { on: true, a: keys[0] ?? "", b: keys[1] ?? keys[0] ?? "" });
    else if (key === "rotate" && value) setRule("rotate", { on: true, top: Math.max(1, Math.min(rules.rotate.top, keys.length - 1)) });
    else setRule(key, { on: value } as Partial<B.FundRules[typeof key]>);
  };
  const L = B.RULE_LIMITS, top = { min: 1, max: Math.max(1, keys.length - 1) };
  const list: [keyof B.FundRules, ChartKind, string, string, ReactNode][] = [
    ["idle", "idle", "Earn on idle cash", testnet ? `Lend waiting ${testnet.cash} ${testnetIdle(testnet, rules.idle.venue)}; it's pulled back before each buy.` : `Lend waiting USDT (${B.VENUE_NAME[rules.idle.venue]} ${B.pct(B.CASH_APY[rules.idle.venue])}); it's pulled back before each buy.`,
      <>
        {!testnet && <Seg label="Lend idle cash on" value={rules.idle.venue} options={(["venus", "aave", "lista"] as const).map((venue) => [venue, `${B.VENUE_NAME[venue]} ${B.pct(B.CASH_APY[venue])}`] as [B.LendVenue, string])} onChange={(venue) => setRule("idle", { venue })} />}
        {testnet && testnet.idleVenues.length > 0 && <Seg label="Lend idle cash on" value={rules.idle.venue} options={testnet.idleVenues.map((venue) => [venue, B.VENUE_NAME[venue]] as [B.LendVenue, string])} onChange={(venue) => setRule("idle", { venue })} />}
        <label>Lend up to <NumberBox label="Share of idle cash lent" value={rules.idle.max} limit={L.idle.max} onChange={(max) => setRule("idle", { max })} />% of idle cash</label>
      </>],
    ["rebalance", "rebalance", "Rebalance", "Bring each asset back to its share.",
      <>
        <Seg label="When" value={rules.rebalance.how} options={[["drift", "When it drifts"], ["schedule", "On a schedule"]]} onChange={(how) => setRule("rebalance", { how })} />
        {rules.rebalance.how === "drift"
          ? <label>more than <NumberBox label="Drift in points" value={rules.rebalance.drift} limit={L.rebalance.drift} onChange={(drift) => setRule("rebalance", { drift })} /> points off, checked daily</label>
          : <select aria-label="How often" value={rules.rebalance.every} onChange={(event) => setRule("rebalance", { every: event.target.value as "monthly" | "quarterly" })}><option value="monthly">monthly</option><option value="quarterly">quarterly</option></select>}
        <span className={styles.group}>to <Seg label="Target weights" value={rules.rebalance.weight} options={[["custom", "My shares"], ["equal", "Equal"], ["cap", "Market cap, max 20%"]]} onChange={(weight) => setRule("rebalance", { weight })} /></span>
      </>],
    ["rotate", "rotate", "Hold the strongest", "Keep only the best performers among your assets.",
      <>
        <label>Top <NumberBox label="Assets kept" value={rules.rotate.top} limit={top} onChange={(value) => setRule("rotate", { top: value })} /> of {keys.length}</label>
        <label>by <select value={rules.rotate.lookback} onChange={(event) => setRule("rotate", { lookback: Number(event.target.value) as 30 | 90 | 180 })}>{[30, 90, 180].map((days) => <option key={days} value={days}>{days}-day</option>)}</select> return,</label>
        <label>checked <select value={rules.rotate.every} onChange={(event) => setRule("rotate", { every: event.target.value as "weekly" | "monthly" | "quarterly" })}>{["weekly", "monthly", "quarterly"].map((every) => <option key={every} value={every}>{every}</option>)}</select></label>
      </>],
    ["pair", "pair", "Pair grid", "Swap between two of your assets as their price ratio swings.",
      <>
        <select aria-label="First asset" value={rules.pair.a} onChange={(event) => setRule("pair", { a: event.target.value })}>{keys.map((key) => <option key={key} value={key}>{B.assetOf(key).name}</option>)}</select>
        <span>against</span>
        <select aria-label="Second asset" value={rules.pair.b} onChange={(event) => setRule("pair", { b: event.target.value })}>{keys.map((key) => <option key={key} value={key}>{B.assetOf(key).name}</option>)}</select>
        <label>±<NumberBox label="Pair range in percent" value={rules.pair.width} limit={L.pair.width} onChange={(width) => setRule("pair", { width })} />%</label>
        <label><NumberBox label="Pair levels" value={rules.pair.levels} limit={L.pair.levels} onChange={(levels) => setRule("pair", { levels })} /> levels</label>
      </>],
    ["exit", "stop", "Fund stop / take-profit", "Sell everything when the whole fund hits a level.",
      <>
        <label>Stop at −<NumberBox label="Fund stop in percent" value={rules.exit.sl} limit={L.exit.sl} onChange={(sl) => setRule("exit", { sl })} />%</label>
        <label>take profit at +<NumberBox label="Fund take profit in percent" value={rules.exit.tp} limit={L.exit.tp} onChange={(tp) => setRule("exit", { tp })} />%</label>
        <Seg label="After it sells" value={rules.exit.restart} options={[[false, "Stay out"], [true, "Restart"]]} onChange={(restart) => setRule("exit", { restart })} />
        {rules.exit.restart && <label>after <NumberBox label="Restart after days" value={rules.exit.cooldown} limit={L.exit.cooldown} onChange={(cooldown) => setRule("exit", { cooldown })} /> days</label>}
      </>],
  ];
  return (
    <section className={styles.panel} aria-label="Whole-fund rules">
      <div className={styles.ptop}><h2>Whole-fund rules</h2><span className={styles.label}>{on.length ? `${on.length} on` : "All off"}</span></div>
      {list.map(([key, chart, title, line, controls]) => {
        const enabled = rules[key].on, needsTwo = (key === "pair" || key === "rotate") && keys.length < 2;
        // On testnet: idle lending the catalog does not admit now, or a rule testnet funds cannot run yet.
        const closed = !testnet ? "" : key === "idle" && !testnet.idle ? "Not open on testnet right now." : testnet.ruleBlock(key) ?? "";
        return (
          <div key={key} className={styles.rule}>
            <Chart kind={chart} w={78} h={32} mini />
            <div><b>{title}{!B.FORK_VERIFIED_TOOLS.has(B.RULE_TOOLS[key]) && <Beta />}</b><small>{needsTwo ? "Needs at least two assets." : closed || line}</small></div>
            <Seg label={title} value={enabled} options={[[false, "Off"], [true, "On"]]} onChange={(value) => { if ((!needsTwo && !closed) || !value) toggle(key, value); }} />
            {enabled && <div className={styles.ruleSet}>{controls}</div>}
          </div>
        );
      })}
    </section>
  );
}
