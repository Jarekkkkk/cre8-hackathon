"use client";
import Image from "./Image";
import { useState } from "react";
import { normalizeXHandle, xAvatarUrl, xProfileUrl, X_MODEL_DISCLAIMER } from "../lib/x-profile";
import type { Builder } from "../lib/fund-builder";
import styles from "./x-profile.module.css";

export function XMark() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l8.2-9.5L.8 2h6.5l4.5 6.8L18.9 2ZM17.8 20h1.7L6.4 3.9H4.6L17.8 20Z" /></svg>;
}
function Avatar({ handle, load }: { handle: string; load: boolean }) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  return <span className={styles.avatar} data-fund-cover>
    <span className={styles.placeholder} aria-hidden="true">{handle.slice(0, 1).toUpperCase()}</span>
    {load && status !== "failed" && <Image data-fund-cover src={xAvatarUrl(handle)!} alt={`@${handle} profile photo`} width={64} height={64} unoptimized referrerPolicy="no-referrer" onLoad={() => setStatus("ready")} onError={() => setStatus("failed")} />}
    <span className={styles.badge} data-fund-cover><XMark /></span>
    {status === "failed" && <span className={styles.sr}>Profile photo unavailable</span>}
  </span>;
}
export function XProfilePreview({ handle: value, load = true }: { handle: string; load?: boolean }) {
  const handle = normalizeXHandle(value);
  if (!handle) return null;
  return <div className={styles.profile}><a className={styles.profileLink} href={xProfileUrl(handle)!} target="_blank" rel="noopener noreferrer"><Avatar key={handle + load} handle={handle} load={load} /><span><span className={styles.eyebrow}>Tracking</span><strong>@{handle} <span aria-hidden="true">↗</span></strong></span></a><span className={styles.attribution}>Profile photo via <a href="https://unavatar.io" target="_blank" rel="noopener noreferrer">Unavatar</a>. A profile link does not verify ownership or endorsement.</span></div>;
}

export default function FundSourceEditor({ state, onChange }: { state: Builder; onChange: (next: Builder) => void }) {
  const [loaded, setLoaded] = useState<string | null | undefined>(undefined);
  const handle = normalizeXHandle(state.xHandle), invalid = !!state.xHandle?.trim() && !handle;
  function confirm() { if (handle) { onChange({ ...state, xHandle: handle }); setLoaded(handle); } }
  return <section className={styles.editor} aria-label="Fund collection and X profile">
    <div className={styles.heading}><h2>Collection &amp; X profile</h2></div>
    <label className={styles.field}><span>Collection</span><select value={state.collection ?? "themes"} onChange={e => onChange({ ...state, collection: e.target.value as Builder["collection"] })}><option value="themes">Themes</option><option value="public-figures">Public figures</option><option value="x-voices">X voices</option></select></label>
    <label className={styles.field}><span>X handle <small>{state.collection === "x-voices" ? "Required for X voices" : "Optional"}</small></span><div className={styles.inputRow}><input aria-label="X handle" type="text" placeholder="@username or x.com/username" value={state.xHandle ?? ""} maxLength={120} autoComplete="off" spellCheck={false} aria-invalid={invalid} onChange={e => { setLoaded(null); onChange({ ...state, xHandle: e.target.value }); }} onBlur={confirm} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }} /><button className="btn ghost sm" type="button" disabled={!handle} onClick={confirm}>Load profile</button></div></label>
    {invalid && <p className={styles.error} role="alert">Use an X username with 1–15 letters, numbers or underscores.</p>}
    {handle && <XProfilePreview handle={handle} load={loaded === undefined || loaded === handle} />}
    {state.collection === "x-voices" && <p className={styles.disclaimer}>{X_MODEL_DISCLAIMER}</p>}
  </section>;
}
