const fs=require('node:fs');
const local=host=>!host||host==='localhost'||host==='127.0.0.1'||host==='::1'||host==='[::1]';
const deny=()=>{if(process.env.PROBE_NETWORK_LOG)fs.appendFileSync(process.env.PROBE_NETWORK_LOG,'blocked external network attempt\n');throw Error('receipt permits loopback only');};
const hostname=args=>{let a=args[0];if(Array.isArray(a))return hostname(a);if(typeof a==='string'&&/^https?:/.test(a))return new URL(a).hostname;if(a instanceof URL)return a.hostname;if(a&&typeof a==='object')return a.hostname||a.host;if(typeof args[1]==='string')return args[1];return undefined;};
for(const name of ['node:http','node:https']){const m=require(name);for(const key of ['request','get']){const orig=m[key];m[key]=function(...args){if(!local(hostname(args)))return deny();return orig.apply(this,args);};}}
const net=require('node:net'),original=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){if(!local(hostname(args)))return deny();return original.apply(this,args);};
const fetch=globalThis.fetch;globalThis.fetch=function(input,...rest){const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!local(url.hostname))return deny();return fetch.call(this,input,...rest);};
for(const name of ['node:dns','node:dns/promises']){const m=require(name);for(const key of ['lookup','resolve','resolve4','resolve6']){const orig=m[key];if(orig)m[key]=function(host,...args){if(!local(host))return deny();return orig.call(this,host,...args);};}}
require('node:module').syncBuiltinESMExports();
