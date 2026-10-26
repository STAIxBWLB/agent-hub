import { pathToFileURL } from 'node:url';
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(pathToFileURL(`${process.env.PI_COMPAT_PACKAGE}/dist/index.js`).href);
const cwd = process.env.HOME;
const settingsManager = SettingsManager.create(cwd, process.env.PI_CODING_AGENT_DIR);
const loader = new DefaultResourceLoader({cwd, agentDir:process.env.PI_CODING_AGENT_DIR, settingsManager,
  noExtensions:true, additionalExtensionPaths:[process.env.HUB_EXTENSION], noSkills:true, noPromptTemplates:true, noThemes:true});
await loader.reload();
const {session, extensionsResult} = await createAgentSession({cwd, agentDir:process.env.PI_CODING_AGENT_DIR,
  resourceLoader:loader, settingsManager, sessionManager:SessionManager.create(cwd, `${cwd}/sessions`), noTools:'builtin'});
if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
await session.bindExtensions({mode:'rpc'});
const tool = session.extensionRunner.getAllRegisteredTools().find(t=>t.definition.name==='compat_probe');
if (!tool) throw new Error('hub extension tool not registered');
const invoke = async (id, args) => tool.definition.execute(id, args, new AbortController().signal);
const first = await invoke('same-call', {value:'fixture'});
const replay = await invoke('same-call', {value:'fixture'});
const denied = await invoke('denied-call', {value:'deny'});
console.log(JSON.stringify({extension:'loaded',first,replay,denied,tools:session.getActiveToolNames()}));
await session.extensionRunner.emit({type:'session_shutdown'});
session.dispose();
process.exit(0);
