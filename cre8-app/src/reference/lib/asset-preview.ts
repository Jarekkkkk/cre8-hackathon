import type { UnderlyingAsset } from "./underlying-assets";
import type { UnderlyingQuote } from "./fund-holdings";

export type AssetPreview = {
  slug:string;name:string;ticker:string;logo:string;price:number|null;currency:string;priceAsOf:string|null;
  priceBasis:string;change:number|null;changeLabel:string;size:number|null;sizeLabel:string;sizeAsOf:string|null;
  series:{t:number;v:number}[];historyThrough:string|null;historyBasis:string;historyCurrency:string;
};
type Quote = UnderlyingQuote & {changeSource?:string};
type Receipt = {url:string;status:number;body:string};
const positive=(value:unknown):number|null=>typeof value==="number"&&Number.isFinite(value)&&value>0?value:null;
const dollars=(value:unknown):number|null=>typeof value==="string"&&/^\$[\d,]+(?:\.\d+)?$/.test(value)?positive(Number(value.slice(1).replaceAll(",",""))):null;

/** Display quotes come from the same recorded provider response as the table change; never a token quote. */
export function createAssetPreviews(assets:UnderlyingAsset[],quotes:Record<string,Quote>,receipts:Receipt[]) {
  return Object.fromEntries(assets.map(asset=>{
    const namespace=asset.slug.startsWith("stock-")?"stock":asset.slug.startsWith("commodity-")?"commodity":"crypto";
    if(namespace==="crypto"&&asset.symbol==="USDT")return ["crypto:USDT",{slug:asset.slug,name:"USDT",ticker:"USDT",logo:asset.logo,price:null,currency:"USDT",priceAsOf:null,priceBasis:"Fund cash",change:null,changeLabel:"",size:null,sizeLabel:"",sizeAsOf:null,series:[],historyThrough:null,historyBasis:"Fund cash",historyCurrency:"USDT"} satisfies AssetPreview];
    const candidate=quotes[asset.symbol],quote=namespace==="stock"&&["equity","etf"].includes(candidate?.kind??"")?candidate:namespace==="crypto"&&candidate?.kind==="crypto"?candidate:undefined;
    let price:number|null=null,priceAsOf:string|null=null;
    if(quote?.changeSource&&quote.asOf){
      const receipt=receipts.find(r=>r.url===quote.changeSource&&r.status===200);
      if(!receipt)throw new Error(`Missing recorded price response: ${asset.symbol}`);
      const response=JSON.parse(receipt.body);
      if(namespace==="stock"){
        const info=response.data;
        if(info?.symbol!==asset.symbol||!["STOCKS","ETF"].includes(info.assetClass)||info.primaryData?.lastTradeTimestamp!==quote.asOf)throw new Error(`Price identity mismatch: ${asset.symbol}`);
        price=dollars(info.primaryData.lastSalePrice);
      } else if(namespace==="crypto"){
        const sourceId=quote.source?.split("/").at(-1),coin=Array.isArray(response)?response.find(c=>c.id===sourceId&&c.symbol?.toUpperCase()===asset.symbol):null;
        if(!coin||coin.last_updated!==quote.asOf)throw new Error(`Price identity mismatch: ${asset.symbol}`);
        price=positive(coin.current_price);
      }
      if(price!==null)priceAsOf=quote.asOf;
    }
    const history=asset.history,last=history.at(-1);
    const fallback=price===null;
    if(fallback&&last){price=last.v;priceAsOf=new Date(last.t).toISOString().slice(0,10);}
    const series=last?history.filter(p=>p.t>=last.t-30*86400000):[];
    const preview:AssetPreview={slug:asset.slug,name:asset.name,ticker:asset.symbol,logo:asset.logo,price,currency:fallback?asset.historyCurrency:"USD",priceAsOf,
      priceBasis:fallback?asset.historyBasis:"Recorded underlying reference price",change:fallback?null:quote?.change24h??null,changeLabel:namespace==="crypto"?"24H":"Session",
      size:asset.size,sizeLabel:asset.sizeKind,sizeAsOf:asset.sizeAsOf,series,historyThrough:asset.historyThrough,historyBasis:asset.historyBasis,historyCurrency:asset.historyCurrency};
    return [`${namespace}:${asset.symbol}`,preview];
  }));
}
const esc=(value:unknown)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
const money=(value:number|null)=>value===null?"—":value.toLocaleString("en-US",{style:"currency",currency:"USD",maximumFractionDigits:value<1?6:2,minimumFractionDigits:2});
const compact=(value:number|null)=>value===null?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",notation:"compact",maximumFractionDigits:2}).format(value);
const date=(value:string|null)=>value?(/^\d{4}-\d\d-\d\d/.test(value)?value.slice(0,10):value):"Unavailable";
export function previewSparkline(series:AssetPreview["series"]) {
  if(series.length<2||series.some((p,i)=>!Number.isFinite(p.v)||p.v<=0||!Number.isFinite(p.t)||i>0&&p.t<=series[i-1].t))return "";
  const lo=Math.min(...series.map(p=>p.v)),hi=Math.max(...series.map(p=>p.v)),span=hi-lo||1,start=series[0].t,duration=series.at(-1)!.t-start;
  return series.map((p,i)=>`${i?"L":"M"}${(2+(p.t-start)/duration*76).toFixed(1)},${(29-(p.v-lo)/span*25).toFixed(1)}`).join(" ");
}
export function assetPreviewMarkup(asset:AssetPreview,url:string,logoRoot:string) {
  try { if(!["http:","https:"].includes(new URL(url,"https://cre8.invalid").protocol))throw new Error("Unsafe asset URL"); } catch { throw new Error("Unsafe asset URL"); }
  if(asset.ticker==="USDT"&&asset.slug==="crypto-usdt")return `<button type="button" class="asset-preview-close" aria-label="Close asset preview">×</button><header><span class="asset-preview-heading"><img src="${esc(logoRoot+asset.logo.replace(/^\/logos\//,""))}" alt="" width="30" height="30"><strong id="asset-preview-title">USDT</strong></span></header><p class="asset-preview-dates">Fund cash</p><a class="asset-preview-details" href="${esc(url)}">View details <span aria-hidden="true">↗</span></a>`;
  const path=previewSparkline(asset.series),change=asset.change===null?"—":`${asset.change>0?"+":""}${asset.change.toFixed(2)}%`;
  const sign=asset.change!==null&&asset.change>.005?"pos":asset.change!==null&&asset.change<-.005?"neg":"";
  return `<button type="button" class="asset-preview-close" aria-label="Close asset preview">×</button>
    <header><span class="asset-preview-heading">${asset.logo?`<img src="${esc(logoRoot+asset.logo.replace(/^\/logos\//,""))}" alt="" width="30" height="30">`:""}<span><strong id="asset-preview-title">${esc(asset.name)}</strong>${asset.name===asset.ticker?"":`<small>${esc(asset.ticker)}</small>`}</span></span>${path?`<svg class="asset-preview-spark ${asset.series.at(-1)!.v>=asset.series[0].v?"asset-preview-up":"asset-preview-down"}" viewBox="0 0 80 32" role="img" aria-label="${esc(asset.historyBasis)} through ${esc(asset.historyThrough)}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`:""}</header>
    <div class="asset-preview-price"><strong title="${esc(asset.priceBasis)}">${money(asset.price)}<small>${esc(asset.currency)}</small></strong><span><small>${esc(asset.changeLabel)}:</small> <b class="${sign}">${change}</b></span></div>
    <div class="asset-preview-size"><span>${esc(asset.sizeLabel)}</span><strong title="As of ${esc(asset.sizeAsOf)}">${compact(asset.size)}</strong></div>
    <p class="asset-preview-dates">${asset.priceBasis.startsWith("XAUt")?"XAUt proxy · ":""}Price: ${esc(date(asset.priceAsOf))}${path?` · ${asset.historyBasis.includes("adjusted")?"Adjusted":esc(asset.historyCurrency)} chart to ${esc(asset.historyThrough)}`:""}</p>
    <a class="asset-preview-details" href="${esc(url)}">View details <span aria-hidden="true">↗</span></a>`;
}

/** One nonmodal card for hover, keyboard and touch; lives in the top layer so the table cannot clip it. */
export function attachAssetPreviews(root:HTMLElement,card:HTMLElement,lookup:(id:string)=>{asset:AssetPreview;url:string}|null,logoRoot:string) {
  const events=new AbortController(),signal=events.signal;
  let trigger:HTMLButtonElement|null=null,timer:ReturnType<typeof setTimeout>|null=null,pinned=false,opened=false,restoring=false;
  const cancel=()=>{if(timer!==null){clearTimeout(timer);timer=null;}};
  function position(){
    if(!trigger||!opened)return;
    const viewportWidth=document.documentElement.clientWidth||window.innerWidth,margin=12;
    card.style.maxWidth=`${Math.max(0,viewportWidth-2*margin)}px`;
    const rect=trigger.getBoundingClientRect(),width=card.offsetWidth,height=card.offsetHeight;
    card.style.left=`${Math.max(margin,Math.min(rect.left,viewportWidth-width-margin))}px`;
    card.style.top=`${Math.max(margin,Math.min(rect.top-height-10>=margin?rect.top-height-10:rect.bottom+10,window.innerHeight-height-margin))}px`;
  }
  function close(restore=false){cancel();if(!opened)return;opened=false;pinned=false;trigger?.setAttribute("aria-expanded","false");if(card.hidePopover&&card.isConnected)card.hidePopover();card.removeAttribute("data-open");if(restore&&trigger?.isConnected){restoring=true;trigger.focus({preventScroll:true});restoring=false;}trigger=null;}
  function show(button:HTMLButtonElement){
    cancel();if(!card.isConnected)return;
    const data=lookup(button.dataset.assetPreview??"");if(!data)return;
    if(trigger!==button){trigger?.setAttribute("aria-expanded","false");pinned=false;card.innerHTML=assetPreviewMarkup(data.asset,data.url,logoRoot);trigger=button;}
    button.setAttribute("aria-expanded","true");
    if(!opened){if(card.showPopover)card.showPopover();else card.setAttribute("data-open","");opened=true;}
    position();
  }
  const target=(event:Event)=>(event.target as Element)?.closest?.<HTMLButtonElement>("button[data-asset-preview]")??null;
  const later=()=>{cancel();if(!pinned)timer=setTimeout(()=>close(),180);};
  root.addEventListener("pointerover",event=>{const button=target(event);if(button&&event.pointerType==="mouse")show(button);},{signal});
  root.addEventListener("pointerout",event=>{const button=target(event),to=event.relatedTarget as Node|null;if(button&&!button.contains(to)&&!card.contains(to))later();},{signal});
  root.addEventListener("focusin",event=>{const button=target(event);if(button&&!restoring)show(button);},{signal});
  root.addEventListener("focusout",event=>{const to=event.relatedTarget as Node|null;if(!card.contains(to)&&!trigger?.contains(to))later();},{signal});
  root.addEventListener("click",event=>{const button=target(event);if(!button)return;if(opened&&trigger===button&&pinned){close();return;}show(button);pinned=true;if(event.detail===0)card.querySelector<HTMLAnchorElement>("a")?.focus({preventScroll:true});},{signal});
  card.addEventListener("pointerenter",cancel,{signal});card.addEventListener("pointerleave",later,{signal});
  card.addEventListener("focusout",event=>{const to=event.relatedTarget as Node|null;if(!card.contains(to)&&!trigger?.contains(to))close();},{signal});
  card.addEventListener("click",event=>{if((event.target as Element)?.closest(".asset-preview-close"))close(true);},{signal});
  document.addEventListener("pointerdown",event=>{if(!card.isConnected){events.abort();return;}if(!card.contains(event.target as Node)&&!trigger?.contains(event.target as Node))close();},{signal});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&opened){event.preventDefault();close(card.contains(document.activeElement));}},{signal});
  window.addEventListener("resize",position,{signal});window.addEventListener("scroll",event=>{if(card.contains(event.target as Node)||!trigger)return;const rect=trigger.getBoundingClientRect();if(!trigger.isConnected||rect.bottom<0||rect.top>window.innerHeight)close();else position();},{signal,passive:true,capture:true});
  return {abort:()=>{close();events.abort();}};
}
