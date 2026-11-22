// Mail Merge 11.6.1 only. The controller owns reviewed batches and irreversible
// attempt state; the page actor owns native expansion and execution.
export function createMailMergeController(services) {
  const sessions = new Map();
  const busy = new Set();
  return async function control(args) {
    let session;
    let stage = 'validate';
    let ownsLock = false;
    try {
      if (!args || !['status','background','prepare','preview','drafts','send','close'].includes(args.action)) throw Error('Invalid action');
      if (args.action === 'background') {
        if(args.confirmChange!==true || !services.background)throw Error('Explicit confirmation required');
        return {success:true,...services.background(),sendsMail:false};
      }
      if (args.action === 'status' && !args.windowId) return {success:true,...await services.status()};
      if (typeof args.windowId !== 'string' || !args.windowId || busy.has(args.windowId)) throw Error('Unavailable editor');
      busy.add(args.windowId); ownsLock = true;
      stage = 'select';
      const source = services.select(args.windowId);
      session = sessions.get(args.windowId);
      if (args.action === 'prepare') {
        if (session?.attempted || source.revision !== args.expectedRevision ||
            typeof args.csv !== 'string' || !args.csv || args.csv.length > 262144 || args.csv.includes('\0') ||
            (args.pauseSeconds !== undefined && (!Number.isInteger(args.pauseSeconds) || args.pauseSeconds < 0 || args.pauseSeconds > 60)) ||
            (args.start !== undefined && (!Number.isInteger(args.start) || args.start < 1 || args.start > 500)) ||
            (args.stop !== undefined && (!Number.isInteger(args.stop) || args.stop < (args.start || 1) || args.stop > 500))) throw Error('Invalid preparation');
        if (!session) {
          if (sessions.size >= 20) throw Error('Close an unused session first');
          stage = 'open';
          session = {native:await services.open(args.windowId),attempted:false};
          sessions.set(args.windowId,session);
        }
        stage = 'configure';
        const planningSource=services.select(args.windowId);
        const preview = await services.query(session.native,{operation:'configure',csv:args.csv,start:args.start || 1,stop:args.stop || 500,pauseSeconds:args.pauseSeconds || 0});
        if(!preview.success)throw Error('Native preview: '+(preview.diagnostic || preview.error || 'failed'));
        if (!Array.isArray(preview.messages) || !preview.messages.length || preview.messages.length > 500 || !preview.digest) throw Error('Native preview failed');
        for (const row of preview.messages) services.validateRecipients(row,planningSource);
        session.source = services.select(args.windowId);
        if(session.source.revision!==planningSource.revision || session.source.identityId!==planningSource.identityId)throw Error('Source changed during preparation');
        session.preview = preview;
        session.revision = services.hash(JSON.stringify({source:session.source.revision,digest:preview.digest}));
        return {success:true,windowId:args.windowId,total:preview.messages.length,revision:session.revision,sourceRevision:session.source.revision,
          messages:preview.messages,sample:preview.sample,state:'prepared',security:{content:'untrusted email content'}};
      }
      if (!session && ['status','close'].includes(args.action) && services.attach) {
        if (sessions.size >= 20) throw Error('Close an unused session first');
        // Restartless upgrades lose parent state, but the native page may still
        // own an attempted batch. Recover observation/closure only; never send.
        session={native:await services.attach(args.windowId),attempted:true};
        sessions.set(args.windowId,session);
      }
      if (!session) throw Error('Prepare the selected editor first');
      if (args.action === 'status') {
        const result = await services.query(session.native,{operation:'status'});
        if (session.auditId && !session.audited && ['completed','failed','unconfirmed'].includes(result.state)) {
          services.audit({auditId:session.auditId,phase:'result',operation:'mailMerge',state:result.state,completed:result.completed}); session.audited=true;
        }
        return {success:result.success===true,windowId:args.windowId,revision:session.revision,sourceRevision:source.revision,...result,diagnostics:services.diagnostics?.(source)};
      }
      if (args.action === 'close') {
        const state = await services.query(session.native,{operation:'status'});
        if (state.state === 'running') throw Error('Batch still running');
        const closed = await services.query(session.native,{operation:'close'});
        if (closed.success) sessions.delete(args.windowId);
        return closed;
      }
      if (session.attempted || source.revision !== session.source.revision || args.expectedRevision !== session.revision) throw Error('Stale or attempted batch');
      const current = await services.query(session.native,{operation:'status'});
      if (current.digest !== session.preview.digest || current.state !== 'prepared') throw Error('Native state changed');
      if (args.action === 'preview') return {success:true,revision:session.revision,total:session.preview.messages.length,...session.preview};
      if (args.action === 'drafts' && args.confirmCreate !== true || args.action === 'send' && args.confirmSend !== true) throw Error('Explicit confirmation required');
      if (!['drafts','send'].includes(args.action)) throw Error('Unsupported action');
      if (args.action === 'send') {
        const authorization = await services.authorizeBatch(session.preview.messages,source,args.windowId,args.resumeAuditId,args.resumeSkipAcceptedFirst);
        if (authorization.error) return {success:false,error:authorization.error};
        session.auditId=authorization.auditId;
      }
      const freshSource=services.select(args.windowId);
      if(freshSource.revision!==session.source.revision || freshSource.identityId!==session.source.identityId)throw Error('Source changed during authorization');
      // Mark before crossing the actor boundary. A lost reply must never start
      // this batch twice, even when the first native call had an uncertain result.
      session.attempted=true;
      const result=await services.query(session.native,{operation:'start',digest:session.preview.digest,mode:args.action==='send'?'SendNow':'SaveAsDraft'});
      return {...result,windowId:args.windowId,deliveryEvidence:'Native completion requires separate Drafts/Sent verification; never retry an uncertain batch'};
    } catch(error) {
      return {success:false,stage,diagnostic:String(error.name || 'Error').slice(0,80),state:session?.attempted?'unconfirmed':'refused',error:'Mail Merge operation refused or unconfirmed; inspect status before retrying'};
    } finally { if (ownsLock) busy.delete(args.windowId); }
  };
}

