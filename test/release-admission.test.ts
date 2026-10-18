import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readReleaseHostAdmission } from "../src/hub/release-admission.ts";
import { liveTestRefusal } from "../src/cli/identity.ts";

test("release host admission uses fixed argv and refuses a held common-repository slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-release-admission-")), project = join(root, "repo"), host = join(root, "host");
  const old = process.env.PATH, oldAdmission = process.env.DOT_ADMISSION_SCOPE;
  try {
    mkdirSync(project); mkdirSync(host);
    expect(spawnSync("git", ["init", "-q", project]).status).toBe(0);
    const common = spawnSync("git", ["-C", project, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
    const binary = join(host, "dot");
    writeFileSync(binary, `#!${process.execPath}\nconst args=process.argv.slice(2);if(process.env.DOT_ADMISSION_SCOPE)process.exit(1);if(args[0]!=="admit"||args[5]!==process.execPath||args[6]!=="-e"||!args[7].includes("AHUB_RELEASE_SLOT_READY"))process.exit(1);process.stdout.write("AHUB_RELEASE_SLOT_READY\\n");process.stdin.resume();`); chmodSync(binary, 0o755);
    process.env.PATH = `${host}:${old ?? ""}`;
    process.env.DOT_ADMISSION_SCOPE = "expired-launcher-scope";
    const admission = await readReleaseHostAdmission(project);
    expect(admission.admitted).toBe(true);
    expect(admission.current?.()).toBe(true);
    await admission.close?.();
    mkdirSync(join(common, "ahub-heavy.lock"));
    expect(await readReleaseHostAdmission(project)).toMatchObject({ admitted: false, reason: "repository heavy-job slot held" });
  } finally { if (old === undefined) delete process.env.PATH; else process.env.PATH = old; if (typeof oldAdmission !== "undefined") process.env.DOT_ADMISSION_SCOPE = oldAdmission; else delete process.env.DOT_ADMISSION_SCOPE; rmSync(root, { recursive: true, force: true }); }
});

test("an untrusted project dot cannot grant release admission, and agent delegation cannot write train planning as person", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-release-untrusted-")), old = process.env.PATH;
  try {
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    writeFileSync(join(root, "dot"), '#!/bin/sh\nprintf "AHUB_RELEASE_SLOT_READY\\n"\ncat >/dev/null\n'); chmodSync(join(root, "dot"), 0o755);
    process.env.PATH = `${root}:/usr/bin:/bin`;
    expect((await readReleaseHostAdmission(root)).admitted).toBe(false);
    expect(liveTestRefusal("sdlc", ["train", "configure", "1", "0", "{}"])).toBe(true);
    expect(liveTestRefusal("sdlc", ["train", "cut", "1", "0"])).toBe(true);
    expect(liveTestRefusal("sdlc", ["release-assign", "1", "0", "2", "scope"])).toBe(true);
    expect(liveTestRefusal("sdlc", ["train", "report", "1"])).toBe(false);
  } finally { if (old === undefined) delete process.env.PATH; else process.env.PATH = old; rmSync(root, { recursive: true, force: true }); }
});
