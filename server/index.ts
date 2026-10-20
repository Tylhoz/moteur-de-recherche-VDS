import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApi } from './api.js';
import { GoogleSheetsProvider, PrivateFileProvider, UnconfiguredProvider, type Provider } from './providers.js';
import { ReadonlyStore } from './sync.js';
import { PortalStore, PrivateNativeReadProvider, type PortalProvider } from './portal.js';
import { GoogleLegacySheetsProvider } from './google-legacy.js';
import { GoogleRefreshTokenProvider } from './google-auth.js';

async function main(){
  let provider:Provider=new UnconfiguredProvider();
  const mode=process.env.VDS_DATA_PROVIDER??'none';
  if(mode==='private_file'){
    if(!process.env.VDS_PRIVATE_DATA_ROOT||!process.env.VDS_PRIVATE_DATA_FILE)throw new Error('private_data_configuration_missing');
    provider=new PrivateFileProvider(process.env.VDS_PRIVATE_DATA_FILE,process.env.VDS_PRIVATE_DATA_ROOT,[resolve('public'),resolve('dist'),resolve('src')]);
  }else if(mode==='google_sheets'){
    if(!process.env.VDS_SHEETS_MANIFEST)throw new Error('sheets_manifest_missing');
    const manifest=JSON.parse(await readFile(process.env.VDS_SHEETS_MANIFEST,'utf8'));
    provider=new GoogleSheetsProvider(manifest,async()=>process.env.VDS_GOOGLE_ACCESS_TOKEN);
  }else if(mode!=='none')throw new Error('unknown_provider');
  let portal:PortalStore|undefined;
  const portalMode=process.env.VDS_PORTAL_PROVIDER??'none';
  if(portalMode!=='none'){
    const privateRoot=process.env.VDS_PRIVATE_DATA_ROOT,pilotFile=process.env.VDS_PILOT_FILE,identityBaselineFile=process.env.VDS_IDENTITY_BASELINE_FILE;
    if(!privateRoot||!pilotFile||!identityBaselineFile)throw new Error('private_portal_configuration_missing');
    const forbiddenRoots=[resolve('public'),resolve('dist'),resolve('src')];
    let portalProvider:PortalProvider;
    if(portalMode==='private_native_read'){
      if(!process.env.VDS_NATIVE_READ_FILE)throw new Error('native_read_file_missing');
      portalProvider=new PrivateNativeReadProvider(process.env.VDS_NATIVE_READ_FILE,privateRoot,forbiddenRoots);
    }else if(portalMode==='google_sheets'){
      const oauth=new GoogleRefreshTokenProvider(process.env);
      portalProvider=new GoogleLegacySheetsProvider(oauth.getAccessToken);
    }else throw new Error('unknown_portal_provider');
    portal=new PortalStore({provider:portalProvider,privateRoot,pilotFile,identityBaselineFile,forbiddenRoots,journalFile:process.env.VDS_SYNC_JOURNAL_FILE});
  }
  const port=Number(process.env.VDS_API_PORT??'8787');if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid_port');
  const app=createApi({store:new ReadonlyStore(provider),portal,bearerSha256:process.env.VDS_API_BEARER_SHA256,allowedOrigins:process.env.VDS_ALLOWED_ORIGIN?[process.env.VDS_ALLOWED_ORIGIN]:[]});
  app.listen(port,'127.0.0.1',()=>process.stdout.write(`VDS read-only API ready on loopback port ${port}; provider=${mode}; no external connection verified.\n`));
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>app.close(()=>process.exit(0)));
}
main().catch(()=>{process.stderr.write('VDS API startup refused: check server-side configuration. No credentials logged.\n');process.exitCode=1;});
