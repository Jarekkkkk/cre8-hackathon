/** Presentation metadata only. A linked public account never grants fund authority. */
export function normalizeXHandle(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 120) return null;
  let handle = value.trim();
  if (/^https?:\/\//i.test(handle)) {
    try {
      const url = new URL(handle);
      if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) return null;
      handle = url.pathname.replace(/^\//, "").replace(/\/$/, "");
    } catch { return null; }
  }
  handle = handle.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || ["home", "explore", "search", "settings", "intent", "i", "share", "messages", "notifications"].includes(handle.toLowerCase())) return null;
  return handle;
}
export const xProfileUrl = (value: unknown): string | null => {
  const handle = normalizeXHandle(value);
  return handle ? `https://x.com/${handle}` : null;
};
export const xAvatarUrl = (value: unknown): string | null => {
  const handle = normalizeXHandle(value);
  return handle ? `https://unavatar.io/x/${handle}?fallback=false` : null;
};
export const X_MODEL_DISCLAIMER = "This is an AI-inferred index. It does not represent this X account’s actual holdings, trades or investment advice, and is not affiliated with or endorsed by the account.";

/** Same-browser presentation scoped to one deployed fund; never evidence of ownership. */
export function savedXReference(storage: Pick<Storage,"getItem">, chainId: number, factory: string, vault: string): {collection:string;handle:string} | null {
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !/^0x[0-9a-f]{40}$/i.test(factory) || !/^0x[0-9a-f]{40}$/i.test(vault)) return null;
  try {
    const raw=storage.getItem(`cre8:testnet-design:${chainId}:${factory.toLowerCase()}:${vault.toLowerCase()}`);
    if (!raw || raw.length>2_000_000) return null;
    const state=JSON.parse(raw)?.design?.state,handle=normalizeXHandle(state?.xHandle);
    return handle?{collection:["themes","public-figures","x-voices"].includes(state.collection)?state.collection:"themes",handle}:null;
  } catch { return null; }
}
