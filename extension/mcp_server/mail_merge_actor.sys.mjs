// Fixed adapter for the inspected private API of Mail Merge 11.6.1. No caller
// supplied addon, page, DOM selector, JavaScript or file path is accepted.
const pageStates = new WeakMap();
function nativeGlobals(win, names) {
  let debuggerModule;
  try {
    debuggerModule=ChromeUtils.importESModule('moz-src:///devtools/platform/jsdebugger.sys.mjs');
  } catch {
    debuggerModule=ChromeUtils.importESModule('resource://gre/modules/jsdebugger.sys.mjs');
  }
  const {addDebuggerToGlobal}=debuggerModule;
  const sandbox=Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{freshCompartment:true,wantXrays:false});
  addDebuggerToGlobal(sandbox);
  const debuggerInstance=new sandbox.Debugger();
  try {
    const global=debuggerInstance.addDebuggee(win);
    const result={};
    for(const name of names) {
      if(!['mailmerge','compose','messenger','openDialog'].includes(name))throw Error('Unsupported native symbol');
      result[name]=Cu.waiveXrays(global.executeInGlobal(name).return.unsafeDereference());
    }
    return result;
  } finally {debuggerInstance.removeAllDebuggees();}
}
function safeHeaders(headers) {
  for(const header of headers || []) {
    if(!/^[A-Za-z0-9-]{1,100}$/.test(header.name || '') || /^(?:X-Send-Later-|from$|sender$|to$|cc$|bcc$|subject$|content-|mime-version$)/i.test(header.name) ||
        /[\r\n\0]/.test(String(header.value || '')))throw Error('Unsafe custom header');
  }
}
function stateView(state) {
  return {success:true,state:state?.state || 'unprepared',digest:state?.digest || '',completed:state?.completed || 0,total:state?.plan?.length || 0,
    mode:state?.mode || 'SaveAsDraft',error:state?.state==='failed'?'Native operation failed; verify Drafts/Sent before any new batch':undefined};
}
export class ThunderbirdMcpMailMerge120Child extends JSWindowActorChild {
  async receiveMessage(message) {
    const win=this.contentWindow;
    try {
      const request=message.data || {};
      if(win.document.nodePrincipal.addonPolicy?.id!=='mailmerge@example.net')throw Error('Foreign page');
      if(win.location.pathname==='/_generated_background_page.html') {
        if(request.operation==='openStatus')return {success:true,...(pageStates.get(win) || {state:'idle'})};
        if(request.operation!=='open' || !Number.isSafeInteger(request.tabId) || request.tabId<0 || pageStates.has(win))throw Error('Invalid open');
        const {messenger}=nativeGlobals(win,['messenger']);
        const tab=await messenger.tabs.get(request.tabId);
        if(tab.type!=='messageCompose')throw Error('Not a composer');
        const opening={state:'opening',stage:'init'};pageStates.set(win,opening);
        const open=async()=>{
          if(!(await messenger.mailmerge.compose.init(tab.id)))throw Error('Native validation refused');
          opening.stage='expand';await messenger.mailmerge.compose.expand(tab.id);
          opening.stage='lock';await messenger.mailmerge.compose.lock(tab.id);
          try {
            opening.stage='backgroundTab';
            const popup=await messenger.tabs.create({url:'/content/dialog.html?'+tab.id,active:false});
            opening.stage='ready';
            const removed=id=>{if(id===popup.id){messenger.tabs.onRemoved.removeListener(removed);messenger.mailmerge.compose.unlock(tab.id).catch(()=>{});pageStates.delete(win);}};
            messenger.tabs.onRemoved.addListener(removed);
          } catch(error) {await messenger.mailmerge.compose.unlock(tab.id);throw error;}
        };
        open().catch(error=>{opening.state='failed';opening.diagnostic=String(error.name || 'Error').slice(0,80);});
        return {success:true,state:'opening'};
      }
      if(win.location.pathname!=='/content/dialog.html' || !/^\?\d+$/.test(win.location.search))throw Error('Foreign dialog');
      const {mailmerge,compose,messenger}=nativeGlobals(win,['mailmerge','compose','messenger']);
      if(!compose.details || compose.tab!==Number(win.location.search.slice(1)))throw Error('Dialog not ready');
      let state=pageStates.get(win);
      if(request.operation==='ready')return {success:state?.state!=='running' && !win.document.getElementById('mailmerge-send').classList?.contains('active')};
      if(request.operation==='status')return stateView(state);
      if(request.operation==='close') {
        if(state?.state==='running')throw Error('Running');
        const current=await messenger.tabs.getCurrent();
        if(!current || !Number.isInteger(current.id))throw Error('Unknown dialog tab');
        await messenger.tabs.remove(current.id);return {success:true,state:'closed'};
      }
      if(request.operation==='configure') {
        if(state?.attempted || typeof request.csv!=='string' || !request.csv || request.csv.length>262144 || request.csv.includes('\0') ||
            !Number.isInteger(request.start) || request.start<1 || !Number.isInteger(request.stop) || request.stop<request.start || request.stop>500 ||
            request.pauseSeconds!==undefined && (!Number.isInteger(request.pauseSeconds) || request.pauseSeconds<0 || request.pauseSeconds>60))throw Error('Invalid configuration');
        // Invalidate any previous reviewed plan BEFORE changing the native form.
        state={state:'unprepared',attempted:false};pageStates.set(win,state);
        const field=name=>win.document.getElementById('mailmerge-dialog-'+name);
        field('source').value='CSV';field('csv-characterset').value='utf-8';field('csv-fielddelimiter').value=',';
        field('delivermode').value='SaveAsDraft';
        for(const name of ['attachments','sendlater-at','sendlater-recur','sendlater-every','sendlater-between','sendlater-only','sendlater-until','batch-pause'])field(name+'-checkbox').checked=false;
        field('batch-start-checkbox').checked=true;field('batch-stop-checkbox').checked=true;
        field('batch-start').value=String(request.start);field('batch-stop').value=String(request.stop);
        const transfer=new win.DataTransfer();transfer.items.add(new win.File([request.csv],'mcp-mailmerge.csv',{type:'text/csv'}));field('csv-file').files=transfer.files;
        await mailmerge.dialog.change();
        await mailmerge.utils.init();
        if(!Cu.waiveXrays(win).messages?.length || Cu.waiveXrays(win).messages.length>500)throw Error('Invalid batch size');
        const plan=[];const rows=[];
        for(let i=1;i<=Cu.waiveXrays(win).messages.length;i++) {
          const {details,extras}=await mailmerge.utils.compose(i);
          if(!details || !extras || details.identityId!==compose.details.identityId)throw Error('Invalid expanded message');
          safeHeaders(details.customHeaders);safeHeaders(extras.listHeaders);
          for(const key of ['from','to','cc','bcc','subject','body','plainTextBody']) {
            if(typeof details[key]!=='string' || /\{\{[\s\S]*?\}\}/.test(details[key]) || details[key].includes('\0') ||
                key!=='body' && key!=='plainTextBody' && /[\r\n]/.test(details[key]))throw Error('Unresolved or invalid message');
          }
          plan.push({details,extras:{...extras,delivermode:'SaveAsDraft'}});
          rows.push({from:details.from,to:details.to,cc:details.cc,bcc:details.bcc,subject:details.subject});
        }
        const serialized=JSON.stringify(plan);
        const hash=Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
        hash.init(hash.SHA256);
        const encoded=new TextEncoder().encode(serialized);hash.update(encoded,encoded.length);
        const digest=Array.from(hash.finish(false),x=>x.charCodeAt(0).toString(16).padStart(2,'0')).join('');
        Object.assign(state,{state:'prepared',plan,digest,completed:0,pauseSeconds:request.pauseSeconds || 0});
        return {...stateView(state),messages:rows,sample:{body:plan[0].details.plainTextBody.slice(0,12000),bodyComplete:plan[0].details.plainTextBody.length<=12000}};
      }
      if(request.operation!=='start' || !state || state.attempted || state.state!=='prepared' || request.digest!==state.digest ||
          !['SaveAsDraft','SendNow'].includes(request.mode))throw Error('Invalid or stale start');
      state.attempted=true;state.state='running';state.mode=request.mode;
      // Snapshot mode and expanded details; do not use send.start(), whose mode
      // can change mid-batch and which closes the user's source composer.
      const run=async()=>{
        for(const item of state.plan) {
          safeHeaders(item.details.customHeaders);safeHeaders(item.extras.listHeaders);
          await messenger.mailmerge.compose.send(compose.tab,item.details,Cu.cloneInto({...item.extras,delivermode:request.mode},win));
          state.completed++;
          if(state.pauseSeconds && state.completed<state.plan.length)await new Promise(resolve=>win.setTimeout(resolve,state.pauseSeconds*1000));
        }
        state.state='completed';
      };
      // Defer work until the caller has received the accepted state.
      win.setTimeout(()=>{run().catch(()=>{state.state='failed';});},0);
      return stateView(state);
    } catch(error) {return {success:false,error:'Mail Merge native operation refused or unavailable',diagnostic:String(error.name || 'Error').slice(0,80)};}
  }
}
