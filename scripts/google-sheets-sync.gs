/** VDS Pools — lecture seule des sources, envoi signé vers le portail privé.
 * Configuration privée injectée uniquement dans la copie remise au propriétaire.
 * Ne pas publier ce projet Apps Script ni partager son code.
 */
const VDS_SYNC_CONFIG = null;

function installerSynchronisationVDS() {
  if (!VDS_SYNC_CONFIG || !VDS_SYNC_CONFIG.secret || !VDS_SYNC_CONFIG.sources.length) throw new Error('Configuration privée manquante.');
  synchroniserVDS();
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'synchroniserVDS')) {
    ScriptApp.newTrigger('synchroniserVDS').timeBased().everyMinutes(1).create();
  }
  console.log('Synchronisation VDS installée. Consultez Données & accès dans le portail.');
}

function synchroniserVDS() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const cfg = VDS_SYNC_CONFIG;
    if (!cfg || !/^https:\/\/[a-z0-9-]+\.up\.railway\.app\/api\/sheets-sync$/.test(cfg.endpoint)) throw new Error('Destination privée invalide.');
    const token = ScriptApp.getOAuthToken();
    const headers = {Authorization: 'Bearer ' + token};
    const properties = PropertiesService.getScriptProperties();
    const requests = cfg.sources.map(source => ({url:'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(source.id) + '?fields=id,modifiedTime&supportsAllDrives=true',headers:headers,muteHttpExceptions:true}));
    const metadata = UrlFetchApp.fetchAll(requests);
    const heartbeats = [];
    cfg.sources.forEach((source,index) => {
      if(metadata[index].getResponseCode() !== 200) throw new Error('Lecture des métadonnées Google refusée ; sources précédentes conservées.');
      const version = JSON.parse(metadata[index].getContentText()).modifiedTime;
      const storedText = properties.getProperty('vds_' + source.id);
      const stored = storedText ? JSON.parse(storedText) : null;
      // Full read at least hourly catches formulas and external-data recalculation.
      if(stored && stored.modified === version && Date.now()-stored.readAt < 3600000){heartbeats.push({id:source.id,digest:stored.digest});return;}
      const metadataResponse = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(source.id)+'?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',{headers:headers,muteHttpExceptions:true});
      if(metadataResponse.getResponseCode() !== 200) throw new Error('Structure du classeur inaccessible.');
      const tabs = JSON.parse(metadataResponse.getContentText()).sheets;
      const ranges = source.tables.map(wanted => {
        const tab = tabs.find(s=>s.properties.title===wanted.tab && s.properties.sheetId===wanted.gid);
        if(!tab || tab.properties.gridProperties.rowCount>10000 || tab.properties.gridProperties.columnCount>50) throw new Error('Structure source à vérifier ; aucun import partiel.');
        return "'"+wanted.tab.replace(/'/g,"''")+"'!A1:"+columnVDS_(tab.properties.gridProperties.columnCount)+tab.properties.gridProperties.rowCount;
      });
      const url = 'https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(source.id)+'/values:batchGet?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS&'+ranges.map(r=>'ranges='+encodeURIComponent(r)).join('&');
      const response = UrlFetchApp.fetch(url,{headers:headers,muteHttpExceptions:true});
      if(response.getResponseCode()!==200)throw new Error('Lecture des valeurs refusée ; dernière version conservée.');
      const body = JSON.parse(response.getContentText());
      if(!body.valueRanges || body.valueRanges.length!==source.tables.length)throw new Error('Lecture source incomplète.');
      const after=UrlFetchApp.fetch(requests[index].url,{headers:headers,muteHttpExceptions:true});
      if(after.getResponseCode()!==200 || JSON.parse(after.getContentText()).modifiedTime!==version)throw new Error('Classeur modifié pendant la lecture ; nouvel essai au prochain passage.');
      const tables=source.tables.map((table,i)=>({key:source.key,id:source.id,tab:table.tab,gid:table.gid,values:(body.valueRanges[i].values||[]).map(row=>row.map(v=>v==null?'':String(v)))}));
      const receipt=envoyerVDS_({schemaVersion:'sheets-tables-1',readAt:new Date().toISOString(),tables:tables});
      properties.setProperty('vds_'+source.id,JSON.stringify({modified:version,readAt:Date.now(),digest:receipt.versions[source.id]}));
    });
    if(heartbeats.length)envoyerVDS_({schemaVersion:'sheets-heartbeat-1',versions:heartbeats});
  } catch (_) {
    // Do not log Google responses, customer values, OAuth grants or signed payloads.
    throw new Error('Synchronisation VDS interrompue. Les données précédentes sont conservées. Vérifiez les autorisations ou la structure des sources.');
  } finally {lock.releaseLock();}
}
function envoyerVDS_(payload){
  const body=JSON.stringify(payload),time=String(Date.now());
  const signature=Utilities.computeHmacSha256Signature(time+'.'+body,VDS_SYNC_CONFIG.secret,Utilities.Charset.UTF_8).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
  const r=UrlFetchApp.fetch(VDS_SYNC_CONFIG.endpoint,{method:'post',contentType:'application/json',payload:body,headers:{'X-VDS-Timestamp':time,'X-VDS-Signature':signature},followRedirects:false,muteHttpExceptions:true});
  if(r.getResponseCode()!==200)throw new Error('Le portail a refusé la mise à jour ; dernière version conservée.');
  return JSON.parse(r.getContentText());
}
function columnVDS_(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}
