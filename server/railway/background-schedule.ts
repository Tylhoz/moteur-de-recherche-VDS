/** One coalesced job per service. Nightly hour is explicitly UTC. */
export function backgroundSchedule(env:NodeJS.ProcessEnv){
 const mode=env.VDS_ACCOUNTING_SYNC_SCHEDULE||'hourly';if(!['hourly','nightly'].includes(mode))throw Error('background_schedule_invalid');
 const hour=Number(env.VDS_ACCOUNTING_SYNC_UTC_HOUR??'2');if(!Number.isInteger(hour)||hour<0||hour>23)throw Error('background_schedule_invalid');
 const seconds=Number(env.VDS_ACCOUNTING_SYNC_INTERVAL_SECONDS??3600);if(!Number.isInteger(seconds)||seconds<300||seconds>86400)throw Error('background_schedule_invalid');
 let next=0,running:Promise<void>|null=null;
 const deadline=(now:number)=>{if(mode==='hourly')return now+seconds*1000;const date=new Date(now);date.setUTCHours(hour,0,0,0);if(date.getTime()<=now)date.setUTCDate(date.getUTCDate()+1);return date.getTime();};
 return {mode,intervalSeconds:mode==='hourly'?seconds:null,utcHour:mode==='nightly'?hour:null,
  async run(job:()=>Promise<void>,now=Date.now(),force=false){if(running)return running;if(!force&&now<next)return;next=deadline(now);running=Promise.resolve().then(job);try{await running;}finally{running=null;}},
  nextRunAt:()=>next?new Date(next).toISOString():null,
 };
}