export function createNativeMailMergeServices({ChromeUtils,Services,actorModuleUri,select,hash,validateRecipients,authorizeBatch,audit}) {
  const addonId='mailmerge@example.net';
  const actorName='ThunderbirdMcpMailMerge120';
  function extension() {
    const {ExtensionParent}=ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
    const ext=ExtensionParent.GlobalManager.getExtension(addonId);
    if (!ext || ext.version!=='11.6.1') throw Error('Supported active Mail Merge 11.6.1 required');
    return ext;
  }
  function register(ext) {
    try { ChromeUtils.registerWindowActor(actorName,{child:{esModuleURI:actorModuleUri},matches:[ext.getURL('_generated_background_page.html'),ext.getURL('content/dialog.html')+'*'],allFrames:false}); }
    catch(error) { if(error.name!=='NotSupportedError') throw error; }
  }
  function actor(browser) {return browser?.browsingContext?.currentWindowGlobal?.getActor(actorName);}
  function findDialog(ext,tabId) {
    const target=ext.getURL('content/dialog.html')+'?'+tabId;
    for (const win of Services.wm.getEnumerator(null)) {
      for (const browser of win.document?.querySelectorAll('browser') || []) {
        if (browser.browsingContext?.currentWindowGlobal?.documentURI?.spec === target) return browser;
      }
    }
    return null;
  }
  return {
    select,hash,validateRecipients,authorizeBatch,audit,
    background:()=>{Services.prefs.setBoolPref('mailnews.show_send_progress',false);return {sendProgressWindow:Services.prefs.getBoolPref('mailnews.show_send_progress'),scope:'Thunderbird native send progress window'};},
    diagnostics:source=>collectMailMergeDiagnostics(Services,source.win,{generateQI:ChromeUtils.generateQI,
      consoleEvents:()=>Cc['@mozilla.org/consoleAPI-storage;1'].getService(Ci.nsIConsoleAPIStorage).getEvents(),
      mailMergeOrigin:extension().getURL(''),activityEvents:()=>Cc['@mozilla.org/activity-manager;1'].getService(Ci.nsIActivityManager).getActivities()}),
    async status() {try {const ext=extension();return {available:true,version:ext.version,addonId};} catch {return {available:false,reason:'Mail Merge 11.6.1 inactive or unavailable'};}},
    async attach(windowId) {
      const ext=extension();register(ext);
      const source=select(windowId);
      const tabId=ext.tabManager.getWrapper(source.win).id;
      const browser=findDialog(ext,tabId);
      if(!browser)throw Error('No existing Mail Merge dialog');
      return {browser,tabId,win:source.win};
    },
    async open(windowId) {
      const ext=extension(); register(ext);
      const source=select(windowId);
      const tabId=ext.tabManager.getWrapper(source.win).id;
      const spellcheck='chrome://messenger/content/messengercompose/EdSpellCheck.xhtml';
      for(const dialog of Services.wm.getEnumerator(null)) {
        if(dialog.opener===source.win && dialog.document?.documentURI===spellcheck) {
          // A prior preparation can be waiting inside Mail Merge's native init.
          // Cancel that selected editor's spellcheck; never accept a send.
          if(typeof dialog.CancelSpellCheck!=='function')throw Error('Unsupported spellcheck dialog');
          dialog.CancelSpellCheck();dialog.close();
        }
      }
      const originalOpenDialog=source.win.openDialog;
      source.win.openDialog=function(url,...args) {
        if(url===spellcheck)return null;
        return originalOpenDialog.call(this,url,...args);
      };
      try {
        const existing=findDialog(ext,tabId);
        if(existing) {
          const ready=await actor(existing).sendQuery('MailMergeControl',{operation:'ready'});
          if(!ready.success)throw Error('Existing Mail Merge dialog is busy');
          return {browser:existing,tabId,win:source.win};
        }
        const background=actor(ext.backgroundContext?.xulBrowser);
        if(!background)throw Error('Mail Merge background unavailable');
        const result=await background.sendQuery('MailMergeControl',{operation:'open',tabId});
        if(!result.success)throw Error('Could not open Mail Merge: '+(result.diagnostic || 'unknown'));
        let lastStage='unknown';
        for(let i=0;i<80;i++) {
          const opening=await background.sendQuery('MailMergeControl',{operation:'openStatus'});
          lastStage=opening.stage || opening.state;
          if(opening.state==='failed' || opening.state==='closed')throw Error('Native open: '+(opening.diagnostic || opening.state));
          const browser=findDialog(ext,tabId);
          if(browser) {
            try {const ready=await actor(browser).sendQuery('MailMergeControl',{operation:'ready'});if(ready.success)return {browser,tabId,win:source.win};}catch{}
          }
          await new Promise(resolve=>Services.tm.dispatchToMainThread(()=>{Services.wm.getMostRecentWindow(null).setTimeout(resolve,100);}));
        }
        throw Error('Mail Merge dialog did not become ready at '+lastStage);
      } finally {source.win.openDialog=originalOpenDialog;}
    },
    async query(session,request) {
      const ext=extension();
      if(session.browser.browsingContext?.currentWindowGlobal?.documentURI?.spec!==ext.getURL('content/dialog.html')+'?'+session.tabId)throw Error('Dialog changed');
      if(request.operation==='start')session.stopCapture=installMailMergeProgressCapture(session.win);
      const result=await actor(session.browser).sendQuery('MailMergeControl',request);
      if(['completed','failed'].includes(result.state))session.stopCapture?.();
      return result;
    },
  };
}

