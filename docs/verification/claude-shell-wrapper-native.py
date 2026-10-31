# Model-free native receipt. Usage: python3 this.py OUTPUT --bun /absolute/bun --claude /absolute/claude [--claude ...]
import argparse, hashlib, http.server, json, os, pathlib, select, shlex, signal, subprocess, sys, threading
parser=argparse.ArgumentParser(); parser.add_argument('output'); parser.add_argument('--bun',required=True); parser.add_argument('--claude',action='append',required=True)
args=parser.parse_args(); ROOT=pathlib.Path(args.output).resolve(); ROOT.mkdir(mode=0o700,parents=False,exist_ok=False)
HOST=pathlib.Path(__file__).with_name('claude-shell-wrapper-host.ts').resolve()
MCP="import sys,json,os,time\nfor line in sys.stdin:\n try: q=json.loads(line)\n except: continue\n method=q.get('method'); rid=q.get('id')\n if rid is None: continue\n if method=='initialize': r={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}\n elif method=='tools/list': r={'tools':[{'name':'approve','description':'Person approval fixture','inputSchema':{'type':'object','properties':{'tool_name':{'type':'string'},'input':{'type':'object'},'tool_use_id':{'type':'string'}},'required':['tool_name','input','tool_use_id'],'additionalProperties':False}}]}\n elif method=='tools/call':\n  mode=os.environ['CASE']; args=q.get('params',{}).get('arguments',{})\n  if mode=='timeout': time.sleep(60)\n  if mode=='approval-timeout': time.sleep(.1)\n  if mode=='disconnect': sys.exit(1)\n  if mode=='tool-error':\n   print(json.dumps({'jsonrpc':'2.0','id':rid,'error':{'code':-32000,'message':'fixture hub unavailable'}}),flush=True); continue\n  if mode in ('deny','hook-failure','approval-timeout'): value={'behavior':'deny','message':'no person answered' if mode=='approval-timeout' else 'fixture denied'}\n  else:\n   updated=args.get('input',{})\n   if mode=='normalized' and updated.get('description') in ('probe1','probe2'): updated={'command':os.environ['NORMALIZED'],'description':'host-bound fixture'}\n   value={'behavior':'allow','updatedInput':updated}\n  with open(os.environ['RECEIPT'],'a') as f: print(json.dumps({'arguments':args,'response':value}),file=f)\n  r={'content':[{'type':'text','text':json.dumps(value)}]}\n else: r={}\n print(json.dumps({'jsonrpc':'2.0','id':rid,'result':r}),flush=True)\n"
(ROOT/'mcp.py').write_text(MCP)
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a): pass
 def do_POST(self):
  q=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  state=self.server.state
  state['requests']+=1
  if 'count_tokens' in self.path:
   b=json.dumps({'input_tokens':100}).encode(); self.send_response(200);self.end_headers();self.wfile.write(b);return
  msgs=q.get('messages',[])
  with open(state['record'],'a') as f:f.write(json.dumps({'path':self.path,'keys':list(q),'tools':[x.get('name') for x in q.get('tools',[])],'messages':msgs})+'\n')
  count=sum(1 for m in msgs if isinstance(m.get('content'),list) for x in m['content'] if isinstance(x,dict) and x.get('type')=='tool_result'); seen=count>=len(state['commands'])
  content=[{'type':'text','text':'Fixture finished.'}] if seen else [{'type':'tool_use','id':'toolu_probe_'+str(count),'name':'Bash','input':{'command':state['commands'][count],'description':'probe'+str(count)}}]
  result={'id':'msg_probe_'+str(count),'type':'message','role':'assistant','model':'claude-sonnet-4-5','content':content,'stop_reason':'end_turn' if seen else 'tool_use','stop_sequence':None,'usage':{'input_tokens':100,'output_tokens':10}}
  if not q.get('stream'):
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(result).encode());return
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  start=dict(result);start.update(content=[],stop_reason=None,usage={'input_tokens':100,'output_tokens':0})
  events=[('message_start',{'type':'message_start','message':start})]
  for i,c in enumerate(content):
   block=dict(c)
   if c['type']=='tool_use': block['input']={}
   else: block['text']=''
   events.append(('content_block_start',{'type':'content_block_start','index':i,'content_block':block}))
   delta={'type':'input_json_delta','partial_json':json.dumps(c['input'])} if c['type']=='tool_use' else {'type':'text_delta','text':c['text']}
   events.extend([('content_block_delta',{'type':'content_block_delta','index':i,'delta':delta}),('content_block_stop',{'type':'content_block_stop','index':i})])
  events.extend([('message_delta',{'type':'message_delta','delta':{'stop_reason':result['stop_reason'],'stop_sequence':None},'usage':{'output_tokens':10}}),('message_stop',{'type':'message_stop'})])
  try:
   for e,v in events:self.wfile.write(('event: '+e+'\ndata: '+json.dumps(v)+'\n\n').encode());self.wfile.flush()
  except BrokenPipeError:pass

