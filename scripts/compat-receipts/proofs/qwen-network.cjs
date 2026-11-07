const fs = require('node:fs');
const deny = () => {fs.appendFileSync(process.env.PROBE_NETWORK_LOG, 'blocked network attempt\n'); throw new Error('model-free receipt refuses network');};
for (const [m, keys] of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:dgram',['createSocket']]]) {const mod=require(m);for(const k of keys)mod[k]=deny;}
require('node:net').Socket.prototype.connect=deny;
globalThis.fetch=deny;
require('node:module').syncBuiltinESMExports();
