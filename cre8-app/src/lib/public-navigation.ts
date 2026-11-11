// 返回路徑僅接受已存在的本站頁面，保留篩選與期間，不形成開放轉址。
export function safePublicReturn(
  value: string | null,
  origin = window.location.origin,
): string {
  if (!value || value.length > 4096) return "/vaults";
  try {
    const url = new URL(value, origin);
    return url.origin === origin &&
      !url.username &&
      !url.password &&
      (["/", "/vaults", "/leaderboard", "/portfolio", "/portfolios"].includes(
        url.pathname.replace(/\/$/, "") || "/",
      ) ||
        /^\/creator\/(?:cre8|0x[0-9a-f]{40})\/?$/i.test(url.pathname))
      ? url.pathname + url.search + url.hash
      : "/vaults";
  } catch {
    return "/vaults";
  }
}
