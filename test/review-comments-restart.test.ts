import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRestartSnapshot, restartPath, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";

function snapshot(): RestartSnapshot {
  return { schemaVersion:1,projectRoot:"/fixture",projectId:"review-project",sourceInstanceId:"old",operationId:"review-restart",committedAt:Date.now(),
    bus:{schemaVersion:1,queues:{},prefaces:{},seen:[],attempts:{},withdrawn:[]},manualPaused:[],peers:[],
    integrity:{queues:{},manualPaused:[],boardDigest:"a".repeat(64),budgetDigest:"b".repeat(64)} };
}
test("review integrity is optional for old receipts and round-trips text-free counters/digest",()=>{
  const dir=mkdtempSync(join(tmpdir(),"ahub-review-restart-")), expected={projectRoot:"/fixture",projectId:"review-project",operationId:"review-restart"};
  try {
    const old=snapshot();writeRestartSnapshot(dir,old);expect(readRestartSnapshot(dir,expected)).toEqual(old);
    const next=snapshot();next.integrity!.reviewComments={comments:3,packages:1,digest:"c".repeat(64)};
    writeRestartSnapshot(dir,next);expect(readRestartSnapshot(dir,expected)).toEqual(next);
    for(const reviewComments of [{comments:-1,packages:1,digest:"c".repeat(64)},{comments:1,packages:0.5,digest:"c".repeat(64)},{comments:1,packages:0,digest:"bad"},{comments:1,packages:0,digest:"c".repeat(64),body:"REVIEW_BODY_CANARY"}]) {
      writeFileSync(restartPath(dir),JSON.stringify({...next,integrity:{...next.integrity,reviewComments}}),{mode:0o600});expect(readRestartSnapshot(dir,expected)).toBeUndefined();
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
