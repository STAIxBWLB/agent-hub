import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { Facts } from "./facts.ts";
import { classifyShellWrite } from "./task-shell-command.ts";
import { PreEffectToolRefusal } from "./tool-refusal.ts";

export type EditGuardArm = "baseline" | "route_guard" | "occ_guard" | "combined_guard";
export type EditGuardAvailability = "admitted" | "unavailable";
export function parseEditGovernance(raw: unknown): { arm: EditGuardArm } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "arm")) throw new Error("edit_governance requires an arm");
  const arm = (raw as { arm?: unknown }).arm;
  if (arm !== "baseline" && arm !== "route_guard" && arm !== "occ_guard" && arm !== "combined_guard") throw new Error("edit_governance.arm is invalid");
  return { arm };
}

/** A host-bound tool transaction. The caller owns the peer, task, generation and policy checks. */
export function editGuard(input: { root: string; peer: string; task: number; turn: string; ownerEpoch: string; arm: () => EditGuardArm; current: () => boolean; facts: Facts; evidence?: EditEvidence; revision?: string; changed?: () => void; observeShell?: () => boolean }) {
  const name = (file: string) => {
    const result = relative(input.root, file);
    if (!result || isAbsolute(result) || result === ".." || result.startsWith("../")) throw new PreEffectToolRefusal("edit guard target unavailable; inspect the task before retrying");
    return result;
  };
  const current = () => {
    let valid = false; try { valid = input.current(); } catch { /* unknown authority refuses */ }
    if (!valid) throw new PreEffectToolRefusal("edit guard authority changed; inspect the task before retrying");
  };
  const changed = () => { try { input.changed?.(); } catch { /* optional observation */ } };
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  return {
    read(file: string, bytes: Buffer, full: boolean): void {
      current(); input.facts.recordRead(input.peer, input.task, name(file), { sha256: digest(bytes), scope: full ? "full" : "partial", turnId: input.turn, ownerEpoch: input.ownerEpoch });
      if (full && input.revision) input.evidence?.diagnosticRead(input.task, input.revision);
      changed();
    },
    write(file: string): boolean | undefined {
      current(); const arm = input.arm(), path = name(file); let hash: string;
      try { hash = digest(readFileSync(file)); } catch (error) {
        if (arm === "occ_guard" || arm === "combined_guard") throw new PreEffectToolRefusal("edit guard cannot read the current file; inspect and re-read before retrying");
        return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? true : undefined;
      }
      current();
      const receipt = input.facts.readReceipt(input.peer, input.task, path);
      const unverified = !receipt || receipt.ownerEpoch !== input.ownerEpoch || receipt.sha256 !== hash;
      if (unverified && (arm === "occ_guard" || arm === "combined_guard")) throw new PreEffectToolRefusal(`blind or stale write refused; current sha256 ${hash}; re-read the file before retrying`);
      return unverified;
    },
    written(file: string, unverified: boolean | undefined): void {
      if (input.current() && input.revision) { input.evidence?.write(input.task, input.revision, name(file), unverified === true); changed(); }
    },
    shell(command: string): (() => void) | undefined {
      current(); const arm = input.arm(), classified = classifyShellWrite(command);
      if ((arm === "route_guard" || arm === "combined_guard") && classified.kind === "write") throw new PreEffectToolRefusal("shell write refused by route guard; use the dedicated edit tool");
      if (!input.observeShell?.()) return undefined;
      if (classified.kind === "unknown") { if (input.revision) input.evidence?.unknownShell(input.task, input.revision); changed(); return undefined; }
      if (classified.kind !== "write") return undefined;
      const id = randomUUID(), args = { command };
      try { input.facts.preTool(input.peer, id, "Bash", args); } catch { return undefined; }
      return () => { if (input.current()) input.facts.postTool(input.peer, id, "Bash", args); };

    },
  };
}

/** Bounded, in-memory evidence. File identifiers never leave this store. */
export class EditEvidence {
  private readonly rows = new Map<number, { revision: string; unverified: number; unknownShell: number; failed: boolean; cascading: Set<string> }>();
  private row(task: number, revision: string) {
    let row = this.rows.get(task);
    if (!row || row.revision !== revision) {
      row = { revision, unverified: 0, unknownShell: 0, failed: false, cascading: new Set() };
      this.rows.delete(task); this.rows.set(task, row);
      while (this.rows.size > 100) this.rows.delete(this.rows.keys().next().value as number);
    }
    return row;
  }
  unknownShell(task: number, revision: string): void { const row = this.row(task, revision); row.unknownShell = Math.min(256, row.unknownShell + 1); }
  check(task: number, revision: string, result: "failed" | "passed"): void {
    const row = this.row(task, revision); row.failed = result === "failed"; row.cascading.clear();
  }
  diagnosticRead(task: number, revision: string): void { const row = this.row(task, revision); row.failed = false; row.cascading.clear(); }
  write(task: number, revision: string, file: string, unverified: boolean): void {
    const row = this.row(task, revision);
    if (unverified) row.unverified = Math.min(256, row.unverified + 1);
    if (row.failed && row.cascading.size < 256) row.cascading.add(createHash("sha256").update(file).digest("hex"));
  }
  snapshot(task: number, revision: string) {
    const row = this.rows.get(task);
    return row?.revision === revision ? { task, revision, unverified: row.unverified, unknownShell: row.unknownShell, cascading: row.cascading.size } : undefined;
  }
  close(task: number): void { this.rows.delete(task); }
  reset(): void { this.rows.clear(); }
}
