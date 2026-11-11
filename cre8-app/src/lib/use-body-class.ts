import { useEffect } from 'react';

/**
 * 把 class 掛到 `document.body`，離開頁面時移除。
 *
 * 為什麼需要：設計稿的頁面是靠 **body 的 class** 生效的 —— `vaults.html` 是
 * `<body class="vault-directory fund-explore">`、`create.html` 是 `<body class="create-page">`。
 * 少了它，`.fund-explore { background: var(--paper) }`（#F7F9FB）不會套用，頁面就還是站台的
 * 藍灰 `#B7CDDE` —— 那是「看起來跟原版差很多」最主要的原因。
 *
 * 用 effect 而不是寫死在 `index.html`：這些 class 只屬於各自的頁面，全域掛著會污染其他頁。
 */
export function useBodyClass(...classes: readonly string[]): void {
  useEffect(() => {
    const { body } = document;
    body.classList.add(...classes);
    return () => {
      body.classList.remove(...classes);
    };
    // classes 是呼叫端給的常數陣列；用 join 當 key 避免每次 render 都重掛。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes.join(' ')]);
}
