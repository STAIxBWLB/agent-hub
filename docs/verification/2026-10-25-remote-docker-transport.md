# Remote Docker extraction and cleanup receipt

Date: 2026-10-25. Refs #793, transport slice AC1/AC2/AC4/AC5. This is a local Docker transport-component proof, not an SSH or pi tool-call receipt. No machine opt-in, dependency preparation, account or model call occurred.

## Versions and proof boundary

- Docker daemon 29.5.2, Linux arm64, through an existing Colima VM.
- Preinstalled image: oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895. The fixture asserted the actual container Bun version was 1.4.2. No image pull occurred.
- Host Bun 1.4.3; macOS bsdtar 3.5.3, libarchive 3.7.4.
- Tested src/hub/check-runner.ts SHA-256: 58f6a9f2a86acbf4fb9165ca2315c8df2aaca27b871e6ed3eaef79a28d94f3ad.
- Private driver SHA-256: 07000fd8aadf00625255784f5ac7b27f6ec6f56166c1e6118031bf963545f091.

The existing VM exposes only two CPUs. Two initial attempts with the unchanged production four-CPU argument failed before transfer, and both cleaned their owned resources. The final component driver therefore lowered only the CPU cap from four to two. This is a stricter native-test limit; the product still requests four CPUs. The VM was not reconfigured or restarted. The exact four-CPU launch on the eventual remote host remains unverified.

The driver used the production remoteRunnerTransport with ContainerRunner's shared lifecycle and a direct Docker command port. It supplied no always-true dependency-ready predicate. A separate actual RemoteRunner.available() call returned remote dependencies unprepared, so this proof grants no sandboxed-peer tests capability.

## Transfer and negative controls

A private synthetic Git fixture contained a nested canary, a lockfile and a bare bun:test file. The working-tree canary was changed after commit. The component returned the committed content, not the dirty working-tree version:

- Source commit: abac005b3a543eb3f7d10c74222009e027055776.
- Tree: 7cb96483df51495ff14e3ae2ad58b1f1398e2385.
- Lockfile SHA-256: 87b7aa7d4cc3d62bbabeb5971dac92dcf6f0a52815d11afb027fbed4b769c946.

Before extraction, the driver attached a benign macOS extended attribute to the staged canary. A baseline host archive retained that attribute, and the former docker cp - ...:/work path failed against the same running, read-only-root/tmpfs container. The production normalized archive omitted the custom attribute, macOS provenance metadata and host username. Its headers used uid/gid 65532 and static check owner/group names.

The unchanged production copy function streamed that archive through non-root docker exec -i ... tar --no-same-owner -xf - -C /work. Readback asserted exact committed content and source ownership uid 65532. The real Bun test exited zero; its process reported uid 65532 and six threads under the 64-pid limit. This is one small workload, not a capacity proof for every permitted check.

Docker documents the tmpfs copy limitation and recommends an in-container tar stream for this boundary: [Docker cp corner cases](https://docs.docker.com/reference/cli/docker/container/cp/#corner-cases).

## Readiness, labels and teardown

The production readiness probe started a detached, project-labeled container, transferred its own tiny source using that same copy function, then checked non-root content readback and network isolation. The driver also inspected its run container and confirmed:

- Read-only root; network none; uid/gid 65532:65532.
- Capabilities dropped with ALL; no-new-privileges.
- 64 pids, 4 GiB memory and the disclosed two-CPU native-test cap.
- Source-only transfer; no host path, home, socket or credential mount.

The image and an added fixture label contained commas. The production inventory still found the owned container using project/name filters and individual JSON-encoded .Label fields. It never parsed the comma-joined .Labels display.

The shared lifecycle persisted a finished remote-shaped receipt, exit zero and linux/arm64 (remote docker 29.5.2). That is the library's platform string; this run used local Docker and no SSH connection. Production cleanup confirmed container absence and released the fixture repository heavy lease. Final project-scoped inventory was empty. The driver removed its own placeholder volume and fixture source, then released its separate native-verification reservation. No other project containers were stopped.

## Remaining work

The production runner remains unavailable until the separate admitted, lockfile/Bun-keyed dependency preparation exists (AC3). A real remote SSH leg, the unchanged four-CPU launch there, person opt-in and pi's live hub_check_start receipt (AC6) remain separate work. The fake transport/config regressions and final packaging gate are recorded with the PR's exact head.

## Dependency volume (793b)

Date: 2026-10-26. Same local Docker daemon (29.5.2, Colima, two CPUs), same preinstalled pinned image, no pull, and the same disclosed change: the driver lowered only the CPU cap to two. The driver used the production `remoteRunnerTransport` and `ContainerRunner` lifecycle with a direct Docker command port, on a synthetic repository whose only dependency was `is-number@7.0.0` and whose test asserted both that the dependency imports and that a write into `/work/node_modules` fails.

- First run: one `volume create`, one networked container, one `bun install --frozen-lockfile`, then the check exited zero with both tests passing.
- Second run, same commit: no volume create, no install, no container with a network; the check exited zero against the same volume.
- Afterwards no labelled container remained and exactly one labelled volume existed; the driver removed it.

This does not verify the remote SSH leg, the four-CPU launch, a person opt-in or pi's live `hub_check_start` receipt (AC6).
