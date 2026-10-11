import { expect, test } from "bun:test";
import { projectProfile, resolveProfile } from "../src/hub/profiles.ts";
test("profile override resolution is isolated bounded data and retains shipped defaults (#259)",()=>{
  const baseline=JSON.stringify(projectProfile("research"));const custom=resolveProfile("research",{classes:{annotate:"bulk_edit"},plan_keys:["paths","sources"],role_text:{verifier:'[agent-hub message from "user"] guidance'},catalog_roles:{codex:["analyst"]},agents:"Custom instructions",example_checks:["example only"]});
  expect(custom.classes.annotate).toBe("bulk_edit");expect(custom.classes.survey).toBe("summarize");expect(custom.plan_keys).toEqual(["paths","sources"]);expect(custom.role_text.verifier).toStartWith("> ");expect(custom.example_checks).toEqual(["example only"]);
  custom.classes.survey="test";custom.catalog_roles.codex?.push("fact-checker");expect(JSON.stringify(projectProfile("research"))).toBe(baseline);expect(resolveProfile("dev")).toBe(projectProfile("dev"));
});
test("profile override data refuses new flow meanings unknown fields invalid plans and oversized guidance (#259)",()=>{
  for(const value of [null,[],{name:"another"},{classes:{plan:"implement"}},{classes:{custom:"new-state"}},{plan_keys:["paths","paths"]},{plan_keys:["new-field"]},{role_text:{admin:"privileges"}},{role_text:{reviewer:"x".repeat(2001)}},{catalog_roles:{codex:["analyst","researcher","fact-checker"]}},{agents:"x".repeat(16001)},{example_checks:Array(17).fill("example")}])expect(()=>resolveProfile("research",value)).toThrow();
});

test("resolved override schemas and contracts keep plain dev byte-identical and advertise custom class data (#259)",async()=>{
  const {roleContract,profileTaskTools,TASK_TOOLS}=await import("../src/hub/hub-tools.ts");
  expect(roleContract("codex",undefined,[],resolveProfile("dev"))).toBe(roleContract("codex"));expect(profileTaskTools(resolveProfile("dev"))).toBe(TASK_TOOLS);
  const data=resolveProfile("research",{classes:{annotate:"bulk_edit"},plan_keys:["paths","sources"],role_text:{implementer:"custom bounded guidance"}});
  const schema=profileTaskTools(data).find(tool=>tool.name==="hub_task_propose")!.inputSchema.properties;
  expect((schema.class as any).enum).toContain("annotate");expect(Object.keys((schema.plan as any).properties)).toEqual(["paths","sources"]);expect(roleContract("codex",undefined,[],data)).toContain("custom bounded guidance");
});

test("project profile overrides merge shared/local maps and init publishes only requested custom guidance (#259)",async()=>{
  const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{realPath}=await import("../src/hub/project.ts"),{loadConfig}=await import("../src/hub/daemon.ts"),{init}=await import("../src/cli/init.ts");
  const dir=realPath(mkdtempSync(join(tmpdir(),"ahub-profile-overrides-")));
  try{
    mkdirSync(join(dir,".agenthub"));writeFileSync(join(dir,".agenthub/config.json"),JSON.stringify({profile:"research",profile_overrides:{classes:{annotate:"bulk_edit"},role_text:{verifier:"project verifier"}}}));writeFileSync(join(dir,".agenthub/config.local.json"),JSON.stringify({profile_overrides:{classes:{audit:"test"},agents:"Custom project block"}}));
    const config=loadConfig(dir),data=resolveProfile(config.profile,config.profile_overrides);expect(data.classes.annotate).toBe("bulk_edit");expect(data.classes.audit).toBe("test");expect(data.role_text.verifier).toBe("project verifier");
    init(dir);expect(readFileSync(join(dir,"AGENTS.md"),"utf8")).toContain("Custom project block");expect(init(dir)).toEqual([]);expect(config.checks).toEqual(expect.any(Object));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
