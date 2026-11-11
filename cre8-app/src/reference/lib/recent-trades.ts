import type {ModelAllocationUpdate} from "./demo-fund-backtest";
type Trade = {date:string;asset:string;side:string;value:number;reason:string};
type Fund = {nav?:{t:number;v:number}[];backtest?:{through:string;trades?:Trade[];lastTrades?:Trade[]}};
export type ModelTrade = {id:string;date:string;asset:string;side:"buy"|"sell";reason:string;navSharePct:number|null};
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+"T00:00:00Z"))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
/** Trade values and NAV share the backtest's unit principal. Their ratio does not invent a personal order amount. */
export function recentModelTrades(fund:Fund):ModelTrade[] {
  if(!fund.backtest)return [];
  const closes=new Map((fund.nav??[]).filter(p=>Number.isFinite(p.t)&&Number.isFinite(p.v)&&p.v>0).map(p=>[new Date(p.t).toISOString().slice(0,10),p.v]));
  return (fund.backtest.trades??fund.backtest.lastTrades??[]).flatMap((t,index)=>{
    if(!validDate(t.date)||t.date>fund.backtest!.through||!["buy","sell"].includes(t.side)||!Number.isFinite(t.value)||t.value<=0)return [];
    const nav=closes.get(t.date);
    return [{id:String(index),date:t.date,asset:t.asset,side:t.side as "buy"|"sell",reason:t.reason,navSharePct:nav?t.value/nav*100:null}];
  }).reverse().sort((a,b)=>b.date.localeCompare(a.date));
}
export function selectModelTrades(trades:ModelTrade[],filter:string,page=0,pageSize=20) {
  pageSize=Math.max(1,Math.min(100,Math.floor(Number.isFinite(pageSize)?pageSize:20)));
  const filtered=trades.filter(t=>!["buy","sell"].includes(filter)||t.side===filter),pages=Math.max(1,Math.ceil(filtered.length/pageSize));
  const current=Math.max(0,Math.min(pages-1,Math.floor(Number.isFinite(page)?page:0)));
  return {rows:filtered.slice(current*pageSize,(current+1)*pageSize),total:filtered.length,pages,page:current};
}
export function modelTradeSize(value:number|null) {return value===null||!Number.isFinite(value)||value<=0?"—":value<.01?"<0.01%":value.toFixed(2)+"%";}
export const modelTradeReason=(value:string)=>({"Rebalance":"Rebalance","Weekly tranche":"Weekly entry","Initial allocation":"Initial allocation","Allocation phase":"Allocation update"}[value]??value);

