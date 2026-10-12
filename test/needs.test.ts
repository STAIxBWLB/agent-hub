import {expect,test} from "bun:test";
import {needs} from "../src/ui/needs.ts";
test("attention model orders structural needs and watch facts never override state (#280)",()=>{
 const result=needs({approvals:[{id:"later",peer:"codex",expiresAt:200},{id:"first",peer:"claude",expiresAt:150},{id:"expired",expiresAt:99}],defaults:[{peer:"kimi"}],storageBlocked:true,peers:{codex:{state:"busy",needsReview:2,heldBy:"delivery-one"}},messages:[{id:"note",important:false},{id:"request",important:true}],budget:{codex:{paused:{since:1,resetsAt:1000}}},recovery:{id:"operation",running:true}},100);
 expect(result.state).toBe("waiting");expect(result.act).toBe(7);expect(result.watch).toBe(3);expect(result.items.slice(0,3).map(item=>item.id??item.peer)).toEqual(["first","later","kimi"]);
 expect(needs({storageBlocked:true},100).state).toBe("blocked");expect(needs({messages:[{important:true}]},100).state).toBe("review");expect(needs({peers:{codex:{state:"busy"}},budget:{codex:{paused:{}}}},100).state).toBe("working");expect(needs({peers:{codex:{state:"idle"}}},100).state).toBe("idle");expect(needs({peers:{codex:{state:"offline"}},messages:[{important:false}]},100).state).toBe("sleeping");
});
test("attention model never reads or copies body titles options errors or paths (#280)",()=>{
 const secret=()=>{throw new Error("PII read");};
 const input={approvals:[{id:"request",peer:"codex",expiresAt:200,get title(){return secret();},get options(){return secret();}}],peers:{codex:{state:"idle",needsReview:1,heldBy:"delivery",get text(){return secret();}}},messages:[{id:"message",important:true,get body(){return secret();}}],storageBlocked:true,get error(){return secret();},get paths(){return secret();}};
 const result=needs(input,100);expect(result.act).toBe(4);for(const item of result.items)expect(Object.keys(item).every(key=>["kind","level","peer","id","until","since"].includes(key))).toBe(true);
});
