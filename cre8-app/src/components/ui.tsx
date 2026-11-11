import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad';

const TONE_CLASS: Record<Tone, string> = {
  neutral: '',
  ok: 'badge--ok',
  warn: 'badge--warn',
  bad: 'badge--bad',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return <span className={`badge ${TONE_CLASS[tone]}`.trim()}>{children}</span>;
}

export function Spinner(): ReactNode {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Note({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'bad' | 'warn';
  children: ReactNode;
}): ReactNode {
  const cls = tone === 'neutral' ? 'note' : `note note--${tone}`;
  return <div className={cls}>{children}</div>;
}

/**
 * 錯誤顯示。**刻意把 `code` 與 HTTP status 一起秀出來**：
 * 「後端開關沒開」與「後端壞了」是兩種完全不同的處置，而訊息長得一樣時人只會看到紅字。
 */
export function ErrorNote({ error }: { error: unknown }): ReactNode {
  if (error === null || error === undefined) return null;

  if (error instanceof ApiError) {
    const detail =
      error.status === 0
        ? 'Cannot reach the backend (service down, or the proxy is misconfigured).'
        : error.status === 401
          ? 'Session token missing or expired — sign in again.'
          : error.status === 403
            ? 'The backend refused: this is a permission or feature-flag decision, not a generic error.'
            : error.status === 404
              ? 'Not found (wrong portfolio id or path).'
              : error.status === 503
                ? 'The backend cannot answer right now (RPC or database read failed).'
                : 'The backend reported an error.';
    return (
      <Note tone="bad">
        <strong>
          {error.status === 0 ? 'NETWORK' : `${error.status} · ${error.code}`}
        </strong>
        <div style={{ marginTop: 6 }}>{error.message}</div>
        <div style={{ marginTop: 6, opacity: 0.75 }}>{detail}</div>
      </Note>
    );
  }

  return (
    <Note tone="bad">
      <strong>Unexpected error</strong>
      <div style={{ marginTop: 6 }}>{error instanceof Error ? error.message : String(error)}</div>
    </Note>
  );
}

/**
 * 一個欄位。結構刻意照設計稿：`<label class="field"><span>標籤</span> 控制項 <small>提示</small></label>`。
 *
 * 設計稿的規則是 `.field > span`（標籤、粗體）與 `.field > small`（提示、灰色）。
 * 用 `<div><label>…` 的寫法會讓提示被 `> span` 抓去當標籤 —— 實際看到的症狀是「提示變成粗體標題、
 * 輸入框被推到右邊」。
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint === undefined ? null : <small>{hint}</small>}
    </label>
  );
}
