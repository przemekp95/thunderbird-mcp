"use strict";
const {it}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture(){
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');
 assert.ok(fs.existsSync(file),'Mail Merge controller is missing');
 const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ', '')+'\nthis.control=createMailMergeController;',c);
 let revision='source1',allowed=true,starts=0,authorizations=0,configures=0;let snapshot={success:true,digest:'plan1',messages:[{from:'me@example.com',to:'one@example.com',cc:'',bcc:'',subject:'Hello'}],sample:{body:'Hello'},state:'prepared'};
 const services={status:async()=>({available:true,version:'11.6.1'}),select:()=>{if(!allowed)throw Error('private');return {revision,identityId:'id1',email:'me@example.com'};},open:async()=>({}),query:async(_session,request)=>{if(request.operation==='configure')configures++;if(request.operation==='start'){starts++;return {success:true,state:'running',completed:0,total:1};}return snapshot;},hash:s=>'hash:'+s,validateRecipients:row=>{if(!row.to||row.to.includes('{{'))throw Error('Invalid recipient');},authorizeBatch:()=>{authorizations++;return {auditId:'audit1'};},audit:()=>{}};
 const api=c.control(services);
 return {api,services,setRevision:v=>{revision=v;},deny:()=>{allowed=false;},setSnapshot:v=>{snapshot=v;},starts:()=>starts,authorizations:()=>authorizations,configures:()=>configures};
}
async function prepare(f){return f.api({action:'prepare',windowId:'w1',expectedRevision:'source1',csv:'EMAIL\none@example.com\n'});}
it('prepares native preview without sending, validates full batch and returns a review revision',async()=>{const f=fixture();const r=await prepare(f);assert.equal(r.success,true);assert.equal(r.total,1);assert.ok(r.revision);assert.equal(f.starts(),0);assert.equal(f.authorizations(),0);});
it('requires fresh review and explicit confirmation, preserves denied or changed source',async()=>{for(const kind of ['confirmation','revision','source','account']){const f=fixture();const p=await prepare(f);if(kind==='source')f.setRevision('changed');if(kind==='account')f.deny();const r=await f.api({action:'send',windowId:'w1',expectedRevision:kind==='revision'?'stale':p.revision,confirmSend:kind!=='confirmation'});assert.equal(r.success,false,kind);assert.equal(f.starts(),0);assert.equal(f.authorizations(),0);}});
it('authorizes entire send batch before any native send; refuses quota/policy failures and duplicate attempts',async()=>{const f=fixture();const p=await prepare(f);f.services.authorizeBatch=()=>({error:'Daily limit exceeded'});assert.equal((await f.api({action:'send',windowId:'w1',expectedRevision:p.revision,confirmSend:true})).success,false);assert.equal(f.starts(),0);const g=fixture();const q=await prepare(g);assert.equal((await g.api({action:'send',windowId:'w1',expectedRevision:q.revision,confirmSend:true})).state,'running');assert.equal(g.authorizations(),1);assert.equal((await g.api({action:'send',windowId:'w1',expectedRevision:q.revision,confirmSend:true})).success,false);assert.equal(g.starts(),1);});
it('draft generation requires confirmation but never consumes sending quota',async()=>{const f=fixture();const p=await prepare(f);assert.equal((await f.api({action:'drafts',windowId:'w1',expectedRevision:p.revision,confirmCreate:true})).state,'running');assert.equal(f.authorizations(),0);});
it('refuses malformed input and invalid expanded recipients before starting',async()=>{for(const args of [{action:'prepare',csv:'x'.repeat(262145)},{action:'eval'},{action:'prepare',csv:'EMAIL\na\n',pauseSeconds:-1}]){const f=fixture();assert.equal((await f.api({windowId:'w1',expectedRevision:'source1',...args})).success,false);assert.equal(f.starts(),0);}const f=fixture();f.setSnapshot({success:true,digest:'bad',state:'prepared',messages:[{to:'{{EMAIL}}'}]});assert.equal((await prepare(f)).success,false);assert.equal(f.starts(),0);});
it('uncertain start is not retried, and status cannot inspect restricted accounts',async()=>{const f=fixture();const p=await prepare(f);const original=f.services.query;f.services.query=async(s,r)=>{if(r.operation==='start')throw Error('private');return original(s,r);};const r=await f.api({action:'send',windowId:'w1',expectedRevision:p.revision,confirmSend:true});assert.equal(r.state,'unconfirmed');assert.equal((await f.api({action:'send',windowId:'w1',expectedRevision:p.revision,confirmSend:true})).success,false);f.deny();assert.equal((await f.api({action:'status',windowId:'w1'})).success,false);});
it('registers a bounded Mail Merge tool and connects it to the native controller',()=>{const source=fs.readFileSync(require.resolve('../extension/mcp_server/api.js'),'utf8');assert.match(source,/name: "controlMailMerge"/);assert.match(source,/case "controlMailMerge":/);assert.match(source,/createNativeMailMergeServices/);});
it('can attach to the selected idle native dialog after a bridge update without opening a duplicate',async()=>{const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.native=createNativeMailMergeServices;',c);const source={win:{openDialog(){}}};const actor={sendQuery:async()=>({success:true})};const browser={browsingContext:{currentWindowGlobal:{documentURI:{spec:'moz-extension://fixed/content/dialog.html?5'},getActor:()=>actor}}};const ext={version:'11.6.1',getURL:p=>'moz-extension://fixed/'+p,tabManager:{getWrapper:()=>({id:5})}};const services=c.native({ChromeUtils:{importESModule:()=>({ExtensionParent:{GlobalManager:{getExtension:()=>ext}}}),registerWindowActor(){}},Services:{wm:{getEnumerator:()=>[{document:{querySelectorAll:()=>[browser]}}].values()}},select:()=>source});const result=await services.open('w1');assert.equal(result.browser,browser);assert.equal(result.tabId,5);assert.equal(result.win,source.win);});
it('refuses a source changed during native preparation and does not reveal underlying private errors',async()=>{const f=fixture();const original=f.services.query;f.services.query=async(s,r)=>{const value=await original(s,r);if(r.operation==='configure')f.setRevision('changed-during-preview');return value;};assert.equal((await prepare(f)).success,false);const g=fixture();g.services.select=()=>{throw Error('private-account-detail');};const result=await prepare(g);assert.equal(JSON.stringify(result).includes('private-account-detail'),false);});
it('reports a fixed native-open stage without exposing arbitrary exception text',async()=>{const f=fixture();f.services.open=async()=>{throw Error('private-token');};const r=await prepare(f);assert.equal(r.success,false);assert.equal(r.stage,'open');assert.equal(JSON.stringify(r).includes('private-token'),false);});
it('recovers only status and closure of a pre-existing batch after an extension update, never its send authorization',async()=>{const f=fixture();let attachments=0;f.services.attach=async()=>{attachments++;return {};};f.setSnapshot({success:true,state:'failed',completed:0,total:2});const r=await f.api({action:'status',windowId:'w1'});assert.equal(r.success,true);assert.equal(r.state,'failed');assert.equal(attachments,1);assert.equal(f.configures(),0);assert.equal((await f.api({action:'send',windowId:'w1',confirmSend:true})).success,false);assert.equal(f.starts(),0);assert.equal(f.authorizations(),0);assert.equal((await f.api({action:'close',windowId:'w1'})).success,true);});

it('reports bounded SMTP diagnostic codes while excluding credentials, message bodies and unrelated errors',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);
 vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.diagnose=collectMailMergeDiagnostics;',c);
 const r=c.diagnose({console:{getMessageArray:()=>[
  {sourceName:'resource:///modules/SmtpClient.sys.mjs',errorMessage:'535 Authentication failed token=secretvalue test@example.com https://secret.invalid abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',timeStamp:123},
  {sourceName:'resource:///modules/ImapClient.sys.mjs',errorMessage:'NS_ERROR_NET_TIMEOUT',timeStamp:124},
  {sourceName:'moz-extension://other/private.js',errorMessage:'private body'}
 ]}});
 assert.equal(r.errors.length,2);assert.match(r.errors[0].summary,/535 Authentication failed/);
 for(const secret of ['secretvalue','test@example.com','secret.invalid','abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG','private body'])assert.equal(JSON.stringify(r).includes(secret),false,secret);
 assert.equal(r.errors[1].code,'NS_ERROR_NET_TIMEOUT');
});

