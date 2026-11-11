// Presentation and discovery only. Returns, NAV and model allocations stay in the fund records.
import assetNames from "../data/fund-explore/asset-names.json" with {type:"json"};
export { resolveFundCover, savedFundCover } from "./fund-cover";
export { exploreFilters, exploreUrl, fundDetailUrl, fundReturnUrl, performancePeriod } from "./fund-navigation";
export { normalizeXHandle, xProfileUrl, xAvatarUrl, savedXReference, X_MODEL_DISCLAIMER } from "./x-profile";
export { fundEditorial } from "./fund-editorial";
export { analyzeFundPerformance } from "./fund-performance";
export { holdingAssetSlug } from "./asset-navigation";
export { attachAssetPreviews } from "./asset-preview";
export { fundProfile, attachFundProfiles } from "./fund-profile";
export { recentModelTrades,selectModelTrades,modelTradeSize,modelTradeReason,modelTradeUpdates,tradeUpdateDate,recentUpdateSource,recentUpdateSources,recentFundSources,modelPositionGroups,positionWeightLabels } from "./recent-trades";
export const COLLECTIONS = [
  {id:"themes",name:"Themes",description:"Explore ideas across stocks, crypto and real-world assets."},
  {id:"public-figures",name:"Public figures",description:"Explore public disclosures and the ideas associated with influential figures."},
  {id:"x-voices",name:"X voices",description:"Follow voices on X through AI-inferred model indices. These are not their verified holdings."},
] as const;
export type Collection = typeof COLLECTIONS[number]["id"];
export const ASSET_CLASSES = [{id:"stocks",name:"Stocks"},{id:"crypto",name:"Crypto"},{id:"rwa",name:"RWA"}] as const;
export type AssetClass = typeof ASSET_CLASSES[number]["id"];
export type Period = "7D"|"30D"|"90D"|"1Y"|"ALL";
export type ExploreFund = {
  slug:string;name:string;group?:string;xHandle?:string;strategy:string;tvl:number;runtimeDays:number;followers?:number;
  returns:Record<string,number|null>;maxDrawdown:Record<string,number|null>;
  nav?:{t:number;v:number}[];backtest?:{through:string;targets:{id:string;symbol:string;name:string;logo?:string}[]};
  asset?:string;positions?:readonly {p:string;loc:string;w:number}[];
  rules?:readonly {g:string}[];
};
export const FUND_ART:Record<string,{title:string;subtitle:string;type:string;keywords:string;portrait?:string;cover:string}> = {
  mag7:{title:"MAG\nSEVEN",subtitle:"Seven companies. One portfolio.",type:"Stocks",cover:"mag7",keywords:"big tech technology 七巨頭 科技"},
  "ai-buildout":{title:"THE AI\nBUILDOUT",subtitle:"Chips, data centers and power.",type:"Stocks",cover:"ai",keywords:"AI 人工智慧 晶片 半導體 電力"},
  "crypto-leaders":{title:"CRYPTO\nLEADERS",subtitle:"Ten assets. One crypto core.",type:"Crypto",cover:"crypto",keywords:"加密 比特幣 以太坊"},
  "elon-universe":{title:"ELON\nUNIVERSE",subtitle:"Tesla, SpaceX and crypto.",type:"Stocks + Crypto",cover:"elon",portrait:"elon",keywords:"Elon Musk 馬斯克 特斯拉 太空"},
  "pelosi-disclosed-equity":{title:"PELOSI\nDISCLOSED",subtitle:"A selection from household disclosures.",type:"Stocks",cover:"pelosi",portrait:"pelosi",keywords:"Nancy Paul Pelosi 裴洛西 佩洛西 公開申報"},
  "berkshire-disclosed-equities":{title:"BERKSHIRE\nEQUITIES",subtitle:"Inside a disclosed equity portfolio.",type:"Stocks",cover:"berkshire",portrait:"buffett",keywords:"Warren Buffett Berkshire 巴菲特 波克夏"},
  "trump-universe":{title:"TRUMP\nUNIVERSE",subtitle:"Disclosed equities and related assets.",type:"Stocks + Crypto",cover:"trump",portrait:"trump",keywords:"Donald Trump 川普 特朗普"},
  "multi-asset-balanced":{title:"A WIDER\nPERSPECTIVE",subtitle:"Stocks, Treasuries, gold and Bitcoin.",type:"Multi-asset",cover:"balanced",keywords:"gold 黃金 XAUt treasury 美債 分散 多資產 balanced"},
  "treasury-reserve":{title:"THE TREASURY\nRESERVE",subtitle:"Short-term first. Room across maturities.",type:"RWA",cover:"treasury",keywords:"bonds treasury 美債 國債 固定收益 債券"},
};
export function collectionOf(f:Pick<ExploreFund,"group">):Collection {
  return f.group==="x-voices"?"x-voices":f.group==="people"?"public-figures":"themes";
}
export function assetClassesOf(f:Pick<ExploreFund,"rules">):AssetClass[] {
  return ASSET_CLASSES.filter(a=>f.rules?.some(rule=>rule.g===a.id)).map(a=>a.id);
}
// Preview current model positions, not unfilled targets or allocation limits.
export function currentFundAssets(f:Pick<ExploreFund,"positions"|"backtest"|"asset">) {
  const weights=new Map<string,number>();
  for(const p of f.positions??[]){
    if(!Number.isFinite(p.w)||p.w<=0)continue;
    const symbol=p.p==="Idle"?f.asset||"USDT":p.loc;
    weights.set(symbol,(weights.get(symbol)??0)+p.w);
  }
  return [...weights].filter(([,weight])=>weight>1e-6).sort(([a,aw],[b,bw])=>bw-aw||a.localeCompare(b)).map(([symbol,weight])=>({
    symbol,weight,logo:symbol==="USDT"?"tokens/usdt.png":f.backtest?.targets.find(t=>t.symbol===symbol)?.logo,
  }));
}
const normalized=(s:string)=>s.normalize("NFKC").toLowerCase().trim();
export function matchesFund(f:ExploreFund,query:string) {
  const words=normalized(query).split(/\s+/).filter(Boolean);
  const art=FUND_ART[f.slug];
  const text=normalized([f.name,f.strategy,f.xHandle,art?.keywords,art?.type,...(f.backtest?.targets??[]).flatMap(t=>[t.id,t.symbol,t.name,(assetNames as Record<string,string>)[t.id]])].join(" "));
  return words.every(word=>text.includes(word));
}
export function selectFunds(funds:readonly ExploreFund[],query:string,collection:string,sort:string,period:Period,assets:readonly AssetClass[]=[]) {
  const rows=funds.filter(f=>(collection==="all"||collectionOf(f)===collection)&&matchesFund(f,query)&&(!assets.length||assets.some(a=>assetClassesOf(f).includes(a))));
  const value=(f:ExploreFund)=>sort==="perf"?periodMetrics(f,period).returnPct:sort==="dd"?periodMetrics(f,period).maxDrawdown:sort==="holders"?f.followers:sort==="age"?f.runtimeDays:f.tvl;
  return rows.sort((a,b)=>{const av=value(a),bv=value(b);return av==null?(bv==null?0:1):bv==null?-1:bv-av;});
}
export function periodSeries(f:Pick<ExploreFund,"nav">,period:Period) {
  const series=f.nav??[],days={"7D":7,"30D":30,"90D":90}[period as "7D"|"30D"|"90D"];
  if(period==="1Y")return series.filter(p=>p.t>=(series.at(-1)?.t??0)-365*86400000);
  return days?series.slice(-days-1):series;
}
export function periodMetrics(f:Pick<ExploreFund,"nav"|"returns"|"maxDrawdown">,period:Period) {
  const series=periodSeries(f,period),first=series[0],last=series.at(-1);
  const days=first&&last?(last.t-first.t)/86400000:0,partial=period==="1Y"&&days<365;
  if(period!=="1Y")return {returnPct:f.returns[period]??null,maxDrawdown:f.maxDrawdown[period]??null,days,partial};
  if(series.length<2||series.some((p,i)=>!Number.isFinite(p.v)||p.v<=0||!Number.isFinite(p.t)||(i>0&&p.t<=series[i-1].t)))return {returnPct:null,maxDrawdown:null,days,partial};
  let peak=first.v,maxDrawdown=0;
  for(const p of series){peak=Math.max(peak,p.v);maxDrawdown=Math.min(maxDrawdown,(p.v/peak-1)*100);}
  return {returnPct:(last!.v/first.v-1)*100,maxDrawdown,days,partial};
}
export function chartGeometry(series:readonly{t:number;v:number}[],width=320,height=64) {
  if(series.length<2||series.some((p,i)=>!Number.isFinite(p.v)||p.v<=0||!Number.isFinite(p.t)||(i>0&&p.t<=series[i-1].t)))return null;
  const values=series.map(p=>p.v),min=Math.min(...values),max=Math.max(...values),range=max-min||1;
  const from=series[0],last=series.at(-1)!,duration=last.t-from.t;
  const points=series.map(p=>({x:4+(p.t-from.t)/duration*(width-8),y:height-6-(p.v-min)/range*(height-12)}));
  return {path:points.map((p,i)=>`${i?"L":"M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" "),
    from:from.t,through:last.t,returnPct:(last.v/from.v-1)*100,last:points.at(-1)!};
}
