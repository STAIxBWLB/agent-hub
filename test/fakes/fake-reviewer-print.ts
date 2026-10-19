import { appendFileSync } from "node:fs";
const prompt = await new Response(Bun.stdin.stream()).text();
appendFileSync(process.argv[2]!, JSON.stringify({ args: process.argv.slice(3), prompt, peer: process.env.AGENTHUB_PEER_ID }) + "\n");
console.log(JSON.stringify({ type: "completed", usage: { input_tokens: 3, output_tokens: 2 } }));
