import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1]!;
const input = arg("--input-file"), output = arg("--json-file"), scenario = process.argv.includes("--scenario") ? arg("--scenario") : "normal";
const emit = (event: unknown) => appendFileSync(output, JSON.stringify(event) + "\n");
writeFileSync(join(process.env.HOME!, "private-native-output"), `${process.env.OPENAI_API_KEY} session-private-id prompt-private-body`);
console.log("private terminal output session-private-id prompt-private-body");
if (scenario === "early") process.exit(0);
if (scenario !== "timeout") emit({ type: "system", subtype: "session_start", session_id: "session-private-id", data: { version: "0.26.1", protocol_version: 2, supported_events: ["user", "assistant", "stream_event"] } });
let first: string | undefined, done = false;
setInterval(() => {
  if (scenario === "timeout" || done) return;
  const records = readFileSync(input, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (records.length >= 1 && first === undefined) {
    first = records[0].text;
    if (scenario === "finished") {
      // One write ensures the reader can already see completion before it submits again.
      const batch = [
        { type: "user", message: { content: first } },
        { type: "stream_event", event: { type: "message_start" } },
        { type: "assistant", message: { content: [{ type: "text", text: "AHUB_SMOKE_FIRST" }], stop_reason: "end_turn" } },
        { type: "stream_event", event: { type: "message_stop" } },
      ];
      appendFileSync(output, batch.map(event => JSON.stringify(event)).join("\n") + "\n");
    } else {
      emit({ type: "user", message: { content: first } });
      emit({ type: "stream_event", event: { type: "message_start" } });
    }
    if (scenario === "approval") emit({ type: "control_request", private: "prompt-private-body" });
  }
  if (records.length === 2) {
    done = true;
    if (scenario !== "finished") {
      emit({ type: "assistant", message: { content: [{ type: "text", text: "AHUB_SMOKE_FIRST" }], stop_reason: "end_turn" } });
      emit({ type: "stream_event", event: { type: "message_stop" } });
    }
    emit({ type: "user", message: { content: records[1].text } });
    emit({ type: "stream_event", event: { type: "message_start" } });
    emit({ type: "assistant", message: { content: [{ type: "text", text: "AHUB_SMOKE_SECOND" }], stop_reason: "end_turn" } });
    emit({ type: "stream_event", event: { type: "message_stop" } });
  }
}, 20);
