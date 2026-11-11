import type {RiskFreeReference} from "./risk-free-rates";

const DAY=86400000, YEAR=365;
export const MIN_RISK_OBSERVATIONS=90;
const sample=(values:number[])=>{
  let mean=0,m2=0,n=0;
  for(const value of values){const delta=value-mean;mean+=delta/++n;m2+=delta*(value-mean);}
  return {mean,sd:Math.sqrt(Math.max(0,m2/(n-1)))};
};
/** Read-only statistics of the selected NAV window; calendar-daily observations include market closures. */
export function analyzeFundPerformance(points:readonly {t:number;v:number}[],reference?:RiskFreeReference|null) {
  const result={returnPct:null as number|null,maxDrawdown:null as number|null,sharpe:null as number|null,volatility:null as number|null,
    observations:Math.max(0,points.length-1),riskNote:"",sharpeNote:""};
  if(points.length<2||points.some((p,i)=>!Number.isFinite(new Date(p.t).getTime())||!Number.isFinite(p.v)||p.v<=0||(i>0&&p.t<=points[i-1].t))){
    result.riskNote="Valid share-price history is unavailable.";return result;
  }
  result.returnPct=(points.at(-1)!.v/points[0].v-1)*100;
  let peak=points[0].v,drawdown=0;
  for(const p of points){peak=Math.max(peak,p.v);drawdown=Math.min(drawdown,(p.v/peak-1)*100);}
  result.maxDrawdown=drawdown;
  // Legacy models include a NAV=1 opening anchor and an identical first close on the same day.
  // Keep that anchor for cumulative return/drawdown, but do not count it as an extra daily return.
  if(Math.floor(points[0].t/DAY)===Math.floor(points[1].t/DAY)&&Math.abs(points[1].v/points[0].v-1)<1e-12)points=points.slice(1);
  result.observations=Math.max(0,points.length-1);
  if(points.some((p,i)=>i>0&&Math.floor(p.t/DAY)-Math.floor(points[i-1].t/DAY)!==1)){
    result.riskNote="Risk statistics need consecutive daily observations.";return result;
  }
  if(result.observations<MIN_RISK_OBSERVATIONS){result.riskNote=`Needs at least ${MIN_RISK_OBSERVATIONS} daily returns in this period.`;return result;}
  const returns=points.slice(1).map((p,i)=>p.v/points[i].v-1),raw=sample(returns);
  result.volatility=raw.sd*Math.sqrt(YEAR)*100;
  const rates=reference?.series==="DGS3MO"&&Array.isArray(reference.rates)?reference.rates:[];
  if(!rates.length||rates.some((r,i)=>!Number.isFinite(r.annualPct)||r.annualPct<=-100||r.annualPct>100||!/^20\d{2}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(Date.parse(r.date))||new Date(r.date).toISOString().slice(0,10)!==r.date||(i>0&&r.date<=rates[i-1].date))){
    result.sharpeNote="Historical Treasury reference is unavailable.";return result;
  }
  let cursor=-1;
  const excess:number[]=[];
  for(let i=0;i<returns.length;i++){
    const date=new Date(points[i].t).toISOString().slice(0,10);
    while(cursor+1<rates.length&&rates[cursor+1].date<=date)cursor++;
    const rate=rates[cursor],age=rate?(Date.parse(date)-Date.parse(rate.date))/DAY:Infinity;
    if(!rate||age>7){result.sharpeNote="Historical Treasury reference has missing or stale dates.";return result;}
    excess.push(returns[i]-Math.expm1(Math.log1p(rate.annualPct/100)/YEAR));
  }
  const stats=sample(excess);
  if(raw.sd<1e-12||stats.sd<1e-12){result.sharpeNote="Sharpe is undefined without measurable return variability.";return result;}
  result.sharpe=stats.mean/stats.sd*Math.sqrt(YEAR);
  return result;
}
