import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('#161/#162 old and new request observations reconcile independently of model qualification', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, sys.argv[1])
from runner import v3_observability, aggregate_v3_observability, v3_request_gate
identity={'requests':[
 {'id':'one','outcome':'completed','identified':True,'actualModel':'model','requestedModel':'route','requestUsage':{'source':'openai-stream-usage','promptTokens':0,'completionTokens':0,'totalTokens':0}},
 {'id':'two','outcome':'cancelled','identified':True,'provider':'header-provider','requestUsage':{'source':'openai-stream-usage','totalTokens':3}},
 {'id':'three','outcome':'failed','identified':False,'requestUsage':{'source':'openai-stream-usage','totalTokens':-1}}]}
assert v3_request_gate(identity, {'fixed_backend':'route','expected_served_model':'model'}) is None
x=v3_observability(identity)
assert x['provider']['completed']=={'dispatches':1,'providerKnown':0,'providerMissing':1}
assert x['provider']['cancelled']=={'dispatches':1,'providerKnown':1,'providerMissing':0}
assert x['provider']['failed']=={'dispatches':1,'providerKnown':0,'providerMissing':1}
assert x['requestUsage']['known']==1 and x['requestUsage']['partial']==1 and x['requestUsage']['unknown']==1
assert x['requestUsage']['counters']['totalTokens']=={'known':2,'total':3}
a=aggregate_v3_observability([{'request_observability':x},{'request_observability':x}])
assert a['requestUsage']['dispatches']==6 and a['requestUsage']['counters']['totalTokens']['total']==6
assert v3_observability({}) is None
assert aggregate_v3_observability([{}]) is None
print('observability: OK')
`, join(import.meta.dir, '../../scripts/benchmarks')], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('observability: OK');
});
