// An ordinary Bun MCP parent with a short command line, independent of test-runner arguments.
// It passes the real server's stdio through without injecting any channel evidence.
const entry = process.argv[2];
if (!entry) throw new Error("MCP fixture parent requires its server entry");
const child = Bun.spawn([process.execPath, entry], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
process.exit(await child.exited);
