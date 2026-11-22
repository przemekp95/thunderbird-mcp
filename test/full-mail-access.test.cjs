"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const key = "extensions.thunderbird-mcp-safe.fullMailAccess";
function policy(enabled) {
  const values = new Map([[key, enabled], ["extensions.thunderbird-mcp-safe.directSendEnabled", true], ["extensions.thunderbird-mcp-safe.directSendAccounts", '["account1"]']]);
  const mail = { accounts: { accounts: [{ key: "account1" }, { key: "account2" }] }, ab: { directories: [{ UID: "book1" }] } };
  const prefs = { getBoolPref: (k,d) => values.get(k) ?? d, getStringPref: (k,d) => values.get(k) ?? d, getIntPref: (k,d) => values.get(k) ?? d, setBoolPref: (k,v) => values.set(k,v), savePrefFile: () => {} };
  const source = fs.readFileSync(require.resolve("../extension/mcp_server/api.js"), "utf8");
  const start=source.indexOf("// BEGIN DIRECT SEND POLICY"), end=source.indexOf("// END DIRECT SEND POLICY",start);
  const sandbox={Services:{prefs},ChromeUtils:{importESModule:()=>({MailServices:mail})},console};
  vm.createContext(sandbox);vm.runInContext(`${source.slice(start,end)}\nthis.api={ids:typeof fullMailAccessIds==='function'?fullMailAccessIds:undefined,config:readDirectSendConfigFromPrefs,evaluate:evaluateDirectSendRequest,set:typeof setFullMailAccess==='function'?setFullMailAccess:undefined};`,sandbox);
  return { api:sandbox.api,prefs,values,mail,platform:{Services:{prefs}} };
}
it("full mode dynamically includes existing and future accounts and books",()=>{
 const h=policy(true);assert.equal(typeof h.api.ids,"function");
 assert.deepEqual([...h.api.ids("accounts")],["account1","account2"]);
 h.mail.accounts.accounts.push({key:"account3"});h.mail.ab.directories.push({UID:"book2"});
 assert.deepEqual([...h.api.ids("accounts")],["account1","account2","account3"]);
 assert.deepEqual([...h.api.ids("addressBooks")],["book1","book2"]);
 const config=h.api.config();assert.equal(config.enabled,true);assert.deepEqual([...config.allowedAccountIds],["account1","account2","account3"]);
 assert.deepEqual([...config.allowedRecipients],[]);
 assert.equal(h.api.evaluate(config,{accountId:"account3",to:"court@example.com"},0).ok,true);
 assert.ok(h.api.evaluate(config,{accountId:"not-existing",to:"court@example.com"},0).error);
 assert.ok(h.api.evaluate(config,{accountId:"account3",to:"court@example.com"},config.dailyLimit).error);
});
it("disabled full mode retains previous account and recipient policy",()=>{
 const h=policy(false);assert.equal(typeof h.api.ids,"function");assert.equal(h.api.ids("accounts"),null);
 assert.deepEqual([...h.api.config().allowedAccountIds],["account1"]);
});
it("requires explicit confirmation, persists one reversible flag and restores it on failure",()=>{
 const h=policy(false);assert.equal(typeof h.api.set,"function");
 for(const a of [{enabled:true},{enabled:true,confirmChange:false},{enabled:true,confirmChange:true,arbitraryPref:"secret"}])assert.equal(h.api.set(a).success,false);
 assert.equal(h.values.get(key),false);
 assert.equal(h.api.set({enabled:true,confirmChange:true}).success,true);assert.equal(h.values.get(key),true);
 h.prefs.savePrefFile=()=>{throw Error("private");};
 assert.equal(h.api.set({enabled:false,confirmChange:true}).success,false);assert.equal(h.values.get(key),true);
});