// Read-only bounded metadata. Console entries can concern other accounts; never
// treat them as proof of this selected message's delivery or expose raw errors.
export function collectMailMergeDiagnostics(Services,win,native={}) {
  let nativeReport,nativeProgress;
  const scrub=text=>String(text || "").slice(0,500).replace(/\bAUTH\s+.*$/gi,"[AUTH]").replace(/(?:password|token|secret|authorization|cookie)\s*[:=]\s*\S+/gi,"[credential]")
    .replace(/https?:\/\/[^\s]+/g,"[URL]").replace(/[^\s@]+@[^\s@]+/g,"[email]")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g,"[opaque]").replace(/"[^"]*"|'[^']*'/g,"[quoted]");
  try {
    const report=win?.mailmerge?.compose?.messageSend?.sendReport;
    if(report)nativeReport={currentProcess:Number(report.currentProcess),deliveryMode:Number(report.deliveryMode),
      code:/\b(?:NS_ERROR_[A-Z0-9_]+|[45][0-9]{2})\b/.exec(report.errMessage || "")?.[0] || "unclassified",summary:scrub(report.errMessage)};
  }catch{}
  if(win?.mailmerge?.progress && native.generateQI) {
    const retained={};
    const probe={QueryInterface:native.generateQI(['nsIWebProgressListener','nsISupportsWeakReference']),
      onStatusChange(_w,_r,status,message){retained.status=Number(status);retained.summary=scrub(message);},
      onStateChange(_w,_r,flags,status){retained.flags=Number(flags);retained.stateStatus=Number(status);},
      onProgressChange(){},onLocationChange(){},onSecurityChange(){},onContentBlockingEvent(){}};
    try {win.mailmerge.progress.registerListener(probe);nativeProgress=retained;}
    catch{}finally{try{win.mailmerge.progress.unregisterListener(probe);}catch{}}
  }
  const errors=[];
  try {
    const events=(native.consoleEvents?.() || []).filter(event=>event.level==='error' || event.level==='warn' && native.mailMergeOrigin && event.filename?.startsWith(native.mailMergeOrigin)).map(event=>({sourceName:event.filename,
      timeStamp:event.timeStamp,errorMessage:(event.arguments || []).map(value=>typeof value==='string'?value:(value?.wrappedJSObject || value)?.message || '').join(' ')}));
    for(const entry of [...Services.console.getMessageArray(),...events]) {
      const module=/(?:^|\/)((?:Smtp|Imap|MsgCompose|MsgSend)[A-Za-z0-9_-]*\.(?:sys\.)?m?js)(?:$|[?#])/i.exec(entry.sourceName || '')?.[1] || (native.mailMergeOrigin && entry.sourceName?.startsWith(native.mailMergeOrigin)?'MailMerge':null);
      if(!module)continue;
      const text=String(entry.errorMessage || entry.message || '');
      const code=/\bNS_ERROR_[A-Z0-9_]+\b/.exec(text)?.[0] || /\b[45][0-9]{2}\b/.exec(text)?.[0] || 'unclassified';
      const summary=scrub(text);
      errors.push({module,code,summary,timestamp:Number(entry.timeStamp) || 0});
    }
  }catch{}
  const activities=[];
  try {for(const event of (native.activityEvents?.() || []).slice(-30)) {
    const text=String(event.displayText || '')+' '+String(event.statusText || '')+' '+String(event.recoveryTipText || '');
    if(/fail|error|smtp|nie powiod|błąd|nie uda|odrzuc/i.test(text))activities.push({summary:scrub(text),timestamp:Number(event.time || event.completionTime || event.startTime) || 0});
  }}catch{}
  return {capturedProgress:readMailMergeProgressCapture(win),nativeReport,nativeProgress,activities:activities.slice(-15),errors:errors.slice(-20),scope:'SMTP/IMAP console metadata; may concern other accounts and is not delivery evidence'};
}

// A failed sequential run can have one uncertain in-flight message. Its later
// recipients were reserved but never attempted. Reuse those reservations once;
// the uncertain retry always consumes one ADDITIONAL attempt. Never reset quota.
export function validateMailMergeContinuation(records,args) {
  const refuse=()=>{throw Error('Unverifiable or already claimed reservation');};
  if(!Array.isArray(records) || !/^[a-f0-9]{24}$/.test(args.auditId || ''))return refuse();
  const seen=new Set();let charged=0;
  const inspect=(id,child)=>{
    if(!/^[a-f0-9]{24}$/.test(id || '') || seen.has(id) || seen.size>=50)return refuse();
    seen.add(id);
    const origins=records.filter(r=>r.auditId===id && r.phase==='authorized');
    const results=records.filter(r=>r.auditId===id && r.phase==='result');
    const claims=records.filter(r=>r.resumeOf===id);
    if(origins.length!==1 || results.length!==1 || claims.length!==(child?1:0) || child && claims[0]!==child)return refuse();
    const origin=origins[0],result=results[0];
    if(origin.operation!=='mailMerge' || result.operation!=='mailMerge' || result.state!=='failed' ||
        origin.accountId!==args.accountId || String(origin.timestamp).slice(0,10)!==args.date ||
        !Number.isInteger(origin.messages) || origin.messages<1 || origin.messages>500 ||
        !Array.isArray(origin.recipients) || origin.recipients.length!==origin.messages ||
        new Set(origin.recipients).size!==origin.messages || !Number.isInteger(result.completed) || result.completed<0 || result.completed>=origin.messages)return refuse();
    if(origin.resumeOf) {
      const parent=inspect(origin.resumeOf,origin);
      const skip=origin.resumeSkippedUncertain===true;
      if(origin.resumeSkippedUncertain!==undefined && !skip)return refuse();
      const remaining=parent.origin.recipients.slice(parent.result.completed+(skip?1:0));
      if(JSON.stringify(remaining)!==JSON.stringify(origin.recipients) || origin.reservationCredit!==remaining.length-(skip?0:1))return refuse();
      charged+=skip?0:1;
    } else if(origin.reservationCredit!==undefined && origin.reservationCredit!==0)return refuse();
    return {origin,result};
  };
  const {origin,result}=inspect(args.auditId);
  const root=records.find(r=>r.auditId===[...seen].at(-1) && r.phase==='authorized');
  if(!Number.isInteger(args.used) || args.used<root.messages+charged)return refuse();
  if(args.skipAcceptedFirst!==undefined && typeof args.skipAcceptedFirst!=='boolean')return refuse();
  const skip=args.skipAcceptedFirst===true;
  const remaining=origin.recipients.slice(result.completed+(skip?1:0));
  if(!Array.isArray(args.recipients) || JSON.stringify(remaining)!==JSON.stringify(args.recipients))return refuse();
  return {reservedCredit:remaining.length-(skip?0:1),additionalQuota:skip?0:1};
}

const claimedContinuations=new Set();
export function claimMailMergeContinuation(records,args) {
  if(claimedContinuations.has(args.auditId) || claimedContinuations.size>=1000)throw Error('Reservation already claimed or claim capacity reached');
  const result=validateMailMergeContinuation(records,args);
  claimedContinuations.add(args.auditId);
  return result;
}

const progressCaptures=new WeakMap();
export function readMailMergeProgressCapture(win) {return win?progressCaptures.get(win)?.events || []:[];}
export function installMailMergeProgressCapture(win) {
  const owner=win?.mailmerge;
  if(!owner)throw Error('Native Mail Merge not initialized');
  progressCaptures.get(win)?.stop();
  let current=owner.progressListener,sequence=0;
  const events=[];
  const record=(kind,flags,status,category)=>{
    events.push({kind,sequence,flags:Number(flags) || 0,status:Number(status) || 0,timestamp:Date.now(),...(category?{category}:{})});
    if(events.length>40)events.shift();
  };
  const stop=()=>{
    const descriptor=Object.getOwnPropertyDescriptor(owner,'progressListener');
    if(descriptor?.set===assign)Object.defineProperty(owner,'progressListener',{value:current,writable:true,enumerable:true,configurable:true});
  };
  const assign=listener=>{
    current=listener;sequence++;
    if(!listener)return;
    const state=listener.onStateChange,status=listener.onStatusChange;
    listener.onStateChange=function(...args){record('state',args[2],args[3]);return state?.apply(this,args);};
    listener.onStatusChange=function(...args){
      let category;
      try {
        const bundle=win.document.getElementById('bundle_composeMsgs');
        if(args[3]===bundle.getString('copyMessageFailed'))category='copyFailed';
        else if(args[3]===bundle.getString('copyMessageComplete'))category='copyComplete';
      } catch {}
      record('status',0,args[2],category);return status?.apply(this,args);
    };
  };
  Object.defineProperty(owner,'progressListener',{get:()=>current,set:assign,configurable:true,enumerable:true});
  progressCaptures.set(win,{events,stop});
  return stop;
}
