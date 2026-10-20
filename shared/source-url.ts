/** One allowlist shared by analytics producers and consumers. Never allow credential-bearing links. */
export function safeAnalyticsSourceUrl(value:unknown):string|null{
 if(typeof value!=='string'||!value)return null;
 try{const url=new URL(value),calendarAlias=url.hostname==='www.google.com'&&url.pathname==='/calendar/event'&&!!url.searchParams.get('eid');
 const google=calendarAlias||['mail.google.com','drive.google.com','docs.google.com','calendar.google.com'].includes(url.hostname);
 const accounting=/^[a-z0-9-]+\.vosfactures\.fr$/.test(url.hostname)&&/^\/(?:invoices|clients)\/\d+$/.test(url.pathname)&&!url.search&&!url.hash;
 return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(google||accounting)&&![...url.searchParams.keys()].some(k=>/token|secret|password|signature|credential|api.?key|resourcekey/i.test(k))?url.href:null;
 }catch{return null;}
}
