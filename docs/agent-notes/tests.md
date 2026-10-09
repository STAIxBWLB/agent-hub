# Tests

Scope: tests, fakes and the test gate. Read before adding or changing a test or fake under `test/`, or editing `scripts/check.sh`, `scripts/hang-watch.sh`, `scripts/seeded-check.ts` or `scripts/seeds.json`.

- Tests that are not about batching build the bus with `batchMs: 0`; with the default 15 s window a lone status envelope looks like a lost message.
- In Bun 1.3.14 a test timeout that fires while `Bun.spawnSync` runs can start the next test inside spawnSync's own event loop, where another spawnSync then spins at full CPU for good (trigger not pinned down; see README). Bun 1.4.2 still runs the next test inside the outer spawnSync's event loop. `scripts/check.sh` runs tests with a 20 s timeout and under `scripts/hang-watch.sh`; a test that spawns and reads the process table gets a timeout of its own.
- A child process gets a scrubbed environment, so test knobs for fakes travel in a wrapper script, not in `process.env`.
- Bind agent identity markers explicitly in native/CLI fixture children. The full gate starts the test runner without inherited agent markers for human CLI fixtures; never weaken production marker detection to make them pass.
- Run `bun scripts/seeded-check.ts` before reporting the seeded-guard gate complete. Keep the six `scripts/seeds.json` cases sequential; require the same named test green before its seeded assertion fails. Seed rot, survivors, setup/compiler failures, timeout/watchdog termination and process leaks fail the gate. Never run the full seed runner from a unit test or mutate the source checkout; inspect preserved failed fixtures before removing them. CI runs this in the required Linux `seeded guards` job after the ordinary check, separately from `scripts/check.sh`.
