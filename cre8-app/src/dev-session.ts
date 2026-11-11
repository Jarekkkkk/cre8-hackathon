/**
 * DEV-only：讓 `?devSession=<json>` 在**任何 store 建立之前**塞進 sessionStorage。
 *
 * 為什麼要獨立成一個模組並放在 `main.tsx` 的第一個 import：zustand 的 `persist` 在**模組求值時**
 * 就從 storage rehydrate 了。寫在 `main.tsx` 的函式體內已經太晚（所有 import 先求值），
 * 寫在 `index.html` 又會跟著正式 build 出去。
 *
 * 正式 build 裡 `import.meta.env.DEV` 是 false，整段會被 tree-shake 掉。
 */
if (import.meta.env.DEV) {
  const seeded = new URLSearchParams(window.location.search).get('devSession');
  if (seeded !== null) {
    window.sessionStorage.setItem('cre8.session', seeded);
  }
}

export {};
