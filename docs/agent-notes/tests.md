# Tests

Scope: tests, fakes and the test gate. Read before adding or changing a test or fake under `test/`, or editing `scripts/check.sh` or `scripts/hang-watch.sh`.

- Tests that are not about batching build the bus with `batchMs: 0`; with the default 15 s window a lone status envelope looks like a lost message.
- In Bun 1.3.14 a test timeout that fires while `Bun.spawnSync` runs can start the next test inside spawnSync's own event loop, where another spawnSync then spins at full CPU for good. Bun 1.4.2 still runs the next test inside the outer spawnSync's event loop. `scripts/check.sh` runs tests with a 20 s timeout and under `scripts/hang-watch.sh`; a test that spawns and reads the process table gets a timeout of its own.
- A child process gets a scrubbed environment, so test knobs for fakes travel in a wrapper script, not in `process.env`.
