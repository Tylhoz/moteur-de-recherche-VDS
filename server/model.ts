import schema from './canonical-schema.json' with { type: 'json' };
import { createHash } from 'node:crypto';

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
export type Tables = Record<string, Row[]>;
export interface Dataset { schemaVersion: '1'; tables: Tables }
export interface FieldSpec { name: string; type: string; required: boolean; values?: string[]; reference?: string }
export interface TableSpec { name: string; primary_key: string; fields: FieldSpec[] }
export class DataError extends Error { constructor(public code: string) { super(code); } }
const relation: TableSpec = { name: 'RELATIONS_SOURCE', primary_key: 'relation_source_id', fields: [
  {name:'relation_source_id',type:'uuid',required:true}, {name:'source_id',type:'uuid',required:true,reference:'SOURCES.source_id'},
  {name:'cible_table',type:'text',required:true}, {name:'cible_id',type:'uuid',required:true}, {name:'champ',type:'text',required:false},
  {name:'role',type:'enum',required:true,values:['etaye','contredit','contexte']}, {name:'cree_at',type:'datetime',required:true},
] };
export const specs = [...schema.tables as TableSpec[], relation];
export const specByName = new Map(specs.map(s => [s.name,s]));
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const datetimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
function validDate(value: string): boolean { const date=value.slice(0,10); return datePattern.test(date) && !isNaN(Date.parse(value)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date); }
export function safeLink(value: string): boolean {
  try {
    const u = new URL(value);
    if(u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if(!['docs.google.com','drive.google.com','mail.google.com','calendar.google.com'].includes(u.hostname)) return false;
    // Avoid signed links and credentials, including encoded fragment/query keys.
    let decoded=value;
    for(let i=0;i<3;i++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}
    if(/(?:access.?token|refresh.?token|signature|secret|password|api.?key|credential|authorization|jwt|[?&#](?:auth|token|key|sig)=)/i.test(decoded)) return false;
    return true;
  } catch { return false; }
}
function parseCell(value: unknown, f: FieldSpec): Cell {
  if(value === '' || value === undefined || value === null) { if(f.required) throw new DataError('required_field_missing'); return null; }
  if(f.type === 'bool') { if(value===true||value==='TRUE'||value==='true')return true; if(value===false||value==='FALSE'||value==='false')return false; throw new DataError('invalid_boolean'); }
  if(['int','cents','bps'].includes(f.type)) {
    if(typeof value==='string' && !/^-?(?:0|[1-9]\d*)$/.test(value)) throw new DataError('invalid_integer');
    if(typeof value!=='number'&&typeof value!=='string')throw new DataError('invalid_integer');
    const n=Number(value); if(!Number.isSafeInteger(n)||(f.type==='bps'&&(n<0||n>10000)))throw new DataError('invalid_integer'); return n;
  }
  if(typeof value!=='string' || value.length>12000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new DataError('invalid_text');
  // Narrative fields and source excerpts must not bypass the protected-link policy.
  // Reject rather than silently alter evidence supplied by a source.
  for(const link of value.match(/https?:\/\/[^\s<>"']+/gi)??[]){
    if(!safeLink(link.replace(/[),.;]+$/,'')))throw new DataError('unsafe_embedded_link');
  }
  if(f.type==='uuid'&&!uuid.test(value))throw new DataError('invalid_identifier');
  if(f.type==='enum'&&!f.values?.includes(value))throw new DataError('invalid_enum');
  if(f.type==='decimal'&&!/^-?\d+(?:\.\d+)?$/.test(value))throw new DataError('invalid_decimal');
  if(f.type==='date'&&(!datePattern.test(value)||!validDate(value)))throw new DataError('invalid_date');
  if(f.type==='datetime'&&(!datetimePattern.test(value)||!validDate(value)))throw new DataError('invalid_datetime');
  if(f.type==='url'&&!safeLink(value))throw new DataError('unsafe_source_link');
  return value;
}
export function validateDataset(input: unknown): Dataset {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new DataError('invalid_dataset');
  const raw=input as Record<string,unknown>;
  if(raw.schemaVersion!=='1'||Object.keys(raw).some(k=>!['schemaVersion','tables'].includes(k))||!raw.tables||typeof raw.tables!=='object'||Array.isArray(raw.tables))throw new DataError('invalid_dataset');
  const tables:Tables={}; let count=0;
  for(const [name,rows] of Object.entries(raw.tables as Record<string,unknown>)) {
    const spec=specByName.get(name); if(!spec||!Array.isArray(rows))throw new DataError('unsupported_table');
    count+=rows.length; if(count>100000)throw new DataError('dataset_too_large');
    const ids=new Set();
    tables[name]=rows.map(rawRow=> {
      if(!rawRow||typeof rawRow!=='object'||Array.isArray(rawRow)||Object.keys(rawRow).some(k=>!spec.fields.some(f=>f.name===k)))throw new DataError('unknown_column');
      const row:Row={};for(const field of spec.fields)row[field.name]=parseCell(rawRow[field.name],field);
      if(ids.has(row[spec.primary_key]))throw new DataError('duplicate_identifier'); ids.add(row[spec.primary_key]); return row;
    }).sort((a,b)=>String(a[spec.primary_key]).localeCompare(String(b[spec.primary_key])));
  }
  if(!tables.DOSSIERS||!tables.SOURCES||!tables.RELATIONS_SOURCE)throw new DataError('required_table_missing');
  for(const [name,rows] of Object.entries(tables))for(const row of rows)for(const f of specByName.get(name)!.fields)if(f.reference&&row[f.name]!==null){
    const [table,key]=f.reference.split('.');
    if(!tables[table]?.some(r=>r[key]===row[f.name]))throw new DataError('broken_reference');
  }
  for(const rel of tables.RELATIONS_SOURCE){
    const target=specByName.get(String(rel.cible_table));
    if(!target||!tables[target.name]?.some(r=>r[target.primary_key]===rel.cible_id)||rel.champ&&!target.fields.some(f=>f.name===rel.champ))throw new DataError('invalid_evidence_target');
  }
  for(const src of tables.SOURCES){
    if(src.etat_fiabilite==='confirmee' && (!src.verification_at||!src.verification_par||src.usage_source!=='production'||src.type_source==='inference_ia'))throw new DataError('unsubstantiated_confirmation');
  }
  const transactions = new Set<string>();const accountingProofs=new Set<string>();
  for(const p of tables.PAIEMENTS??[])if(p.transaction_externe_id){
    const key=`${p.systeme_financier}:${p.transaction_externe_id}`;
    if(transactions.has(key))throw new DataError('duplicate_transaction');transactions.add(key);
    const source=tables.SOURCES.find(s=>s.source_id===p.preuve_source_id);
    if(source&&p.statut_preuve==='verifie_comptable'){
      const proofKey=JSON.stringify([source.type_source,source.compte_source,source.objet_externe_id]);
      if(accountingProofs.has(proofKey))throw new DataError('duplicate_accounting_proof');accountingProofs.add(proofKey);
    }
    if(typeof p.montant_centimes==='number'&&p.montant_centimes<0)throw new DataError('negative_payment_use_direction');
  }
  return {schemaVersion:'1',tables:Object.fromEntries(Object.entries(tables).sort(([a],[b])=>a.localeCompare(b)))};
}
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function rowsFromValues(table:string, values: unknown): Row[] {
  const spec=specByName.get(table);if(!spec||!Array.isArray(values)||!values.length||!Array.isArray(values[0]))throw new DataError('missing_headers');
  const header=values[0];
  if(header.some(h=>typeof h!=='string'||!spec.fields.some(f=>f.name===h))||new Set(header).size!==header.length||spec.fields.some(f=>f.required&&!header.includes(f.name)))throw new DataError('invalid_headers');
  if(values.slice(1).some(row=>!Array.isArray(row)))throw new DataError('invalid_row');
  return values.slice(1).filter(row=>row.some((v:unknown)=>v!==''&&v!==null)).map(row=>{
    if(!Array.isArray(row)||row.length>header.length)throw new DataError('invalid_row');
    return Object.fromEntries(header.map((key,index)=>[key,row[index]??null]));
  });
}
