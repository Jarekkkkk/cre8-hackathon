import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Dev proxy：前端一律打 `/api/...`，由 Vite 轉到後端。
 *
 * 這樣做的理由不是方便，是**同源**：後端只開了自己的 CORS 白名單，而 session token 走
 * `Authorization` 標頭 —— 用相對路徑就完全不必處理 CORS 與 preflight。
 * 部署時由反向代理做同一件事（`/api` → backend），前端不必改任何一行。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // shadcn 的元件一律用 `@/…` 匯入，Vite 與 TypeScript 都要知道這個別名。
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /**
       * `events` → 瀏覽器 polyfill。
       *
       * 為什麼需要：`@zerodev/sdk` 的 `KernelEIP1193Provider` 從 **node 內建** `"events"`
       * 匯入 `EventEmitter`。Vite 對瀏覽器建置會把 node 內建外部化成空的
       * `__vite-browser-external`，於是 rollup 在打包時才知道 `EventEmitter` 不存在
       * （本機曾經「剛好」能過，是因為家目錄有一份 `~/node_modules/events` —— 乾淨環境必炸）。
       *
       * 指到套件本體而不是靠自動解析：`events` 這個名字同時是 node 內建，
       * 不明確指路徑就仍有被外部化的風險。
       */
      events: fileURLToPath(new URL('./node_modules/events/events.js', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      /**
       * dev 私鑰模式專用：它沒有錢包 provider 可以借 transport，所以要有一個 RPC。
       * 這裡轉到本機 anvil；用真實錢包連線時**完全不會**用到這條路。
       */
      '/rpc': {
        target: 'http://127.0.0.1:8545',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rpc/, ''),
      },
    },
  },
});
