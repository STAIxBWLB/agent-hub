import { basename, resolve, sep } from "node:path";

export function daemonProjectRootFromArgv(argv, executable) {
  if (!/(?:^|\/)bun$/.test(executable)) return undefined;
  const script = argv[1] ?? "";
  if (!/(?:^|\/)src\/cli\/main\.(?:ts|js)$/.test(script)) return undefined;
  const args = argv.slice(2);
  const projectIndex = args.indexOf("--project");
  if (projectIndex < 0 || args[projectIndex + 2] !== "daemon") return undefined;
  return args[projectIndex + 1];
}

export function daemonProjectRoot(command) {
  // The executable must be Bun and the script must be this project's CLI entry point.
  // Requiring argv[0] prevents Python or audit commands from spoofing the trailing text.
  const match = /^(?:\S*\/)?bun\s+(.+\/src\/cli\/main\.(?:ts|js))\s+--project\s+(.+)\s+daemon(?:\s|$)/.exec(command);
  return match?.[2]?.replace(/\s+$/, "");
}

export function processBelongsToRun(command, runRoot) {
  const root = daemonProjectRoot(command);
  if (!root) return false;
  const canonicalRoot = resolve(runRoot);
  const absolute = resolve(root);
  return absolute === canonicalRoot || absolute.startsWith(`${canonicalRoot}${sep}`);
}

export function processIdentity(row) {
  return JSON.stringify([row.pid, row.started, row.pgid, row.command]);
}

export function commandRuntime(command) {
  const executable = command.trim().split(/\s+/, 1)[0] ?? "";
  return basename(executable);
}

export function parseProcessSnapshot(snapshot) {
  const rows = [];
  for (const line of snapshot.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, started, command] = match;
    rows.push({ pid, ppid, pgid, started: started.trim(), command });
  }
  return rows;
}

export function ownedProcesses(rows, runRoot, births) {
  const groups = new Set();
  const liveDaemons = new Map();
  const liveSeeds = new Map();
  for (const birth of births) {
    const projectRoot = resolve(birth.root);
    if (projectRoot !== resolve(runRoot) && !projectRoot.startsWith(`${resolve(runRoot)}${sep}`)) continue;
    const live = rows.find((row) => row.pid === birth.pid && row.started === birth.started && row.pgid === birth.pgid &&
      (birth.kind === "owned_process" ? commandRuntime(row.command) === birth.runtime : daemonProjectRoot(row.command) === projectRoot));
    if (live) {
      liveSeeds.set(processIdentity(live), live);
      if (birth.kind === "daemon") liveDaemons.set(processIdentity(live), live);
    }
    if (birth.exclusive) {
      const members = rows.filter((row) => row.pgid === birth.pgid);
      const leader = members.find((row) => row.pid === birth.pid);
      if (members.length && (!leader || live)) groups.add(birth.pgid);
    }
  }
  // A live daemon whose test preload was unavailable is still recognized from its
  // exact Bun argv and run-specific project root.
  for (const row of rows) {
    if (processBelongsToRun(row.command, runRoot) && row.pid === row.pgid) {
      liveDaemons.set(processIdentity(row), row);
      liveSeeds.set(processIdentity(row), row);
      groups.add(row.pgid);
    }
  }
  const owned = new Map([...liveSeeds.values()].map((row) => [processIdentity(row), row]));
  for (const row of rows) if (groups.has(row.pgid)) owned.set(processIdentity(row), row);

  // Live PPID chains add native Node/sandbox children whose spawn call creates a
  // separate process group. This only attributes a child while its verified owner
  // is still present in the same process snapshot.
  const parentPids = new Set([...owned.values()].map((row) => row.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (parentPids.has(row.ppid) && !owned.has(processIdentity(row))) {
        owned.set(processIdentity(row), row);
        parentPids.add(row.pid);
        changed = true;
      }
    }
  }
  return [...new Map([...liveDaemons.values(), ...owned.values()].map((row) => [processIdentity(row), row])).values()];
}
