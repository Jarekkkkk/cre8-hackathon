import archived from "../data/fund-performance/2026-11-11/treasury-3m.json" with {type:"json"};

export type RiskFreeReference = {series:"DGS3MO";source:string;through:string;rates:{date:string;annualPct:number}[]};
export const ARCHIVED_RISK_FREE_REFERENCE = archived as RiskFreeReference;
export const riskFreeUrl=(through:string)=>`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO&cosd=2025-10-24&coed=${through}`;
export function parseRiskFreeRates(csv:string,through:string):RiskFreeReference {
  const [header,...lines]=csv.trim().split(/\r?\n/);
  if(header!=="observation_date,DGS3MO")throw new Error("Treasury reference identity mismatch");
  const rates:RiskFreeReference["rates"]=[];
  let previous="";
  for(const line of lines){
    const [date,value,...extra]=line.split(",");
    if(extra.length||!/^20\d{2}-\d{2}-\d{2}$/.test(date)||new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date||date<=previous||date>through)throw new Error("Invalid Treasury reference dates");
    previous=date;
    if(value===""||value===".")continue;
    const annualPct=Number(value);
    if(!Number.isFinite(annualPct)||annualPct<=-100||annualPct>100)throw new Error("Invalid Treasury reference yield");
    rates.push({date,annualPct});
  }
  if(!rates.length)throw new Error("Treasury reference unavailable");
  return {series:"DGS3MO",source:"https://fred.stlouisfed.org/series/DGS3MO",through,rates};
}