it('reads the retained native send report without sending or changing the selected composer',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.diagnose=collectMailMergeDiagnostics;',c);
 const r=c.diagnose({console:{getMessageArray:()=>[]}}, {mailmerge:{compose:{messageSend:{sendReport:{currentProcess:3,deliveryMode:0,errMessage:'451 temporary SMTP error'}}}}});
 assert.equal(r.nativeReport.currentProcess,3);assert.equal(r.nativeReport.code,'451');assert.equal(r.nativeReport.summary,'451 temporary SMTP error');
});

it('reads cached native progress and unregisters the probe without invoking send',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.diagnose=collectMailMergeDiagnostics;',c);
 let removed=false;const r=c.diagnose({console:{getMessageArray:()=>[]}}, {mailmerge:{progress:{registerListener(p){p.onStatusChange(null,null,5,'421 temporary failure');p.onStateChange(null,null,16,2153066798);},unregisterListener(){removed=true;}}}}, {generateQI:()=>()=>{}});
 assert.equal(removed,true);assert.equal(r.nativeProgress.summary,'421 temporary failure');assert.equal(r.nativeProgress.stateStatus,2153066798);
});

it('reads only error-level SMTP Console API events and redacts AUTH data',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.diagnose=collectMailMergeDiagnostics;',c);
 const r=c.diagnose({console:{getMessageArray:()=>[]}},null,{consoleEvents:()=>[
 {level:'debug',filename:'resource:///modules/SmtpClient.sys.mjs',arguments:['AUTH LOGIN c2VjcmV0']},
 {level:'error',filename:'resource:///modules/SmtpClient.sys.mjs',arguments:['Error sending message 421 Try later AUTH PLAIN c2VjcmV0']}
 ]});
 assert.equal(r.errors.length,1);assert.equal(r.errors[0].code,'421');assert.equal(JSON.stringify(r).includes('c2VjcmV0'),false);
});

