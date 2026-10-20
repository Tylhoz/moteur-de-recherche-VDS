// Browser-only synthetic test fixture. Never imported by the production app.
import {build} from 'esbuild';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {accountingProjection} from '../server/railway/intelligence.ts';
import {buildBusinessDataset,businessQuery,summarizeBusiness,pageBusinessDocuments,pageBusinessDossiers} from '../server/railway/business-analytics.ts';
const clients=Array.from({length:510},(_,i)=>({id:'VDS-'+String(i+1).padStart(3,'0'),client:'TEST dossier '+(i+1),contact:'',address:'',modelTeam:'',techMacon:'',finance:'',statusAction:'',category:'non_verifie',soldeAmount:null,contractHT:null}));
const rows={clients:clients.slice(0,54).map((c,i)=>({id:i+1,external_id:c.id})),invoices:Array.from({length:20161},(_,i)=>({id:i+1,client_id:i<20000?i%54+1:99999,kind:'vat',income:'1',currency:'EUR',price_net:'100',price_gross:'121',paid:'0',issue_date:'2026-10-20',number:'TEST-'+(i+1),status:'sent'})),payments:[]};
const dataset=buildBusinessDataset(clients,new Map(),accountingProjection(rows,clients,'private-test'));
const meta={revision:'browser-test',accountingReadAt:'2026-10-20T00:00:00Z',sheetsReadAt:null,projectionPending:false,refreshing:false,error:null,paymentsEnabled:false,readOnly:true};
const built=await build({stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import BusinessAnalytics from "./src/components/BusinessAnalytics.tsx";createRoot(document.getElementById("root")).render(React.createElement(BusinessAnalytics,{onSelectClient:()=>{}}));',resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:'browser-test.js',format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
const js=built.outputFiles.find(f=>f.path.endsWith('.js')).text,css=built.outputFiles.find(f=>f.path.endsWith('.css'))?.text||'';
const server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(js);}else if(req.url==='/bundle.css'){res.setHeader('Content-Type','text/css');res.end(css);}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script defer src="/bundle.js"></script></body></html>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.VDS_TEST_CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1024,height:768},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));let maxItems=0,maxSummary=0,denied=false;
 await page.route('**/api/v1/**',async route=>{if(denied)return route.fulfill({status:401,json:{error:'authentication_required'}});const url=new URL(route.request().url()),query=businessQuery(route.request().postDataJSON());let body;
 if(url.pathname==='/api/v1/analytics/query'){body=summarizeBusiness(dataset,query,meta);maxSummary=Math.max(maxSummary,Buffer.byteLength(JSON.stringify(body)));}else if(url.pathname.endsWith('/documents')){body=pageBusinessDocuments(dataset,query,meta.revision);maxItems=Math.max(maxItems,body.items.length);}else body=pageBusinessDossiers(dataset,query,meta.revision);
 await route.fulfill({status:200,json:body});});
 await page.goto('http://127.0.0.1:'+server.address().port+'/__analytics_test');await page.getByRole('heading',{name:'Pilotage métier · sources réelles'}).waitFor();
 await page.getByLabel('Périmètre des graphiques financiers').selectOption('account');await page.getByText('20 161 pièces',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Consulter les pièces · 50 par page'}).click();await page.locator('.business360-documents article').first().waitFor();assert.equal(await page.locator('.business360-documents article').count(),50);
 const first=await page.locator('.business360-documents article strong').first().textContent();await page.getByRole('button',{name:'Suivant',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.business360-selection')?.textContent?.includes('page 2 sur'));assert.notEqual(await page.locator('.business360-documents article strong').first().textContent(),first);
 await page.getByLabel('Rechercher une pièce ou un dossier').fill('TEST-20161');await page.getByRole('button',{name:'Rechercher',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.business360-documents article').length===1);assert.match(await page.locator('.business360-documents').textContent(),/TEST-20161/);
 await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.locator('.business360-chart').filter({has:page.getByRole('heading',{name:'Facturation HTVA éligible',exact:true})}).getByRole('button').first().click();await page.waitForFunction(()=>document.querySelectorAll('.business360-documents article').length===50);
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);assert.equal(overflow,false);assert.equal(errors.length,0);assert.ok(maxSummary<64*1024);assert.ok(maxItems<=50);
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2),false);
 denied=true;await page.getByRole('button',{name:'Actualiser la synthèse',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.business360-kpis'));
 console.log(JSON.stringify({browser:'chromium',ipadAndPhone:true,paginationAndSearch:true,chartSources:true,authenticationPurgesData:true,maxSummaryBytes:maxSummary,maxDocumentsPerResponse:maxItems,pageErrors:errors.length}));
}finally{await browser.close();await new Promise(resolve=>server.close(()=>resolve()));}
