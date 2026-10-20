export type FinancialScope = 'dossiers' | 'account';
export interface FinancialPeriod { year:string; from:string; to:string; }
export const inFinancialPeriod = (date:string|null,period:FinancialPeriod) =>
 !period.year&&!period.from&&!period.to || !!date&&(!period.year||date.startsWith(period.year))&&(!period.from||date>=period.from)&&(!period.to||date<=period.to);
/** Dossier identity filters and invoice dates are independent. Unmatched documents are included only by explicit account scope. */
export function selectFinancialDocuments<T extends {dossierId:string|null;date:string|null}>(rows:T[],scope:FinancialScope,dossierIds:Set<string>,period:FinancialPeriod):T[]{
 return rows.filter(row=>(scope==='account'||!!row.dossierId&&dossierIds.has(row.dossierId))&&inFinancialPeriod(row.date,period));
}
export function completeMoneyTotal<T>(rows:T[],value:(row:T)=>number|null):number|null{
 if(!rows.length)return null;let total=0;
 for(const row of rows){const amount=value(row);if(amount===null||!Number.isSafeInteger(amount))return null;total+=amount;if(!Number.isSafeInteger(total))return null;}
 return total;
}
