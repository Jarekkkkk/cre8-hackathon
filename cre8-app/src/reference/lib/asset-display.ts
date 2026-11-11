import { stockTickers } from "./stock-icons.generated";

/** Display only: exact catalog symbols resolve to their underlying ticker. Never rewrite stored identities. */
export const displayAssetSymbol = (symbol: string): string => stockTickers[symbol.toUpperCase()] ?? symbol;

/** Labels may contain pairs or sentences. Receipt names such as vNVDAB remain distinct instruments. */
export const displayAssetLabel = (label: string): string => label.replace(/\b[A-Za-z][A-Za-z0-9._-]*\b/g, displayAssetSymbol);
