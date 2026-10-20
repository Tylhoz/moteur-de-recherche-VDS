import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFinancialDocuments,completeMoneyTotal} from '../src/lib/business-finance.js';
const period={year:'2026',from:'',to:''};
const rows=[{id:'matched',dossierId:'VDS-001',date:'2026-01-15'},{id:'unmatched',dossierId:null,date:'2026-02-01'},{id:'other',dossierId:'VDS-002',date:'2026-03-01'},{id:'old',dossierId:'VDS-001',date:'2025-01-01'},{id:'undated',dossierId:null,date:null}];
test('financial scope never silently adds unmatched or filtered dossiers',()=>{
 assert.deepEqual(selectFinancialDocuments(rows,'dossiers',new Set(['VDS-001']),period).map(r=>r.id),['matched']);
 assert.deepEqual(selectFinancialDocuments(rows,'account',new Set(['VDS-001']),period).map(r=>r.id),['matched','unmatched','other']);
 assert.equal(rows[1].dossierId,null);
 assert.equal(selectFinancialDocuments(rows,'account',new Set(),{year:'',from:'',to:''}).length,5);
});
test('invoice period uses invoice dates independently of CRM activity dates',()=>{
 assert.equal(selectFinancialDocuments(rows,'dossiers',new Set(['VDS-001']),{year:'',from:'2026-01-15',to:'2026-01-15'}).length,1);
 assert.equal(selectFinancialDocuments(rows,'account',new Set(),{year:'',from:'2026-04-01',to:'2026-01-01'}).length,0);
});
test('unknown financial values and empty selections never become invented zeros',()=>{
 assert.equal(completeMoneyTotal([],n=>n),null);
 assert.equal(completeMoneyTotal([100,null],n=>n),null);
 assert.equal(completeMoneyTotal([100,-20,0],n=>n),80);
 assert.equal(completeMoneyTotal([Number.MAX_SAFE_INTEGER,1],n=>n),null);
});
