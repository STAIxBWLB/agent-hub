import { parseRemotePeerId } from "../rooms/application.ts";

/** Leading @tokens are addresses; malformed remote addresses must never become a broadcast body. */
export function sayRecipients(args: readonly string[]): { to: string[]; text: string[] } {
  const to: string[] = [];
  let count = 0;
  for (const arg of args) {
    if (/^@[a-z][a-z0-9-]*$/.test(arg)) { to.push(arg.slice(1)); count++; continue; }
    if (arg.startsWith("@") && arg.slice(1).includes("@")) {
      if (!parseRemotePeerId(arg.slice(1))) throw new Error("invalid remote peer address; expected @peer@label");
      to.push(arg.slice(1)); count++; continue;
    }
    break;
  }
  return { to, text: args.slice(count) };
}
