/**
 * 準備一個「自足」的部署目錄 `.deploy/`。
 *
 *     bun run scripts/prepare-deploy.ts
 *     cd .deploy && railway up
 *
 * ## 為什麼需要它
 *
 * `db/migrations` 住在**隔壁的 repo**（`cre8-protocol/db`），而 Docker 的 build context 只有
 * 一個目錄。直接把 `backend/` 當 context 的話，image 裡沒有 migration 檔 —— 而 Railway 的
 * Postgres 只在**私有網路**（`postgres.railway.internal`）上，本地連不到，所以「migration 當成
 * 本地部署步驟」這條路在 Railway 上行不通（實測 DNS 失敗）。
 *
 * 結論：**容器必須自己跑 migration**，因此 image 必須含 migration 檔。
 *
 * ## 做法
 *
 * 複製 `backend/`（排除 node_modules / .git / .env / .railway*）到 `.deploy/`，
 * 再把 `../db/migrations` 放到 `.deploy/db/migrations`。
 * 在那個目錄裡 `railway up`，build context 就同時有程式與 migration。
 *
 * 為什麼不直接改 build context 成 repo 根目錄：那裡有 `cre8-app/node_modules`（數百 MB），
 * 上傳與建置都會被拖垮，而且根目錄不是 git repo（`.gitignore` 過濾不生效）。
 *
 * ## 單一真相
 *
 * migrations 仍然只有一份（`db/` repo），`.deploy/` 是**產物**、每次部署前重生，
 * 不進版控（`.gitignore`）。不做兩份手抄，避免漂移。
 */

import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const REPO = resolve(BACKEND, '..');
const MIGRATIONS_SRC = join(REPO, 'db', 'migrations');
const DEPLOY = join(BACKEND, '.deploy');

/** 不該進 image 的東西。比 `.gitignore` 精確（那個還管著別的事）。 */
const EXCLUDE = new Set([
  'node_modules',
  '.git',
  '.deploy',
  '.railway-home',
  '.railway',
  '.env',
  '.env.fork',
  '.bun-cache',
  'dist',
  // 不複製 `.gitignore`：它裡面有 `.deploy/` 這條規則，而 `railway up` 會拿它過濾上傳
  // —— 上傳根目錄自己符合那條規則時，**整個目錄會被排除**（實測：image 裡沒有 db/migrations，
  // 容器啟動 ENOENT，但本地 docker build 完全正常）。
  '.gitignore',
]);

async function copyDir(from: string, to: string): Promise<number> {
  let count = 0;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(source, target);
    } else if (entry.isFile()) {
      await cp(source, target);
      count += 1;
    }
  }
  return count;
}

async function main(): Promise<void> {
  if (!existsSync(MIGRATIONS_SRC)) {
    throw new Error(
      `找不到 migration 目錄：${MIGRATIONS_SRC}\n` +
        'db/ repo 必須 checkout 在 backend/ 旁邊（見 backend/README.md）',
    );
  }

  await rm(DEPLOY, { recursive: true, force: true });
  const copied = await copyDir(BACKEND, DEPLOY);

  // migration 放進 image 裡，路徑與 Dockerfile 的 MIGRATIONS_DIR 對應。
  await cp(MIGRATIONS_SRC, join(DEPLOY, 'migrations'), { recursive: true });
  const migrations = (await readdir(join(DEPLOY, 'migrations'))).filter((f) => f.endsWith('.sql'));

  // 讓人一眼看出這是產物、不要手改。
  await writeFile(
    join(DEPLOY, 'README-DEPLOY.txt'),
    [
      '這是 prepare-deploy.ts 產生的部署目錄，不要手改、不要進版控。',
      '',
      `來源：${BACKEND}`,
      `migration：${migrations.length} 個（來自 ${MIGRATIONS_SRC}）`,
      '',
      '部署：cd .deploy && railway up',
      '',
    ].join('\n'),
    'utf8',
  );

  const size = await stat(DEPLOY);
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'deploy dir ready',
      dir: DEPLOY,
      files: copied,
      migrations: migrations.length,
      exists: size.isDirectory(),
    }),
  );
}

main().catch((cause: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: cause instanceof Error ? cause.message : String(cause) }));
  process.exit(1);
});
