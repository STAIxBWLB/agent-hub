// macOS script(1) requires a terminal on its own stdin, including when its child gets a PTY.
// Keep a real PTY in this owned bridge instead; the outer Node child remains tracked by stopOwnedProcess.
const argv = process.argv.slice(2);
if (!argv.length) {
  process.exitCode = 125;
} else {
  let streamClosed!: () => void;
  const eof = new Promise<void>(resolve => { streamClosed = resolve; });
  const child = Bun.spawn(argv, {
    cwd: process.cwd(), env: process.env,
    terminal: {
      cols: 120, rows: 40, name: "xterm-256color",
      data: (_terminal, data) => { process.stdout.write(data); },
      exit: () => streamClosed(),
    },
  });
  const stop = () => { try { child.kill("SIGTERM"); } catch { /* exit readback decides */ } };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const code = await child.exited;
    // Drain the PTY before closing it; a descendant holding a slave cannot make the bridge wait forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([eof, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
    if (timer) clearTimeout(timer);
    process.exitCode = code;
  } catch {
    process.exitCode = 125;
  } finally {
    child.terminal?.close();
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
export {};