it('includes bounded native mail warnings and native addon Error messages',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.diagnose=collectMailMergeDiagnostics;',c);
 const r=c.diagnose({console:{getMessageArray:()=>[]}},null,{mailMergeOrigin:'moz-extension://pinned/',consoleEvents:()=>[
 {level:'warn',filename:'moz-extension://pinned/experiment.js',arguments:[{message:'NS_ERROR_FAILURE native error'}]}],
 activityEvents:()=>[{displayText:'Sending failed for test@example.com',time:123,recoveryTipText:'451 try later'}]});
 assert.equal(r.errors[0].code,'NS_ERROR_FAILURE');assert.equal(r.activities.length,1);assert.equal(JSON.stringify(r).includes('test@example.com'),false);
});

it('reuses only unused reservations of a terminal failed batch, charges the uncertain retry and refuses duplication or a different recipient set',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.continuation=validateMailMergeContinuation;',c);
 const auth={auditId:'a'.repeat(24),phase:'authorized',operation:'mailMerge',accountId:'a35',messages:4,recipients:['a@a.pl','b@a.pl','c@a.pl','d@a.pl'],timestamp:'2026-10-29T10:00:00Z'};
 const result={auditId:auth.auditId,phase:'result',operation:'mailMerge',state:'failed',completed:1};
 const args={auditId:auth.auditId,accountId:'a35',recipients:auth.recipients.slice(1),date:'2026-10-29',used:8};
 const good=c.continuation([auth,result],args);assert.equal(good.reservedCredit,2);assert.equal(good.additionalQuota,1);
 for(const records of [[auth],[auth,{...result,state:'completed'}],[auth,result,{phase:'authorized',resumeOf:auth.auditId}], [{...auth,resumeOf:'old'},result]])assert.throws(()=>c.continuation(records,args));
 for(const change of [{accountId:'wrong'},{date:'2026-10-30'},{recipients:auth.recipients},{recipients:args.recipients.slice().reverse()},{used:2}])assert.throws(()=>c.continuation([auth,result],{...args,...change}));
});

it('serializes a reservation claim across separate composers',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.claim=claimMailMergeContinuation;',c);
 const id='b'.repeat(24),records=[{auditId:id,phase:'authorized',operation:'mailMerge',accountId:'a',messages:2,recipients:['a@a.pl','b@a.pl'],timestamp:'2026-10-29'}, {auditId:id,phase:'result',operation:'mailMerge',state:'failed',completed:0}];
 const args={auditId:id,accountId:'a',date:'2026-10-29',used:2,recipients:['a@a.pl','b@a.pl']};
 assert.equal(c.claim(records,args).reservedCredit,1);assert.throws(()=>c.claim(records,args));
});

it('refuses native start if the source changes while an asynchronous reservation is checked',async()=>{
 const f=fixture(),p=await prepare(f);f.services.authorizeBatch=async()=>{f.setRevision('changed-during-authorization');return {auditId:'a'};};
 const r=await f.api({action:'send',windowId:'w1',expectedRevision:p.revision,confirmSend:true});assert.equal(r.success,false);assert.equal(f.starts(),0);
});

