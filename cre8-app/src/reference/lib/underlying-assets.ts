export type UnderlyingAsset = {
  slug: string; symbol: string; name: string; kind: string; assetClass: string; sector: string | null; industry: string | null;
  description: string | null; descriptionIsExcerpt: boolean; sourceUrl: string | null; descriptionAsOf: string | null; website: string | null; logo: string;
  history: {t:number;v:number}[]; historySource: string | null; historyThrough: string | null; historyCurrency: string; historyBasis: string;
  size: number | null; sizeKind: string; sizeAsOf: string | null; sizeSource: string | null; sizeNote: string | null;
  tokens: {issuer:string;symbol:string;address:string;chainId:number;sourceUrl:string}[];
  builderKey: string | null; funds: {slug:string;name:string;targetWeight:number}[];
};