export type ModelTradeUpdate = {id:string;date:string;reason:string;summary:string;assets:string[];buys:number;sells:number;trades:ModelTrade[];positions:ModelAllocationUpdate["positions"];source?:string;sources?:{url:string;label:string;postedAt?:string;asOf?:string;published?:string}[];postedAt?:string;effectiveDate?:string;asOf?:string;published?:string;previousAsOf?:string;recordKind?:"holdings"|"rebalance"|"post-replay"};
export type UpdateSource = {url:string;label:string};
function sourceUrl(value:string|undefined|null) {
  try {const url=new URL(value??"");return url.protocol==="https:"&&!url.username&&!url.password?url:null;}catch{return null;}
}
/** A post is evidence only for the update that cites it. Never substitute an account homepage. */
export function recentUpdateSource(update:Pick<ModelTradeUpdate,"source">,group?:string):UpdateSource|null {
  if(group!=="people"&&group!=="x-voices")return null;
  const url=sourceUrl(update.source);if(!url)return null;
  if(group==="x-voices")return ["x.com","www.x.com","twitter.com","www.twitter.com"].includes(url.hostname)&&/^\/(?:i|[A-Za-z0-9_]{1,15})\/status\/\d+\/?$/.test(url.pathname)?{url:url.href,label:"X post"}:null;
  return {url:url.href,label:url.hostname==="www.sec.gov"||url.hostname==="sec.gov"?"SEC filing":url.hostname==="disclosures-clerk.house.gov"?"Disclosure":"Holdings source"};
}
export function recentUpdateSources(update:Pick<ModelTradeUpdate,"source"|"sources">,group?:string):UpdateSource[]{
  const rows=(update.sources?.length?update.sources.map(s=>s.url):[update.source]).map(source=>recentUpdateSource({source},group)).filter((source):source is UpdateSource=>source!==null);
  return [...new Map(rows.map(row=>[row.url,row])).values()];
}
/** Single-snapshot references can expose their allocation evidence without inventing trades. */
export function recentFundSources(fund:{group?:string;sourceModel?:{source?:string};backtest?:{targets?:{id:string;weight:number;source?:string|null}[]}}):UpdateSource[] {
  if(!fund.sourceModel)return [];
  if(fund.group==="x-voices"){
    const sources=new Map<string,UpdateSource>();
    for(const target of fund.backtest?.targets??[]){
      if(target.weight<=0||target.id==="USDT")continue;
      const source=recentUpdateSource({source:target.source??undefined},fund.group);if(!source)continue;
      const existing=sources.get(source.url);sources.set(source.url,{...source,label:existing?`${existing.label} / ${target.id}`:target.id});
    }
    return [...sources.values()];
  }
  const source=recentUpdateSource({source:fund.sourceModel.source},fund.group);return source?[source]:[];
}
/** A single allocation action becomes one investor update, with its exact model transactions underneath. */
export function modelTradeUpdates(trades:ModelTrade[],rebalance?:string,allocations:ModelAllocationUpdate[]=[]):ModelTradeUpdate[] {
  const groups=new Map<string,ModelTradeUpdate>();
  for(const trade of trades){
    const id=`${trade.date}:${trade.reason}`,group=groups.get(id)??{id,date:trade.date,reason:trade.reason,summary:"",assets:[],buys:0,sells:0,trades:[],positions:allocations.find(a=>a.date===trade.date&&a.reason===trade.reason)?.positions??[]};
    group.trades.push(trade);if(trade.side==="buy")group.buys++;else group.sells++;groups.set(id,group);
  }
  return [...groups.values()].map(group=>{
    const sizes=new Map<string,number>();for(const t of group.trades)sizes.set(t.asset,(sizes.get(t.asset)??0)+(t.navSharePct??0));
    group.assets=[...sizes].sort(([a,av],[b,bv])=>bv-av||a.localeCompare(b)).map(([asset])=>asset);
    const count=group.assets.length,activity=[group.buys?`${group.buys} ${group.buys===1?"buy":"buys"}`:"",group.sells?`${group.sells} ${group.sells===1?"sell":"sells"}`:""].filter(Boolean).join(" and ");
    const scope=`${count} ${count===1?"asset":"assets"}`;
    group.summary=group.reason==="Rebalance"?`${rebalance==="drift"?"Allocation drift triggered a rebalance":"Rebalanced toward the model’s target weights"} across ${scope}, with ${activity}.`:group.reason==="Weekly tranche"?`Deployed a weekly tranche across ${scope}, following the fund’s staged entry plan.`:group.reason==="Initial allocation"?`Built the model’s initial positions across ${scope}, following its target allocation.`:group.reason==="Allocation phase"?`Applied the model’s allocation update across ${scope}, with ${activity}.`:`Updated ${scope}, with ${activity}.`;
    return group;
  }).sort((a,b)=>b.date.localeCompare(a.date));
}
export function tradeUpdateDate(value:string,now=Date.now()) {
  const day=86400000,today=Math.floor(now/day),age=today-Math.floor(Date.parse(value+"T00:00:00Z")/day);
  return {recent:age>=0&&age<=7,label:age===0?"Today":age===1?"Yesterday":age>1&&age<=7?`${age} days ago`:new Date(value+"T00:00:00Z").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"})};
}

export type ModelPositionGroup="new"|"closed"|"increased"|"decreased"|"unchanged";
/** Compare observed weights immediately before/after the same allocation action at identical daily marks. */
export function modelPositionGroups(positions:ModelAllocationUpdate["positions"]) {
  const groups:Record<ModelPositionGroup,ModelAllocationUpdate["positions"]>={new:[],closed:[],increased:[],decreased:[],unchanged:[]};
  for(const position of positions){
    const {beforePct:before,afterPct:after}=position;
    if(!Number.isFinite(before)||!Number.isFinite(after)||before<0||after<0||before>100+1e-8||after>100+1e-8)continue;
    if(before<1e-8&&after<1e-8)continue;
    const kind:ModelPositionGroup=before<1e-8?"new":after<1e-8?"closed":Math.abs(after-before)<1e-8?"unchanged":after>before?"increased":"decreased";
    groups[kind].push(position);
  }
  return groups;
}
export function positionWeightLabels(before:number,after:number) {
  let digits=2;
  while(digits<6&&Math.abs(after-before)>=1e-8&&before.toFixed(digits)===after.toFixed(digits))digits++;
  const format=(value:number)=>value<1e-8?"0%":new Intl.NumberFormat("en-US",{maximumFractionDigits:digits}).format(value)+"%";
  return {before:format(before),after:format(after)};
}
