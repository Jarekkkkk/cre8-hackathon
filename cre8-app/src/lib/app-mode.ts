/**
 * App 的兩個工作區：投資（Investing）與 Studio（建立與管理自己的基金）。
 *
 * 模式**由網址決定**，不另存一份狀態：深連結、重新整理、上一頁都會落在正確的模式，
 * 不會出現「網址是 Studio、畫面卻是投資分頁列」這種不一致。localStorage 只用來記住
 * 「上次用哪個模式」，讓從主畫面打開 App 的 creator 直接回到 Studio。
 */
export type AppMode = 'invest' | 'studio';

const STUDIO_PREFIXES = ['/studio', '/create', '/strategies'];
const LAST_MODE_KEY = 'cre8.mode';

export const MODE_HOME: Record<AppMode, string> = { invest: '/vaults', studio: '/studio' };

export function modeOf(pathname: string): AppMode {
  return STUDIO_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))
    ? 'studio'
    : 'invest';
}

export function rememberMode(mode: AppMode): void {
  try {
    localStorage.setItem(LAST_MODE_KEY, mode);
  } catch {
    // 私密瀏覽或封鎖儲存時就不記；下次預設回投資模式。
  }
}

export function lastMode(): AppMode {
  try {
    return localStorage.getItem(LAST_MODE_KEY) === 'studio' ? 'studio' : 'invest';
  } catch {
    return 'invest';
  }
}
