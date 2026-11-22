'use strict';
const {it}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function harness() {
 const values=new Map([
  ['extensions.thunderbird-mcp-safe.directSendDailyLimit',20],
  ['extensions.thunderbird-mcp-safe.directSendQuotaDate','2026-10-29'],
  ['extensions.thunderbird-mcp-safe.directSendQuotaCount',4],
 ]);
 const prefs={getIntPref:(k,d)=>values.get(k)??d,getStringPref:(k,d)=>values.get(k)??d,setIntPref:(k,v)=>values.set(k,v),savePrefFile:()=>{}};
 const source=fs.readFileSync(require.resolve('../extension/mcp_server/api.js'),'utf8');
 const start=source.indexOf('// BEGIN DIRECT SEND POLICY'),end=source.indexOf('// END DIRECT SEND POLICY',start);
 const sandbox={Services:{prefs},console};vm.createContext(sandbox);
 vm.runInContext(source.slice(start,end)+'\nthis.api={control:typeof controlDirectSendLimit=== "function"?controlDirectSendLimit:undefined,validate:validateDirectSendSettings,evaluate:evaluateDirectSendRequest};',sandbox);
 return {values,prefs,api:sandbox.api};
}
it('reads and changes only daily limit, preserving used quota and recipient policy',()=>{
 const h=harness();assert.equal(typeof h.api.control,'function');
 const before=JSON.stringify([...h.values]);
 const now=new Date('2026-10-29T12:00:00Z');
 const s=h.api.control({action:'status'},now);assert.equal(s.dailyLimit,20);assert.equal(s.quotaUsed,4);assert.equal(s.quotaRemaining,16);
 assert.equal(JSON.stringify([...h.values]),before);
 const r=h.api.control({action:'set',expectedDailyLimit:20,dailyLimit:300,confirmChange:true},now);
 assert.equal(r.success,true);assert.equal(r.dailyLimit,300);assert.equal(r.quotaUsed,4);assert.equal(r.quotaRemaining,296);
 assert.equal(h.values.size,3);
 assert.equal(h.values.get('extensions.thunderbird-mcp-safe.directSendQuotaCount'),4);
});
it('refuses unconfirmed, stale, malformed, over-cap and quota-reset requests',()=>{
 const h=harness();assert.equal(typeof h.api.control,'function');
 const a={action:'set',expectedDailyLimit:20,dailyLimit:300,confirmChange:true};
 for(const patch of [{confirmChange:false},{expectedDailyLimit:19},{dailyLimit:301},{dailyLimit:-1},{dailyLimit:1.5},{dailyLimit:'300'},{quotaUsed:0},{action:'reset'}]) {
  assert.equal(h.api.control({...a,...patch},new Date('2026-10-29T12:00:00Z')).success,false);
  assert.equal(h.values.get('extensions.thunderbird-mcp-safe.directSendDailyLimit'),20);
 }
 h.values.set('extensions.thunderbird-mcp-safe.directSendQuotaCount',-1);
 assert.equal(h.api.control(a,new Date('2026-10-29T12:00:00Z')).success,false);
});
it('rolls back a failed persistence and does not expose internal error text',()=>{
 const h=harness();assert.equal(typeof h.api.control,'function');h.prefs.savePrefFile=()=>{throw Error('secret');};
 const r=h.api.control({action:'set',expectedDailyLimit:20,dailyLimit:300,confirmChange:true},new Date('2026-10-29T12:00:00Z'));
 assert.equal(r.success,false);assert.equal(h.values.get('extensions.thunderbird-mcp-safe.directSendDailyLimit'),20);assert.ok(!JSON.stringify(r).includes('secret'));
});
it('accepts a 300 quota policy while retaining quota and recipient enforcement',()=>{
 const h=harness(),c={enabled:true,allowedAccountIds:['account1'],allowedRecipients:['a@example.com'],maxRecipientsPerMessage:1,dailyLimit:300};
 assert.equal(h.api.validate(c,['account1']).error,undefined);
 assert.equal(h.api.evaluate(c,{accountId:'account1',to:'a@example.com'},299).ok,true);
 assert.ok(h.api.evaluate(c,{accountId:'account1',to:'a@example.com'},300).error);
 assert.ok(h.api.evaluate(c,{accountId:'account1',to:'b@example.com'},0).error);
});

it("disables and restores the daily ceiling with confirmation while preserving the count", () => {
  const { api } = harness();
  const now = new Date("2026-10-29T12:00:00Z");
  const set = (dailyLimit, expectedDailyLimit, confirmChange = true) =>
    api.control({ action: "set", dailyLimit, expectedDailyLimit, confirmChange }, now);

  assert.equal(set(0, 20, false).success, false);
  assert.equal(set(0, 19).success, false);
  const disabled = set(0, 20);
  assert.equal(disabled.success, true);
  assert.equal(disabled.dailyLimit, 0);
  assert.equal(disabled.quotaRemaining, null);
  assert.equal(disabled.quotaUsed, 4);
  assert.equal(api.control({ action: "status" }, now).quotaRemaining, null);
  assert.equal(set(5, 20).success, false);
  const restored = set(5, 0);
  assert.equal(restored.success, true);
  assert.equal(restored.quotaRemaining, 1);
  assert.equal(restored.quotaUsed, 4);
});