def stop(process):
 if process is None: return True
 try:
  if process.stdin: process.stdin.close()
  try: process.wait(timeout=25)
  except subprocess.TimeoutExpired:
   if process.poll() is None:
    try: os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError: pass
   process.wait(timeout=5)
  return process.returncode==0
 except (OSError,subprocess.TimeoutExpired):return False

def empty_group(pid):
 try:table=subprocess.run(['/bin/ps','-axo','pgid=,stat='],env={'PATH':'/usr/bin:/bin','LC_ALL':'C','TZ':'UTC'},capture_output=True,text=True,timeout=3)
 except (OSError,subprocess.TimeoutExpired):return False
 if table.returncode or len(table.stdout)>1024*1024:return False
 parsed=[line.split() for line in table.stdout.splitlines() if line.strip()]
 return bool(parsed) and all(len(row)==2 for row in parsed) and not any(row[0]==str(pid) and not row[1].startswith('Z') for row in parsed)

def rows(file):
 return [json.loads(line) for line in file.read_text().splitlines() if line]

def sha(file):
 digest=hashlib.sha256()
 with file.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
 return digest.hexdigest()

results=[]
for raw_binary in args.claude:
 binary=pathlib.Path(raw_binary).resolve(); identity=ROOT/('identity-'+binary.name); identity.mkdir()
 version=subprocess.run([str(binary),'--version'],env={'HOME':str(identity),'CLAUDE_CONFIG_DIR':str(identity/'config'),'PATH':'/usr/bin:/bin'},capture_output=True,text=True,timeout=10)
 assert version.returncode==0 and version.stdout.strip().split()[0] in ('2.1.309','2.1.310','2.1.314','2.1.316'),(version.returncode,version.stdout)
 label=version.stdout.strip().split()[0]; digest=sha(binary)
 for mode in ('context','normalized'):
  d=ROOT/(label+'-'+mode); d.mkdir(); home=d/'home';home.mkdir(); work=d/"work 'quoted'";work.mkdir();(work/'sub').mkdir()
  work=work.resolve(); host_bin=d/"host bin's";host_bin.mkdir(); executable=host_bin/'fixture';counter=d/'effects'
  program='#!/usr/bin/python3\nimport json,os,pathlib,sys\np=pathlib.Path('+repr(str(counter))+');p.write_text(str(int(p.read_text())+1) if p.exists() else "1")\nprint(json.dumps({"marker":"HOST_EXECUTABLE","cwd":os.getcwd(),"executable":os.path.realpath(sys.argv[0]),"nativeVars":{k:os.environ.get(k) for k in ["GIT_DIR","RIPGREP_CONFIG_PATH"]},"peer":os.environ.get("AGENTHUB_PEER_ID"),"term":os.environ.get("TERM"),"home":os.environ.get("HOME"),"path":os.environ.get("PATH"),"tmpdir":os.environ.get("TMPDIR")}))\n'
  executable.write_text(program);executable.chmod(0o700)
  helper=None;srv=None;native=None
  result={'version':version.stdout.strip(),'binarySha256':digest,'case':mode}
  try:
   rewritten=''
   if mode=='normalized':
    fixture=d/'host.json';fixture.write_text(json.dumps({'root':str(work),'executable':str(executable)}))
    helper=subprocess.Popen([str(pathlib.Path(args.bun).resolve()),str(HOST),str(fixture)],env={'HOME':str(home),'PATH':'/opt/homebrew/bin:/usr/bin:/bin','LANG':'C','TERM':'dumb'},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(d/'host.stderr','w'),text=True,start_new_session=True)
    assert select.select([helper.stdout],[],[],10)[0],'host fixture handshake timeout'
    reply=json.loads(helper.stdout.readline());rewritten=reply['command'];assert isinstance(rewritten,str) and rewritten
   commands=['cd sub && pwd','pwd']+(['pwd'] if mode=='normalized' else [])
   srv=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);srv.state={'requests':0,'record':str(d/'api.jsonl'),'commands':commands}
   threading.Thread(target=srv.serve_forever,daemon=True).start()
   config={'mcpServers':{'fixture':{'command':'/usr/bin/python3','args':[str(ROOT/'mcp.py')],'env':{'CASE':mode,'RECEIPT':str(d/'mcp.jsonl'),'NORMALIZED':rewritten}}}}
   (d/'mcp.json').write_text(json.dumps(config));(d/'settings.json').write_text(json.dumps({'permissions':{'ask':['Bash']}}))
   native_env={'HOME':str(home),'CLAUDE_CONFIG_DIR':str(home/'config'),'PATH':'/usr/bin:/bin','ANTHROPIC_BASE_URL':'http://127.0.0.1:'+str(srv.server_port),'ANTHROPIC_API_KEY':'synthetic-probe-not-a-credential','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_AUTOUPDATER':'1','GIT_DIR':str(d/'poison-git'),'RIPGREP_CONFIG_PATH':str(d/'poison-rg')}
   argv=[str(binary),'-p','--output-format','stream-json','--verbose','--strict-mcp-config','--mcp-config',str(d/'mcp.json'),'--setting-sources','','--settings',str(d/'settings.json'),'--permission-mode','default','--permission-prompts','host','--permission-prompt-tool','mcp__fixture__approve','--model','claude-sonnet-4-5','Run the fixture commands.']
   native=subprocess.Popen(argv,cwd=work,env=native_env,stdout=open(d/'stdout','w'),stderr=open(d/'stderr','w'),start_new_session=True)
   native.wait(timeout=25);assert native.returncode==0,(native.returncode,(d/'stderr').read_text())
   assert (d/'stderr').read_text()==''
   calls=rows(d/'mcp.jsonl');assert len(calls)==len(commands),calls
   frames={}
   for frame in rows(d/'stdout'):
    if frame.get('type')!='user':continue
    for block in frame.get('message',{}).get('content',[]):
     if block.get('type')=='tool_result':
      ident=block['tool_use_id'];assert ident not in frames;frames[ident]=(frame.get('tool_use_result'),block)
   assert set(frames)=={'toolu_probe_'+str(i) for i in range(len(commands))},frames
   for i,call in enumerate(calls):
    assert call['arguments']=={'tool_name':'Bash','input':{'command':commands[i],'description':'probe'+str(i)},'tool_use_id':'toolu_probe_'+str(i)},call
    expected=call['arguments']['input'] if i==0 or mode=='context' else {'command':rewritten,'description':'host-bound fixture'}
    assert call['response']=={'behavior':'allow','updatedInput':expected},call
   def output(i):
    tool,block=frames['toolu_probe_'+str(i)];assert isinstance(tool,dict) and block.get('is_error') is False and tool.get('stderr')=='' and tool.get('interrupted') is False,(tool,block)
    assert block.get('content')==tool['stdout'];return tool['stdout']
   assert output(0).strip()==str(work/'sub')
   if mode=='context':
    assert output(1).strip()==str(work/'sub');result['persistentCwd']=True
   else:
    observed=json.loads(output(1));assert observed['marker']=='HOST_EXECUTABLE' and observed['cwd']==str(work) and observed['executable']==str(executable.resolve()),observed
    assert observed['nativeVars']=={'GIT_DIR':None,'RIPGREP_CONFIG_PATH':None},observed
    assert observed['peer']=='claude-fixture' and observed['term']=='dumb' and observed['home']==str(home) and observed['path']=='/opt/homebrew/bin:/usr/bin:/bin',observed
    assert observed['tmpdir'] and 'ahub-shell-' in observed['tmpdir'] and str(d) not in observed['tmpdir'],observed
    replay_tool,replay=frames['toolu_probe_2'];assert replay.get('is_error') is True and 'host shell execution refused' in json.dumps(replay_tool),frames['toolu_probe_2']
    assert counter.read_text()=='1',counter.read_text()
    result.update(rewrite=True,priorCd=True,environmentIsolation=True,replayRefused=True,effects=1,quotedPaths=True)
   result.update(passed=True,nativeExit=0,requests=srv.state['requests'],permissionCalls=len(calls))
  except Exception as error:result.update(passed=False,error=repr(error))
  finally:
   if native is not None:
    # Signal only while this unreaped direct child still owns its pid, never a group id after successful wait.
    if native.poll() is None:
     try:os.killpg(native.pid,signal.SIGKILL)
     except ProcessLookupError:pass
    native.wait(timeout=5)
    import time
    deadline=time.monotonic()+1
    while not empty_group(native.pid) and time.monotonic()<deadline:time.sleep(.02)
    result['nativeGroupEmpty']=empty_group(native.pid)
    if not result['nativeGroupEmpty']:result.update(passed=False,cleanup='native group not established empty; no unrelated process signalled')
   result['hostStopped']=stop(helper)
   if not result['hostStopped']:result.update(passed=False,cleanup='host wrapper cleanup failed')
   if srv:srv.shutdown()
   result['binaryUnchanged']=sha(binary)==digest
   if not result['binaryUnchanged']:result.update(passed=False,error='native binary changed during probe')
  results.append(result);print(json.dumps(result),flush=True)
receipt={'cases':results,'certified':all(row['passed'] for row in results),'account':False,'inference':False}
(ROOT/'receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps({'receipt':str(ROOT/'receipt.json'),'certified':receipt['certified']}),flush=True)
raise SystemExit(0 if receipt['certified'] else 1)
