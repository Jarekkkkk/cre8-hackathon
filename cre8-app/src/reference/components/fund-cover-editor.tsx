"use client";
import Image from "./Image";
import { useRef, useState } from "react";
import { COVER_PRESETS, COVER_MAX_INPUT_BYTES, COVER_MAX_DATA_LENGTH, resolveFundCover, type FundCover } from "../lib/fund-cover";
import styles from "./fund-cover-editor.module.css";

const base = "";
export function FundCoverPreview({ cover, name }: { cover?: FundCover; name: string }) {
  const image = resolveFundCover(cover);
  return <div className={styles.preview} data-fund-cover>
    <Image src={image.src.startsWith("data:") ? image.src : base + image.src} alt="" fill unoptimized sizes="(max-width: 700px) 100vw, 700px" style={{ objectPosition: `center ${image.position}%` }} />
    <div className={styles.shade} /><strong>{name.trim() || "Your fund"}</strong>
  </div>;
}

export default function FundCoverEditor({ value, name, onNameChange, onChange }: { value?: FundCover; name: string; onNameChange: (name: string) => void; onChange: (cover: FundCover | undefined) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const image = resolveFundCover(value);
  async function upload(file: File | undefined) {
    if (!file) return;
    const job = ++request.current;
    setError(""); setBusy(true);
    let url: string | null = null;
    try {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a JPG, PNG or WebP image.");
      if (file.size > COVER_MAX_INPUT_BYTES) throw new Error("Choose an image under 8 MB.");
      url = URL.createObjectURL(file);
      const photo = new window.Image();
      photo.src = url;
      await photo.decode();
      if (photo.naturalWidth < 320 || photo.naturalHeight < 180) throw new Error("Choose a larger image, at least 320 × 180 pixels.");
      if (photo.naturalWidth * photo.naturalHeight > 40_000_000) throw new Error("Choose an image under 40 megapixels.");
      const ratio = Math.min(1, 1600 / Math.max(photo.naturalWidth, photo.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(photo.naturalWidth * ratio); canvas.height = Math.round(photo.naturalHeight * ratio);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Couldn’t prepare this image. Try another.");
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(photo, 0, 0, canvas.width, canvas.height);
      let src = canvas.toDataURL("image/jpeg", .86);
      for (const quality of [.72, .6, .45]) { if (src.length <= COVER_MAX_DATA_LENGTH) break; src = canvas.toDataURL("image/jpeg", quality); }
      if (src.length > COVER_MAX_DATA_LENGTH) throw new Error("This image is too detailed to save. Choose a smaller one.");
      if (request.current === job) { onChange({ kind: "upload", src, position: 50 }); setExpanded(true); }
    } catch (e) { if (request.current === job) setError(e instanceof Error ? e.message : "Couldn’t open this image. Try another."); }
    finally { if (url) URL.revokeObjectURL(url); if (request.current === job) setBusy(false); }
  }
  return <section className={styles.editor} aria-label="Fund cover">
    <div className={styles.heading}><h2>Fund cover</h2><button type="button" className="btn ghost sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Done" : "Change cover"}</button></div>
    <label className={styles.nameField}><span>Fund name</span><input type="text" aria-label="Fund name" placeholder="Name your fund" maxLength={64} value={name} onChange={e => onNameChange(e.target.value)} /></label>
    <FundCoverPreview cover={value} name={name} />
    {expanded && <div className={styles.controls}>
      <div className={styles.gallery} role="group" aria-label="Cover photos">{COVER_PRESETS.slice(0, 5).map(p => <button type="button" key={p.id} data-fund-cover aria-label={p.name} aria-pressed={image.src === p.src} disabled={busy} onClick={() => { request.current++; setError(""); onChange({ kind: "preset", id: p.id, position: p.position }); }}><Image data-fund-cover src={base + p.src} alt="" width={160} height={100} unoptimized /><span>{p.name}</span>{image.src === p.src && <i aria-hidden="true">✓</i>}</button>)}</div>
      <div className={styles.uploadRow}><button type="button" className="btn ghost sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Preparing image…" : "Upload photo"}</button><span>JPG, PNG or WebP · up to 8 MB</span>{value && <button type="button" className={styles.reset} disabled={busy} onClick={() => { request.current++; setError(""); onChange(undefined); }}>Reset</button>}</div>
      <input ref={input} className={styles.file} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload fund cover" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      <label className={styles.position}>Photo position<input type="range" min="0" max="100" value={image.position} aria-label="Photo position" disabled={busy} onChange={e => onChange(value ? { ...value, position: Number(e.target.value) } : { kind: "preset", id: "balanced", position: Number(e.target.value) })} /><span>Top ↔ Bottom</span></label>
    </div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
