import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { DataError, digest, rowsFromValues, specByName, validateDataset, type Dataset, type Tables } from './model.js';

export interface Provider { kind: 'none'|'private_file'|'google_sheets'; read(): Promise<Dataset>; }
export class UnconfiguredProvider implements Provider {
  kind='none' as const;
  async read(): Promise<Dataset> { throw new DataError('source_not_configured'); }
}
const maxBytes=12*1024*1024;
export class PrivateFileProvider implements Provider {
  kind='private_file' as const;
  constructor(private filename:string, private privateRoot:string, private forbiddenRoots:string[]){}
  async read():Promise<Dataset>{
    const root=await realpath(this.privateRoot);const file=await realpath(this.filename);
    const rel=relative(root,file);
    if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel)||file===root)throw new DataError('private_file_outside_root');
    for(const denied of this.forbiddenRoots){
      let actual:string;try{actual=await realpath(denied);}catch{actual=resolve(denied);}
      const path=relative(actual,file);if(!path||(!path.startsWith(`..${sep}`)&&path!=='..'&&!isAbsolute(path)))throw new DataError('public_data_source_forbidden');
    }
    const info=await stat(file);if(!info.isFile()||info.size>maxBytes||(info.mode&0o077)!==0)throw new DataError('private_file_permissions_or_size');
    const content=await readFile(file,'utf8'); if(Buffer.byteLength(content)>maxBytes)throw new DataError('dataset_too_large');
    return validateDataset(JSON.parse(content));
  }
}
export interface SheetRange { table:string; spreadsheetId:string; range:string; }
export interface SheetManifest { schemaVersion:'1'; ranges:SheetRange[]; }
export function validateManifest(input:unknown):SheetManifest {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new DataError('invalid_manifest');
  const raw=input as Record<string,unknown>;
  if(raw.schemaVersion!=='1'||Object.keys(raw).some(k=>!['schemaVersion','ranges'].includes(k))||!Array.isArray(raw.ranges)||!raw.ranges.length||raw.ranges.length>18)throw new DataError('invalid_manifest');
  const tables=new Set();
  const ranges=raw.ranges.map(r=>{
    if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='range,spreadsheetId,table')throw new DataError('invalid_manifest');
    const {table,spreadsheetId,range}=r;
    if(typeof table!=='string'||!specByName.has(table)||tables.has(table))throw new DataError('invalid_manifest');tables.add(table);
    if(typeof spreadsheetId!=='string'||!/^[A-Za-z0-9_-]{20,160}$/.test(spreadsheetId))throw new DataError('invalid_manifest');
    // Explicit bounded A1 rectangles only. No open ranges, named ranges or URL input.
    const match=typeof range==='string'?/^'([A-Za-z0-9_ -]{1,100})'!A1:([A-Z]{1,2})([1-9]\d{0,4})$/.exec(range):null;
    if(!match||Number(match[3])>10000)throw new DataError('invalid_manifest');
    return {table,spreadsheetId,range};
  });
  if(!['DOSSIERS','SOURCES','RELATIONS_SOURCE'].every(t=>tables.has(t)))throw new DataError('required_table_missing');
  return {schemaVersion:'1',ranges};
}
export type TokenProvider = ()=>Promise<string|undefined>;
export class GoogleSheetsProvider implements Provider {
  kind='google_sheets' as const;
  private manifest:SheetManifest;
  constructor(manifest:unknown, private token:TokenProvider, private request:typeof fetch=fetch){ this.manifest=validateManifest(manifest); }
  private async readPass():Promise<Tables>{
    const token=await this.token();if(!token||/[\r\n]/.test(token))throw new DataError('google_credentials_missing');
    const tables:Tables={};
    // Group by explicitly allowed workbook; the caller cannot supply IDs or ranges.
    for(const spreadsheetId of new Set(this.manifest.ranges.map(r=>r.spreadsheetId))){
      const entries=this.manifest.ranges.filter(r=>r.spreadsheetId===spreadsheetId);
      const url=new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet`);
      for(const e of entries)url.searchParams.append('ranges',e.range);
      url.searchParams.set('valueRenderOption','UNFORMATTED_VALUE');url.searchParams.set('dateTimeRenderOption','FORMATTED_STRING');
      const response=await this.request(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw new DataError(response.status===401||response.status===403?'google_access_denied':'google_read_failed');
      const length=Number(response.headers.get('content-length')??'0');if(length>maxBytes)throw new DataError('dataset_too_large');
      const reader=response.body?.getReader();if(!reader)throw new DataError('invalid_google_response');
      let size=0;const parts:Uint8Array[]=[];
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new DataError('dataset_too_large');}parts.push(value);}}finally{reader.releaseLock();}
      const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(body.spreadsheetId!==spreadsheetId||!Array.isArray(body.valueRanges)||body.valueRanges.length!==entries.length)throw new DataError('invalid_google_response');
      for(let i=0;i<entries.length;i++){
        if(body.valueRanges[i].majorDimension&&body.valueRanges[i].majorDimension!=='ROWS')throw new DataError('invalid_google_response');
        const values=body.valueRanges[i].values;
        const endRow=Number(entries[i].range.match(/([0-9]+)$/)![1]);
        if(Array.isArray(values)&&values.length>=endRow)throw new DataError('range_limit_reached');
        tables[entries[i].table]=rowsFromValues(entries[i].table,values);
      }
    }
    return tables;
  }
  async read():Promise<Dataset>{
    // Sheets has no multi-workbook snapshot transaction. Two equal bounded reads
    // detect changes during a read, but do not claim a database-level transaction.
    const first=validateDataset({schemaVersion:'1',tables:await this.readPass()});
    const second=validateDataset({schemaVersion:'1',tables:await this.readPass()});
    if(digest(first)!==digest(second))throw new DataError('source_changed_during_read');
    return second;
  }
}
export interface AccountingReadAdapter {
  readonly name:'vosfactures'; readonly enabled:false;
  readVerifiedPayments():Promise<never>;
}
export const vosFactures:AccountingReadAdapter={name:'vosfactures',enabled:false,async readVerifiedPayments(){throw new DataError('vosfactures_not_connected');}};
