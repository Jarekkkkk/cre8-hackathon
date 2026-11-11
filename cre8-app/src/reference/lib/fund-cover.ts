import { xAvatarUrl } from "./x-profile";
/** Presentation metadata only: never used to value a fund or authorize its trades. */
export const COVER_PRESETS = [
  { id: "ai", name: "AI infrastructure", src: "/fund-covers/ai-20261109-r3.webp", thumbnailSrc: "/fund-covers/ai-20261109-r3-thumb.webp", position: 50 },
  { id: "mag7", name: "US technology leaders", src: "/fund-covers/mag7-20261109-r3.webp", thumbnailSrc: "/fund-covers/mag7-20261109-r3-thumb.webp", position: 38 },
  { id: "balanced", name: "Balanced assets", src: "/fund-covers/balanced-20261109-r3.webp", thumbnailSrc: "/fund-covers/balanced-20261109-r3-thumb.webp", position: 50 },
  { id: "crypto", name: "Crypto leaders", src: "/fund-covers/crypto-20261109-r3.webp", thumbnailSrc: "/fund-covers/crypto-20261109-r3-thumb.webp", position: 50 },
  { id: "treasury", name: "Treasury reserve", src: "/fund-covers/treasury-20261109-r3.webp", thumbnailSrc: "/fund-covers/treasury-20261109-r3-thumb.webp", position: 38 },
  { id: "elon", name: "Elon Musk", src: "/fund-covers/elon-20261109.webp", thumbnailSrc: "/fund-covers/elon-20261109-thumb.webp", position: 50 },
  { id: "pelosi", name: "Nancy Pelosi", src: "/fund-covers/pelosi-20261109.webp", thumbnailSrc: "/fund-covers/pelosi-20261109-thumb.webp", position: 50 },
  { id: "buffett", name: "Warren Buffett", src: "/fund-covers/buffett-20261109.webp", thumbnailSrc: "/fund-covers/buffett-20261109-thumb.webp", position: 50 },
  { id: "trump", name: "Donald Trump", src: "/fund-covers/trump-20261109.webp", thumbnailSrc: "/fund-covers/trump-20261109-thumb.webp", position: 50 },
] as const;
export type FundCover = { kind: "preset"; id: string; position: number } | { kind: "upload"; src: string; position: number };
export const COVER_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const COVER_MAX_DATA_LENGTH = 800_000;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function reviveFundCover(value: unknown): FundCover | null {
  if (!object(value) || typeof value.position !== "number" || !Number.isFinite(value.position)) return null;
  const position = Math.round(Math.max(0, Math.min(100, value.position)));
  if (value.kind === "preset" && COVER_PRESETS.some(p => p.id === value.id)) return { kind: "preset", id: value.id as string, position };
  // Local uploads are decoded and re-encoded as JPEG. Never accept arbitrary URLs or active SVG content.
  if (value.kind === "upload" && typeof value.src === "string" && value.src.length <= COVER_MAX_DATA_LENGTH && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value.src)) return { kind: "upload", src: value.src, position };
  return null;
}
const defaults: Record<string, string> = { mag7: "mag7", "ai-buildout": "ai", "multi-asset-balanced": "balanced", "crypto-leaders": "crypto", "treasury-reserve": "treasury", "elon-universe": "elon", "pelosi-disclosed-equity": "pelosi", "berkshire-disclosed-equities": "buffett", "trump-universe": "trump" };
const profileCovers: Record<string, string> = {
  "dan-bin-oriental-harbor":"dan-bin", "ray-dalio-bridgewater":"ray-dalio", "bill-ackman-pershing":"bill-ackman",
  "bill-gates-foundation":"bill-gates", "cathie-wood-arkk":"cathie-wood", "tom-lee-granny-shots":"tom-lee-real",
  "dan-ives-ai":"dan-ives", "stanley-druckenmiller-duquesne":"stanley-druckenmiller", "ken-griffin-citadel":"ken-griffin",
  "serenity-x":"x-serenity", "michael-burry-x":"x-burry", "arthur-hayes-x":"x-hayes", "raoul-pal-x":"x-raoul",
  "ansem-x":"x-ansem", "ming-chi-kuo-x":"x-kuo", "herman-jin-x":"x-herman", "chris-lee-x":"x-chris",
  "jim-cramer-x":"jim-cramer", "peter-schiff-euro-pacific":"peter-schiff", "jeffrey-gundlach-doubleline":"jeffrey-gundlach",
  "gavin-baker-atreides":"gavin-baker", "david-einhorn-dme":"david-einhorn",
  "lyn-alden-x":"lyn-alden",
  "leopold-aschenbrenner-situational":"leopold-aschenbrenner",
};
export function resolveFundCover(value?: unknown, fund: { slug?: string; group?: string; xHandle?:string } = {}) {
  const cover = reviveFundCover(value);
  if (cover?.kind === "upload") return { src: cover.src, thumbnailSrc: cover.src, position: cover.position, thumbnailPosition: cover.position, name: "Custom cover", portrait: false };
  const profile=!cover&&profileCovers[fund.slug??""];
  if(profile){const src=`/fund-covers/${profile}-20261110.webp`;return {src,thumbnailSrc:src,position:50,thumbnailPosition:50,name:"Reference-based generated cover",portrait:false,wide:true};}
  const avatar=!cover&&!defaults[fund.slug??""]&&["people","x-voices"].includes(fund.group??"")?xAvatarUrl(fund.xHandle):null;
  if(avatar)return {src:avatar,thumbnailSrc:avatar,position:50,thumbnailPosition:50,name:"Public X profile photo",portrait:true};
  const id = cover?.id ?? defaults[fund.slug ?? ""] ?? (fund.group === "crypto" ? "crypto" : fund.group === "rwa" ? "treasury" : fund.group === "stocks" ? "mag7" : "balanced");
  const preset = COVER_PRESETS.find(p => p.id === id) ?? COVER_PRESETS[0];
  return { src: preset.src, thumbnailSrc: preset.thumbnailSrc, position: cover?.position ?? preset.position, thumbnailPosition: cover?.position ?? 50, name: preset.name, portrait: false };
}
/** Same-browser presentation only. No signature, identity or financial state is trusted from this metadata. */
export function savedFundCover(storage: Pick<Storage, "getItem">, chainId: number, factory: string, vault: string): FundCover | null {
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !/^0x[0-9a-f]{40}$/i.test(factory) || !/^0x[0-9a-f]{40}$/i.test(vault)) return null;
  try {
    const raw = storage.getItem(`cre8:testnet-design:${chainId}:${factory.toLowerCase()}:${vault.toLowerCase()}`);
    if (!raw || raw.length > 2_000_000) return null;
    const data = JSON.parse(raw);
    return reviveFundCover(data?.design?.state?.cover);
  } catch { return null; }
}
