import type { ReactNode } from 'react';
import { Toaster as SonnerToaster, toast as sonner } from 'sonner';

/**
 * Toast —— **用 shadcn 的 sonner**，不再自己寫。
 *
 * ## 為什麼換掉手寫版
 * 手寫版需要自己處理：堆疊、自動消失、暫停計時、`aria-live`、動畫、可存取性、多個同時出現時的
 * 排版。這每一項都是「看起來做到了、細節都錯」的典型（我們實際踩到的是：`className` 與設計稿的
 * `.toast` 撞名 → 元素在 DOM 裡但 `opacity: 0`，畫面上完全看不到）。
 * sonner 這些都處理好了，而且是 shadcn 的官方選項。
 *
 * ## 為什麼保留這個 adapter 而不是直接用 sonner
 * 呼叫端用的是**語意化的四個狀態**（pending / ok / warn / bad）＋ `replace(id, …)`，
 * 那組介面在 11 個地方用到。留一層薄薄的 adapter，遷移就只是換實作，不必改任何呼叫點。
 *
 * sonner 的 `{ id }` 選項就是「更新既有的那一則」—— 這正好對上我們的 `replace`：
 * 「送出中」→「已確認」會在原本的位置變色，而不是多出一則新的。
 */

/** sonner 的 id 是字串（`toast.loading()` 回傳值）。 */
export type ToastId = string | number;

export type ToastTone = 'pending' | 'ok' | 'warn' | 'bad';

export type ToastInput = {
  tone: ToastTone;
  title: string;
  /** 第二行（tx hash、金額、原因）。sonner 稱它 `description`。 */
  body?: string;
};

const DURATION = { ok: 8_000, warn: 12_000, bad: 15_000 } as const;

/**
 * `pending` 的保險絲：5 分鐘後自動消失。
 *
 * 原本是 `Number.POSITIVE_INFINITY`（「它要等結果來 replace」），但那個假設一旦在某個呼叫端
 * 破功，那則 toast 就會**永遠留在畫面上轉**。實測踩到：deposit 的「Configuring your deposit /
 * Buying the target assets…」用 `toast.ok()` 另開一則，白色那則就一直轉到使用者重新整理。
 *
 * 5 分鐘的取捨：真正需要使用者簽名的流程（賣出多輪 + 等簽章）不會超過這個時間；
 * 超過就代表它已經孤兒了，讓它自己消失比留著誤導人好。
 */
const PENDING_MAX_MS = 5 * 60_000;

function emit(input: ToastInput, id?: ToastId): ToastId {
  const options = {
    // `id` 有值 → 更新既有的那一則（不是新增）。這是 replace 的實作方式。
    ...(id === undefined ? {} : { id }),
    description: input.body,
    // pending 不自動消失：它會被下一次 replace 換掉。其餘按嚴重度給不同的停留時間
    // （失敗要留久一點才看得完）。
    ...(input.tone === 'pending' ? { duration: PENDING_MAX_MS } : { duration: DURATION[input.tone] }),
  };

  switch (input.tone) {
    case 'pending':
      return sonner.loading(input.title, options);
    case 'ok':
      return sonner.success(input.title, options);
    case 'warn':
      return sonner.warning(input.title, options);
    case 'bad':
      return sonner.error(input.title, options);
    default:
      return sonner(input.title, options);
  }
}

/** 給非 React 的呼叫端（`catch` 裡、async 流程中）用。 */
export const toast = {
  pending: (title: string, body?: string): ToastId => emit({ tone: 'pending', title, body }),
  ok: (title: string, body?: string): ToastId => emit({ tone: 'ok', title, body }),
  warn: (title: string, body?: string): ToastId => emit({ tone: 'warn', title, body }),
  bad: (title: string, body?: string): ToastId => emit({ tone: 'bad', title, body }),
  /**
   * 把一則既有的 toast 換成結果（同一個位置、同一個 id）。
   *
   * `tone: 'pending'` 也支援 —— 「準備中 → 建立帳戶中 → 等待簽章」這種多階段流程會用到。
   */
  replace: (id: ToastId, next: ToastInput): ToastId => emit(next, id),
  dismiss: (id: ToastId): void => {
    sonner.dismiss(id);
  },
};

/**
 * 掛在 App 最外層一次。
 *
 * `richColors` 讓四種狀態有各自的底色（不用自己寫 CSS）；`closeButton` 給使用者關掉長訊息的路。
 * 位置固定在右下角 —— 與原本手寫版一致。
 */
export function Toaster(): ReactNode {
  // DEV 自測：`?toast=1` 就推一則（不放在 effect 裡 —— 模組載入一定比任何 render 早，
  // 這樣才能分辨「元件沒掛上」與「effect 沒跑」）。正式 build 會被 tree-shake 掉。
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    if (new URLSearchParams(window.location.search).get('toast') !== null) {
      window.setTimeout(() => toast.warn('Toast self-test', 'sonner via shadcn'), 0);
    }
  }
  return <SonnerToaster richColors closeButton position="bottom-right" />;
}
