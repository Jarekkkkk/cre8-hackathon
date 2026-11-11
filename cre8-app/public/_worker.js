/**
 * Cloudflare Pages 進階模式（advanced mode）的入口。
 *
 * ## 為什麼需要一個 Worker，而不是直接讓前端打 Railway 的網址
 *
 * 後端有兩道「網域必須一致」的檢查：
 *
 *   1. `auth.ts` 的 SIWE —— `message.domain` 必須逐字等於 `AUTH_DOMAIN`，
 *      否則登入直接被拒；而且錢包彈窗會顯示一個跟瀏覽器不同的網域（那正是釣魚的特徵）。
 *   2. CORS —— 後端只白名單 `CORS_ALLOWED_ORIGINS`（預設是 vite dev 的 localhost）。
 *
 * 讓兩者共用同一個 origin（`app.cre8.xyz`）之後，這兩件事都不需要處理：
 * 同源請求不會觸發 CORS，`AUTH_DOMAIN` 也自然等於使用者看到的網址。
 *
 * ## 為什麼放在 `public/`
 *
 * Vite 會把 `public/` 的內容原樣複製到 `dist/`，而 Pages 的進階模式讀的就是
 * `dist/_worker.js`。放在這裡不必額外設定 build 步驟或 framework preset。
 *
 * ## 路由規則
 *
 *   /api/*  → Railway 的 api（**去掉 `/api` 前綴** —— 後端路由是 `/portfolios`、`/health` 等）
 *   其他     → 靜態資源（`env.ASSETS`）
 */

/** 後端來源。要換環境（例如 staging）時改這一行就好。 */
const API_ORIGIN = 'https://api-production-7f13.up.railway.app';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 首頁是 landing（所有網域）。帶查詢參數的 `/?…` 仍交給 App：那是 Funds 的篩選深連結，
    // 已分享出去的連結不能因為首頁換成 landing 而失效。landing 的按鈕都連到 /vaults、/create、/funds/…。
    if (url.pathname === '/' && url.search === '' &&
        (request.method === 'GET' || request.method === 'HEAD')) {
      url.pathname = '/landing/';
      return env.ASSETS.fetch(new Request(url, request));
    }

    if (url.pathname === '/reference-data/demo-funds') {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status:405,headers:{Allow:'GET, HEAD'}});
      try {
        // Workers 不支援 redirect:error；手動拒絕轉址，避免固定資料來源變成外部跳轉。
        const response = await fetch('https://bnb-agent-vaults.vercel.app/api/demo-funds/', {method:request.method,headers:{Accept:'application/json'},redirect:'manual'});
        if (response.status >= 300 && response.status < 400) return Response.json({error:'Reference redirect refused'}, {status:502});
        const publicHeaders = new Headers(response.headers);
        publicHeaders.delete('set-cookie');
        publicHeaders.set('cache-control', 'public, max-age=60');
        return new Response(response.body, {status:response.status,headers:publicHeaders});
      } catch {
        return Response.json({error:'Reference temporarily unavailable'}, {status:503});
      }
    }

    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (!isApi) return env.ASSETS.fetch(request);

    // 把 `/api/portfolios` 變成 `/portfolios`（後端不會有 `/api` 這一段）。
    const stripped = url.pathname.replace(/^\/api/, '') || '/';
    const target = new URL(stripped + url.search, API_ORIGIN);

    // 逐項複製 request，而不是 `new Request(target, request)` —— 後者在某些
    // method/body 組合下會拋錯（例如 GET 帶 body），也比較難看出到底轉發了什麼。
    const headers = new Headers(request.headers);
    // Host 要換成目標，否則 Railway 會用 app.cre8.xyz 去找服務。
    headers.set('host', new URL(API_ORIGIN).host);
    // 讓後端知道原始的對外網址（除錯用；後端目前不依賴它）。
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

    return fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });
  },
};
