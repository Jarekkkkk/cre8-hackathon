import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ReferenceSheet } from "./ReferenceSheet";
import { attachFundProfiles } from "../../reference/lib/fund-profile";
import { normalizeXHandle, xProfileUrl } from "../../reference/lib/x-profile";
import { REFERENCE_METADATA } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
export function XLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l8.2-9.5L.8 2h6.5l4.5 6.8L18.9 2ZM17.8 20h1.7L6.4 3.9H4.6L17.8 20Z"
      />
    </svg>
  );
}
export function FundPortrait({
  fund,
  url,
}: {
  fund: ReferenceFund;
  url?: string;
}) {
  const root = useRef<HTMLSpanElement>(null),
    card = useRef<HTMLElement>(null),
    id = useId(),
    // 社群策略（`/vaults` 的 Community 區塊）沒有參考目錄的封面與人物資料，
    // 所以這裡必須容忍 `meta === undefined` —— 以前直接 `meta.profile` 會整頁 crash。
    meta = REFERENCE_METADATA[fund.slug] as (typeof REFERENCE_METADATA)[string] | undefined;
  useEffect(() => {
    if (!root.current || !card.current || !meta?.profile) return;
    const binding = attachFundProfiles(root.current, card.current, () => ({
      profile: meta.profile!,
      image: meta.cover.thumbnailSrc,
    }));
    return () => binding.abort();
  }, [meta]);
  if (meta === undefined) {
    // 沒有封面：用名稱縮寫當標記，維持與其他基金列一樣的 `.public-portrait` 版面。
    const initials = fund.name.replace(/[^A-Za-z\u4e00-\u9fff]/g, '').slice(0, 2).toUpperCase() || 'C8';
    return (
      <span className="public-portrait">
        <span className="fund-thumb" aria-hidden="true" style={{ display: 'grid', placeItems: 'center', fontSize: 18 }}>
          {initials}
        </span>
      </span>
    );
  }
  const image = (
    <>
      <img
        src={meta.cover.thumbnailSrc}
        alt=""
        width="88"
        height="88"
        loading="lazy"
        style={{ objectPosition: `50% ${meta.cover.thumbnailPosition}%` }}
      />

    </>
  );
  return (
    <span ref={root} className="public-portrait">
      {meta.profile ? (
        <button
          type="button"
          className="fund-thumb fund-profile-trigger"
          data-fund-profile={fund.slug}
          aria-label={`About ${meta.profile.name}`}
          aria-haspopup="dialog"
          aria-controls={id}
        >
          {image}
        </button>
      ) : (
        <Link className="fund-thumb" to={url || `/funds/${fund.slug}`}>
          {image}
        </Link>
      )}
      {fund.group === "x-voices" && (
        <span className="fund-x-badge" aria-hidden="true">
          <XLogo />
        </span>
      )}
      <aside
        ref={card}
        id={id}
        className="fund-profile-card"
        popover="manual"
        role="dialog"
        aria-label="Person introduction"
      />
    </span>
  );
}
export function FundSource({ fund }: { fund: ReferenceFund }) {
  const handle = normalizeXHandle(fund.xHandle);
  const url = handle && xProfileUrl(handle);
  if (!url) return null;
  return (
    <span className="fund-row-creator">
      <a className="fund-x-link" href={url} target="_blank" rel="noopener noreferrer">
        @{handle}
      </a>
    </span>
  );
}
export function FundIntroduction({ fund }: { fund: ReferenceFund }) {
  const [open, setOpen] = useState(false);
  const meta = REFERENCE_METADATA[fund.slug] as (typeof REFERENCE_METADATA)[string] | undefined;
  if (meta === undefined || !meta.profile) return <FundSource fund={fund} />;
  const { profile, cover } = meta;
  return (
    <>
      <button type="button" className="fund-introduction-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        Who is {profile.name}?
      </button>
      <ReferenceSheet open={open} onOpenChange={setOpen} title={profile.name}>
        <div className="fund-introduction">
          <div className="fund-introduction-identity">
            <img src={cover.thumbnailSrc} alt="" width={48} height={48} />
            <span>{profile.role}</span>
          </div>
          <p>{profile.bio}</p>
          <FundSource fund={fund} />
        </div>
      </ReferenceSheet>
    </>
  );
}
/**
 * 「人名 · 機構」拆成兩段：手機窄欄裡整串會折成三行，把機構降成第二行小字才讀得像 App 的列表。
 * 分隔符保留在 DOM（螢幕閱讀器與複製文字不變），只在手機版用 CSS 隱藏。
 */
function NameLabel({ name }: { name: string }) {
  const split = name.indexOf(' · ');
  if (split < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, split)}
      <span className="fund-name-org">
        <span className="fund-name-sep"> · </span>
        {name.slice(split + 3)}
      </span>
    </>
  );
}

export function FundName({ fund, url }: { fund: ReferenceFund; url?: string }) {
  const root = useRef<HTMLSpanElement>(null),
    card = useRef<HTMLElement>(null),
    id = useId(),
    meta = REFERENCE_METADATA[fund.slug] as (typeof REFERENCE_METADATA)[string] | undefined;
  useEffect(() => {
    if (!root.current || !card.current || !meta?.profile) return;
    const binding = attachFundProfiles(root.current, card.current, () => ({
      profile: meta.profile!,
      image: meta.cover.thumbnailSrc,
    }));
    return () => binding.abort();
  }, [meta]);
  if (meta === undefined || !meta.profile)
    return url ? (
      <Link className="fund-title-link" to={url}>
        <NameLabel name={fund.name} />
      </Link>
    ) : (
      <><NameLabel name={fund.name} /></>
    );
  return (
    <span ref={root}>
      {url ? (
        <Link
          className="fund-title-link"
          to={url}
          data-fund-profile={fund.slug}
        >
          <NameLabel name={fund.name} />
        </Link>
      ) : (
        <button
          type="button"
          className="public-person-name"
          data-fund-profile={fund.slug}
          aria-haspopup="dialog"
          aria-controls={id}
        >
          <NameLabel name={fund.name} />
        </button>
      )}
      {createPortal(
        <aside
          ref={card}
          id={id}
          className="fund-profile-card"
          popover="manual"
          role="dialog"
          aria-label={`About ${meta.profile.name}`}
        />,
        document.getElementById("root") || document.body,
      )}
    </span>
  );
}