it('captures native failure before Mail Merge clears progress, preserving original callbacks and restoring its property',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.install=installMailMergeProgressCapture;this.read=readMailMergeProgressCapture;',c);
 const win={mailmerge:{progressListener:null}};let called=0;const stop=c.install(win);const listener={onStateChange(){called++;},onStatusChange(){called++;}};win.mailmerge.progressListener=listener;
 listener.onStatusChange(null,null,5,'private raw message');listener.onStateChange(null,null,16,2152398850);
 assert.equal(called,2);const r=c.read(win);assert.equal(r.at(-1).status,2152398850);assert.equal(JSON.stringify(r).includes('private raw message'),false);
 stop();assert.equal(Object.getOwnPropertyDescriptor(win.mailmerge,'progressListener').value,listener);
});

it('continues a verified reservation chain once and rejects forged credit, cycles, branches and stale ancestors',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.continuation=validateMailMergeContinuation;',c);
 const root={auditId:'c'.repeat(24),phase:'authorized',operation:'mailMerge',accountId:'a',messages:4,recipients:['a@a.pl','b@a.pl','c@a.pl','d@a.pl'],timestamp:'2026-10-29'};
 const end={auditId:root.auditId,phase:'result',operation:'mailMerge',state:'failed',completed:1};
 const child={...root,auditId:'d'.repeat(24),resumeOf:root.auditId,reservationCredit:2,messages:3,recipients:root.recipients.slice(1)};
 const childEnd={...end,auditId:child.auditId};const records=[root,end,child,childEnd];
 const args={auditId:child.auditId,accountId:'a',date:'2026-10-29',used:5,recipients:child.recipients.slice(1)};
 assert.equal(c.continuation(records,args).reservedCredit,1);
 for(const altered of [[{...root,timestamp:'2026-10-28'},end,child,childEnd],[root,end,{...child,reservationCredit:3},childEnd],[root,end,{...child,resumeOf:child.auditId},childEnd],[...records,{...child,auditId:'e'.repeat(24)}]])assert.throws(()=>c.continuation(altered,args));
 assert.throws(()=>c.continuation(records,{...args,used:4}));
});
it('captures a native copy failure category even when its numeric status is zero without retaining private strings',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.install=installMailMergeProgressCapture;this.read=readMailMergeProgressCapture;',c);
 const win={mailmerge:{},document:{getElementById:()=>({getString:k=>({copyMessageFailed:'private localized failure',copyMessageComplete:'private localized success'})[k]})}};
 c.install(win);win.mailmerge.progressListener={onStatusChange(){}};win.mailmerge.progressListener.onStatusChange(null,null,0,'private localized failure');
 assert.equal(c.read(win)[0].category,'copyFailed');assert.equal(JSON.stringify(c.read(win)).includes('private localized'),false);
});

it('disables only the native send progress preference with explicit confirmation and never starts mail',async()=>{
 const f=fixture();let changes=0;f.services.background=()=>{changes++;return {sendProgressWindow:false};};
 assert.equal((await f.api({action:'background'})).success,false);assert.equal(changes,0);
 const r=await f.api({action:'background',confirmChange:true});assert.equal(r.success,true);assert.equal(r.sendProgressWindow,false);assert.equal(changes,1);assert.equal(f.starts(),0);
});
it('skips exactly one provider-confirmed uncertain recipient without charging a resend or permitting arbitrary omissions',()=>{
 const file=require('node:path').join(__dirname,'../extension/mcp_server/mail_merge.sys.mjs');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(file,'utf8').replaceAll('export ','')+'\nthis.continuation=validateMailMergeContinuation;',c);
 const id='f'.repeat(24),records=[{auditId:id,phase:'authorized',operation:'mailMerge',accountId:'a',messages:4,recipients:['a@a.pl','b@a.pl','c@a.pl','d@a.pl'],timestamp:'2026-10-29'},{auditId:id,phase:'result',operation:'mailMerge',state:'failed',completed:1}];
 const args={auditId:id,accountId:'a',date:'2026-10-29',used:4,skipAcceptedFirst:true,recipients:['c@a.pl','d@a.pl']};
 assert.equal(c.continuation(records,args).reservedCredit,2);assert.equal(c.continuation(records,args).additionalQuota,0);
 assert.throws(()=>c.continuation(records,{...args,skipAcceptedFirst:false}));assert.throws(()=>c.continuation(records,{...args,recipients:['d@a.pl']}));
});
