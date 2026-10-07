import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { PiPeer, type PiToolSchema } from '../../src/adapters/pi.ts';
import type { PiToolStepCeiling } from '../../src/pi/ceiling.ts';
import { AcpPeer, canonicalMcpToolName } from '../../src/adapters/acp.ts';
import { Bus, type BusEvent } from '../../src/hub/bus.ts';
import { newEnvelope } from '../../src/hub/envelope.ts';
import { realPath } from '../../src/hub/project.ts';
import { loadConfig } from '../../src/hub/daemon.ts';
import { processTable } from '../../src/hub/child-process.ts';
import { startModelRelay, type RelayRequestRecord, type RelayToolSurface, toolSurfaceProjection } from '../../src/models/relay.ts';
import { OmniRoute } from '../../src/omniroute/client.ts';
import { runTool, guardPath } from '../../src/local/tools.ts';
import { profile } from '../../src/local/sandbox.ts';
import { sbplString } from '../../src/local/deny.ts';
import { captureFixtureRoot, endReasonOf, extend, fixtureRootProblem, reuseProblem, teardown, writeAtomic, withFixtureRoot, type Actor, type FixtureRootIdentity } from './teardown.ts';

/**
 * Headless native CooperBench driver for the Pi and Qwen arms (issue #140, manifest v3). Ported from the
 * 2026-10-04 private study harness with its calibration corrections:
 *
 * 1. The EFFECTIVE build is pinned, not the PATH bootstrap's claim: each spawned native's `--version` runs under
 *    the final isolation environment (Qwen inside its seatbelt profile with QWEN_HOME/TMPDIR set), and the binary
 *    path and version go into every attempt record; recovery moves those records with the builds inside.
 * 2. The negative probe is proven by a native read attempt with structured denial evidence (a guard denial or a
 *    failed read tool call with EPERM/EACCES), never by a model-written AHUB_PROBE_DENIED marker alone.
 * 3. Source guards follow the repository layout in the manifest's per-case `source_dirs` (src/ for Click/Jinja,
 *    dirty_equals/ for dirty_equals).
 * 4. New source files enter the binary submission patch (`git add -N` on the source dirs before
 *    `git diff --binary`).
 * 5. Setup resources (relay, tool server, peers) are disposed on every exit path; a disposal failure is recorded
 *    and never erases the active-window evidence or leaves the relay open.
 * 6. Existing attempt evidence is rejected before any record is written: the attempt directory must be new,
 *    started.json and native-owner.json are exclusive ('wx') claims, and no record is ever written over another.
 * 7. The driver is preflighted with strict typechecking (scripts/check.sh) and executable lifecycle checks, not
 *    transpilation alone.
 * 8. A setup probe failure carries a bounded structured diagnosis (#169): a fixed-enum, count-only trace bound to
 *    the peer, its session and the setup probe window, classifying WHY the native evidence predicate was not
 *    satisfied (agent behavior, tool event coverage or normalization, else explicit unknown). The diagnosis
 *    changes no predicate: the probe still counts only with structured denial evidence (correction 2), a failed
 *    setup stays unavailable with active elapsed zero, and nothing is retried or reclassified.
 * 9. A latched active-window terminal failure carries a bounded loop-protection diagnosis (#175): the pinned
 *    Qwen build's exact loop-protection message contract classifies as `tool-loop-protection` (any other cause
 *    stays unknown), and the active-window tool trace is count-only — update events, distinct reported ids,
 *    supported start/settlement counts, canonical tool categories (the protocol kinds plus the #138 canonical
 *    MCP binding) and the #169 error classes. The native guard's threshold, predicate and no-op signals are not
 *    exposed by the pinned build and are declared unavailable, never derived from event totals. The diagnosis
 *    changes nothing: the #160 latch, the end cause and the preserved failure class stand, and nothing is
 *    retried or continued.
 * 10. A latched Pi failure can additionally classify as `tool-step-ceiling` (#179), fed ONLY by the trusted
 *    extension's structured ceiling signal at its real rejection boundary — fixed kind/unit, validated
 *    finite nonnegative count/limit with count > limit, bound by the adapter to the session and turn
 *    generation, and bound here to the latched peer and active generation. Historical or arbitrary free
 *    text that resembles a ceiling stays unknown, the class stays distinct from shared execution-budget
 *    exhaustion (#102) and from Qwen's pinned loop-protection guard (#175), and the public view is fixed
 *    enums and counts only.
 * 11. Pi's tool descriptors are benchmark-specific (#182), generated from the executor's own allowlist
 *    (`benchPiToolProblem` is the single source of truth): source read/edit/write with in-scope writes
 *    applied without an approval step, git ls-files with plain relative path arguments only, and hub_send
 *    registered only when the arm assigns a peer. The general production TOOL_SCHEMAS (which advertise
 *    git status/diff/log/show/blame/rev-parse as free and approval-gated writes) stay untouched for normal
 *    managed peers and are never published here.
 * 12. The intended native tool surface is declared per native and arm (#183) and verified at bootstrap,
 *    before any scored generation: the relay journals each request's bounded tool-surface projection
 *    (allowlist-charset names, count and an opaque schema hash, never descriptions or arguments), and the
 *    driver reconciles it against the declared surface. A mismatched publication or an unknown published
 *    name fails the attempt as a condition mismatch; a native with no observed publication is recorded
 *    explicitly (`unobserved`) and defers generation, never inferred. The current treatment (Qwen --bare, the exclusion list,
 *    the #138 MCP binding) is pinned and verified, not changed.
 *
 * Served-model evidence comes from the relay's journaled RelayRequestRecord per request (#139); Qwen's MCP tool
 * approval uses the adapter's shipped tool-identity binding (#138): the exact canonical name only. The headless
 * path never touches Orca registrations: it spawns no terminal and registers nothing.
 */

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const sourceHash = (path: string) => sha(readFileSync(path));

/** Row of the preregistered odd-n Williams layout: repeat*<case count>+caseIndex (manifest v3 `order_rule`). */
export function v3ArmOrder(arms: string[], caseIndex: number, repeat: number, caseCount: number): string[] {
    const n = arms.length, row = repeat * caseCount + caseIndex, shift = row % n;
    const order = Array.from({ length: n }, (_, j) => arms[(j + shift) % n]!);
    return Math.floor(row / n) % 2 ? order.reverse() : order;
}

/** Joint feature ownership, fixed before any model call: Pi gets (caseIndex+repeat)%2, Qwen the other. */
export function jointAssignment(caseIndex: number, repeat: number): { pi: number; qwen: number } {
    const pi = (caseIndex + repeat) % 2;
    return { pi, qwen: 1 - pi };
}

/** A project-relative path is inside the guarded source layout (correction 3). */
export const isSourcePath = (sourceDirs: string[], rel: string) => sourceDirs.some((d) => rel === d || rel.startsWith(d + '/'));

/**
 * The benchmark Pi executor's tool allowlist (#182). Every tool the benchmark registers for Pi; anything
 * else is unknown. The descriptors published to the model are generated from the same policy below, so a
 * capability the wrapper refuses is never advertised and an advertised capability is never refused at the
 * argument level.
 */
export const BENCH_PI_TOOL_NAMES = ['read', 'write', 'edit', 'git', 'hub_send'] as const;
export type BenchPiToolName = (typeof BENCH_PI_TOOL_NAMES)[number];

/** The executor policy inputs that decide an argument-level refusal. */
export interface BenchPiPolicy {
    /** Fixture root, for lexical path normalization (the wrapper re-checks after guardPath resolution). */
    cwd: string;
    sourceDirs: string[];
    /** The joint arm assigns a peer; solo arms have no peer messaging at all. */
    joint: boolean;
    /** Peer messaging is refused outside the active task window. */
    active: boolean;
}

/**
 * The argument-level refusal of one benchmark Pi tool call (#182), the single source of truth shared by
 * the published descriptors and the executor wrapper. Pure: no filesystem, no side effects. `read` is
 * always permitted here (guardPath and the denylist still constrain it at execution); `write`/`edit` must
 * name a path inside the guarded source layout; `git` is exactly `ls-files` with plain relative path
 * arguments (no flags, no absolute paths, no `..`); `hub_send` requires an assigned peer in the active
 * window. The returned strings are the executor's refusal messages.
 */
export function benchPiToolProblem(name: string, args: Record<string, unknown>, policy: BenchPiPolicy): string | undefined {
    if (!(BENCH_PI_TOOL_NAMES as readonly string[]).includes(name)) return `unknown tool ${name}`;
    if (name === 'write' || name === 'edit') {
        const rel = relative(policy.cwd, resolve(policy.cwd, String(args.path ?? '')));
        if (!isSourcePath(policy.sourceDirs, rel)) return 'source edits only under ' + policy.sourceDirs.join(', ') + '/';
    }
    if (name === 'git') {
        const gitArgs: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
        if (gitArgs[0] !== 'ls-files' || gitArgs.some((v) => v.startsWith('-') || v.includes('..') || v.startsWith('/'))) return 'git ls-files only';
    }
    if (name === 'hub_send' && (!policy.joint || !policy.active)) return 'no other assigned peer';
    return undefined;
}

const benchStr = { type: 'string' } as const;

/**
 * The tool descriptors published to Pi for one arm (#182), generated from the executor policy. Every
 * sentence matches what the wrapper permits: writes and edits inside the source layout are applied
 * directly (the benchmark's own auto-permit, no user approval exists here), git offers exactly the
 * ls-files enumeration the wrapper accepts and names the other operations as refused, and hub_send
 * exists only when the arm assigns a peer. Parameter shapes mirror the production schemas the shared
 * runTool executes, except hub_send: the wrapper fixes the peer, so no `to` argument is advertised.
 */
export function benchPiToolDescriptors(policy: { sourceDirs: string[]; joint: boolean }): PiToolSchema[] {
    const dirs = policy.sourceDirs.map((d) => d + '/').join(', ');
    const tools: PiToolSchema[] = [
        { name: 'read', description: 'Read a text file inside the project. Returns numbered lines.', parameters: { type: 'object', properties: { path: benchStr, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false } },
        { name: 'write', description: `Create or overwrite a source file under ${dirs} In-scope source writes are applied directly; anything outside the source directories is refused.`, parameters: { type: 'object', properties: { path: benchStr, content: benchStr }, required: ['path', 'content'], additionalProperties: false } },
        { name: 'edit', description: `Replace one exact, unique occurrence of \`old\` with \`new\` in a source file under ${dirs} In-scope edits are applied directly; edits outside the source directories are refused.`, parameters: { type: 'object', properties: { path: benchStr, old: benchStr, new: benchStr }, required: ['path', 'old', 'new'], additionalProperties: false } },
        { name: 'git', description: 'List the files git tracks: only `git ls-files` with plain relative path arguments is available (no flags, no absolute paths, no `..`). Every other git operation (status, diff, log, show, blame, rev-parse, add, commit, push, ...) is refused.', parameters: { type: 'object', properties: { args: { type: 'array', items: benchStr, minItems: 1 } }, required: ['args'], additionalProperties: false } },
    ];
    if (policy.joint) tools.push({ name: 'hub_send', description: 'Send a message to the other agent assigned to this shared checkout, during the active task window. Conclusions only. Your final answer is shared anyway; use this for something that cannot wait.', parameters: { type: 'object', properties: { text: benchStr }, required: ['text'], additionalProperties: false } });
    return tools;
}

/** The canonical MCP peer-messaging tool of the joint arm, the only name on the #138 whitelist. */
export const JOINT_MCP_TOOL = 'mcp__pilot-peer-bus__hub_send';

/**
 * The pinned Qwen build's effective native publication under the benchmark's `--bare` launch (#183): the
 * controlled no-model probe of the actual pinned Qwen 0.24.7 ACP binary observed exactly `read_file` and
 * `edit` published with the benchmark's exclusion list (its qwen-surface-probe.json stays private). The
 * joint arm's peer bus adds the canonical MCP name. Bare mode and the exclusions are the CURRENT
 * treatment: this declaration pins and verifies them; it changes nothing.
 */
export const QWEN_BARE_PUBLISHED = ['edit', 'read_file'] as const;

/** Versioned expected publication from an isolated no-model capture, never learned from study traffic. */
export interface NativeSurfaceAttestation {
    sourceFiles: Record<string, string>;
    schemas: { solo: string; joint: string };
}
// Filled only from the pinned-build bootstrap capture before collecting a new study condition.
export const QWEN_SURFACE_ATTESTATION: NativeSurfaceAttestation = {
    sourceFiles: {
  "package.json": "4741fd922f84ddfdb377ed579439d35d41d527072d3e334ae5f135d23eea5bad",
  "cli.js": "25f33ddb1be51d39d5bf9bb00dd07a9b3fa45df220b2fe4a4354fb33f67d0df6",
  "cli-entry.js": "06c2be3fcb1b451931d3e100acc7edd3ff748c74189f6fcc70300b5cd758f8e6",
  "chunks/chunk-GDDUKWKB.js": "25cbc08a5d02b0ab3329261a48ed1179b18c6460556fc6aa20e9684c2689967e",
  "chunks/chunk-AN36BHDM.js": "e927d87f7d3ce5e8a3ee9013258acfbf5bdbb702424a5b35e7ac0d49a970a411",
  "chunks/acpAgent-UCU7OI47.js": "4381baa6c5f880ef9e97665dbf1f9601e9727d842b29b0556161d3183a05ff7d",
  "chunks/chunk-RNCNPWV4.js": "8d0c96f0270ac5dfb7aed400c2a16bd126043270e01a8f8888cd9e3c381438ff"
},
    schemas: { solo: '59630e41a3d4f71bbd3aff7a3cde175c4ab45abcb535f704beb0fe450b478ee1', joint: '49f829387c04e0031b7af2a6f894b412418a409673a976c31ffa9ffa8b7a1465' },
};

export const STUDY_TOOL_CONDITION = 'agent-hub.native-tools/v2';
export function requireToolStudyCondition(value: unknown): void {
    if (value !== STUDY_TOOL_CONDITION) throw new Error('native tool condition requires a new native-tools/v2 manifest');
}

export function verifySurfaceSource(packageRoot: string, attestation: NativeSurfaceAttestation): string {
    const entries = Object.entries(attestation.sourceFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (!entries.length || entries.length > 32) throw new Error('native surface source pins unavailable');
    for (const [path, expected] of entries) {
        if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith('/') || path.split('/').includes('..') || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('native surface source pin invalid');
        if (sourceHash(join(packageRoot, path)) !== expected) throw new Error('native surface source differs from attestation');
    }
    return sha(JSON.stringify(entries));
}

/**
 * The intended published tool surface of one native in one arm (#183): the exact declared-to-model name
 * set, the canonical MCP names inside it, the intentionally excluded native tools, the verified native
 * registry compatibility aliases (none are pinned for the verified builds — a non-excluded name is never
 * assumed registered), and how the effective surface is read back. Pi's surface is published by the
 * driver itself (#182 descriptors); Qwen's is its own registry's publication, observed at the relay.
 */
export interface IntendedNativeSurface {
    native: 'pi' | 'qwen';
    published: string[];
    mcp: string[];
    excluded: string[];
    aliases: Record<string, string>;
    discovery: 'driver-published' | 'relay-request-tools';
    expectedSchemaSha256?: string;
    sourceSha256?: string;
    bootstrapSchemaSha256?: string;
    bootstrapPublished?: string[];
}

/** The intended surfaces of one arm's natives, sorted names, from the same sources the launch uses. */
export function intendedSurfaces(arm: string, sourceDirs: string[], qwenExcluded: string[], attestation: NativeSurfaceAttestation | undefined = QWEN_SURFACE_ATTESTATION): IntendedNativeSurface[] {
    const surfaces: IntendedNativeSurface[] = [];
    if (arm !== 'solo-qwen') {
        const published = benchPiToolDescriptors({ sourceDirs, joint: arm === 'joint-pi-qwen' }).map((t) => t.name).sort();
        surfaces.push({ native: 'pi', published, mcp: [], excluded: [], aliases: {}, discovery: 'driver-published', expectedSchemaSha256: toolSurfaceProjection(benchPiToolDescriptors({ sourceDirs, joint: arm === 'joint-pi-qwen' }))!.schemaSha256, sourceSha256: sourceHash(import.meta.path) });
    }
    if (arm !== 'solo-pi') {
        const mcp = arm === 'joint-pi-qwen' ? [JOINT_MCP_TOOL] : [];
        surfaces.push({ native: 'qwen', published: [...QWEN_BARE_PUBLISHED, ...mcp].sort(), mcp, excluded: [...qwenExcluded].sort(), aliases: {}, discovery: 'relay-request-tools', expectedSchemaSha256: attestation?.schemas[arm === 'joint-pi-qwen' ? 'joint' : 'solo'], sourceSha256: attestation ? sha(JSON.stringify(Object.entries(attestation.sourceFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) : undefined, ...(arm === 'joint-pi-qwen' ? { bootstrapSchemaSha256: attestation?.schemas.solo, bootstrapPublished: [...QWEN_BARE_PUBLISHED] } : {}) });
    }
    return surfaces;
}

/**
 * The fixed class of one observed tool name against the declared surfaces (#183): `declared` (published
 * to the model), `alias` (a pinned native registry compatibility alias — never a permission widening),
 * `excluded` (intentionally excluded), else `unknown`. Unknown requested names (the persisted
 * tool_not_registered rejections) diagnose against this without synthesizing execution counts.
 */
export function surfaceNameClass(name: string, intended: IntendedNativeSurface[]): 'declared' | 'alias' | 'excluded' | 'unknown' {
    for (const s of intended) if (s.published.includes(name)) return 'declared';
    for (const s of intended) if (name in s.aliases) return 'alias';
    for (const s of intended) if (s.excluded.includes(name)) return 'excluded';
    return 'unknown';
}

/** One native's reconciliation verdict (#183). `observedNames`/`missingNames` carry allowlisted declared names only; extras are counted, never named. */
export interface SurfaceNativeReport {
    native: string;
    verdict: 'matched' | 'mismatched' | 'unobserved';
    observedCount?: number;
    observedNames?: string[];
    missingNames?: string[];
    extraNameCount?: number;
    schemaSha256?: string;
}

export interface SurfaceReconciliation {
    natives: SurfaceNativeReport[];
    /** Distinct published names that no declared surface, alias or MCP name accounts for; never named. */
    unknownNameCount: number;
    /** Distinct observed name sets. */
    observedSets: number;
    rejectedObservations: number;
    missingAttestations: number;
    requiredPublicationsMissing: number;
}

/**
 * Reconcile every ordered relay observation against the complete expected structural schema and exact
 * declared names. Incomplete/duplicate/truncated entries and any drift remain rejected even beside an
 * earlier matching publication. Identical full observations dedupe for reporting only. A native matches
 * only its attested final surface. The pinned Qwen joint bootstrap may publish its solo surface before
 * final MCP publication, never after. Missing discovery is recorded unobserved and separately defers
 * generation; unknown names are counted, never exported.
 */
export function reconcileToolSurfaces(intended: IntendedNativeSurface[], observed: RelayToolSurface[]): SurfaceReconciliation {
    const bySet = new Map<string, RelayToolSurface>();
    let rejectedObservations = 0;
    const finalized = new Set<string>();
    for (const o of observed) {
        const key = JSON.stringify(o);
        if (!bySet.has(key)) bySet.set(key, o);
        const complete = o.invalidEntries === 0 && o.duplicateNames === 0 && o.truncated === false && o.count === o.names.length;
        const matches = complete && intended.some((s) => s.expectedSchemaSha256 === o.schemaSha256
            && s.published.length === o.names.length && s.published.every((n) => o.names.includes(n)));
        if (matches) {
            for (const s of intended) if (s.expectedSchemaSha256 === o.schemaSha256 && s.published.length === o.names.length && s.published.every((n) => o.names.includes(n))) finalized.add(s.native);
        } else {
            // Pinned Qwen MCP startup registers asynchronously. Only its exact two-tool publication may
            // precede the exact joint three-tool publication; it cannot recur after joint readiness.
            const transitioning = complete && intended.some((s) => !finalized.has(s.native)
                && s.bootstrapSchemaSha256 === o.schemaSha256 && s.bootstrapPublished?.length === o.names.length
                && s.bootstrapPublished.every((n) => o.names.includes(n)));
            if (!transitioning) rejectedObservations++;
        }
    }
    const sets = [...bySet.values()];
    const known = new Set(intended.flatMap((s) => [...s.published, ...Object.keys(s.aliases)]));
    const unknowns = new Set(sets.flatMap((o) => o.names.filter((n) => !known.has(n))));
    const natives = intended.map((s): SurfaceNativeReport => {
        const touching = sets.filter((o) => o.names.some((n) => s.published.includes(n))
            && !intended.some((other) => other.native !== s.native && o.invalidEntries === 0 && o.duplicateNames === 0 && !o.truncated
                && o.count === other.published.length && o.names.length === other.published.length
                && o.names.every((n) => other.published.includes(n)) && o.schemaSha256 === other.expectedSchemaSha256));
        const exact = touching.find((o) => o.invalidEntries === 0 && o.duplicateNames === 0 && !o.truncated
            && o.count === s.published.length && o.names.length === s.published.length
            && o.names.every((n) => s.published.includes(n)) && o.schemaSha256 === s.expectedSchemaSha256);
        if (exact) return { native: s.native, verdict: 'matched', observedCount: exact.count, observedNames: exact.names, schemaSha256: exact.schemaSha256 };
        if (touching.length && touching.every((o) => o.invalidEntries === 0 && o.duplicateNames === 0 && !o.truncated
            && s.bootstrapPublished?.length === o.count && s.bootstrapPublished.length === o.names.length
            && o.names.every((n) => s.bootstrapPublished!.includes(n)) && o.schemaSha256 === s.bootstrapSchemaSha256)) {
            return { native: s.native, verdict: 'unobserved' }; // pinned transition seen, final publication still missing
        }
        if (touching.length) {
            const overlap = (o: RelayToolSurface) => o.names.filter((n) => s.published.includes(n)).length;
            const best = touching.reduce((a, b) => overlap(b) > overlap(a) ? b : a);
            return { native: s.native, verdict: 'mismatched', observedCount: best.count, observedNames: best.names.filter((n) => s.published.includes(n)), missingNames: s.published.filter((n) => !best.names.includes(n)), extraNameCount: best.names.filter((n) => !s.published.includes(n)).length, schemaSha256: best.schemaSha256 };
        }
        return { native: s.native, verdict: 'unobserved' };
    });
    return { natives, unknownNameCount: unknowns.size, observedSets: sets.length, rejectedObservations,
        missingAttestations: intended.filter((s) => !s.expectedSchemaSha256 || !s.sourceSha256).length,
        requiredPublicationsMissing: intended.filter((s) => s.bootstrapPublished !== undefined && natives.find((n) => n.native === s.native)?.verdict !== 'matched').length };
}

/**
 * The declared fail/defer policy's fail condition (#183): a mismatched publication or any unknown
 * published name is a condition mismatch. An unobserved native is kept distinct from mismatch; the
 * surfaceReadinessProblem gate defers all missing discovery before scored generation.
 */
export function surfaceMismatchProblem(surface: SurfaceReconciliation): string | undefined {
    if (surface.unknownNameCount > 0) return `${surface.unknownNameCount} published tool name(s) match no declared surface, alias or exclusion`;
    if (surface.missingAttestations > 0) return 'expected native schema/source attestation unavailable';
    if (surface.requiredPublicationsMissing > 0) return 'required qwen joint publication was not observed';
    const mismatched = surface.natives.filter((n) => n.verdict === 'mismatched');
    if (mismatched.length) return `the effective published tool surface differs from the declared surface for ${mismatched.map((n) => n.native).join(', ')}`;
    if (surface.rejectedObservations > 0) return 'published schema, entry integrity or additional observation differs from the declared surface';
    return undefined;
}

/** Missing discovery is a defer condition, distinct from a mismatched publication, and must stop before
 * active generation. Every required native needs its fully attested publication, including solo arms. */
export function surfaceReadinessProblem(surface: SurfaceReconciliation): string | undefined {
    const mismatch = surfaceMismatchProblem({ ...surface, requiredPublicationsMissing: 0 });
    if (mismatch) return mismatch;
    if (surface.natives.some((n) => n.verdict === 'unobserved')) return 'tool surface discovery unavailable; generation deferred';
    return undefined;
}

/**
 * The bounded tool-surface block of an attempt record (#182, #183): allowlisted declared names, counts
 * and opaque hashes only. The exclusion list enters as its count and hash, aliases as a count, and the
 * whole declaration as its definition hash; observed extras are counted, never named. No description,
 * path, example, argument or model text can appear here.
 */
export function surfaceReport(intended: IntendedNativeSurface[], surface: SurfaceReconciliation): Record<string, unknown> {
    const byNative = new Map(surface.natives.map((n) => [n.native, n]));
    return {
        definition_sha256: sha(JSON.stringify(intended)),
        policy: 'mismatch, incomplete entries or missing attestation fail; unobserved discovery defers before generation; joint permits only pinned bootstrap two-to-three transition',
        observedSets: surface.observedSets,
        unknownNameCount: surface.unknownNameCount,
        rejectedObservations: surface.rejectedObservations,
        missingAttestations: surface.missingAttestations,
        requiredPublicationsMissing: surface.requiredPublicationsMissing,
        readiness: surfaceReadinessProblem(surface) === undefined ? 'ready' : surface.natives.some((n) => n.verdict === 'unobserved') && surface.unknownNameCount === 0 && surface.rejectedObservations === 0 && surface.missingAttestations === 0 ? 'deferred' : 'failed',
        natives: intended.map((s) => {
            const { native: _reportNative, ...report } = byNative.get(s.native) ?? { native: s.native, verdict: 'unobserved' as const };
            return {
                native: s.native,
                discovery: s.discovery,
                expectedSchemaSha256: s.expectedSchemaSha256,
                sourceSha256: s.sourceSha256,
                bootstrapSchemaSha256: s.bootstrapSchemaSha256,
                published: s.published,
                mcp: s.mcp,
                excludedCount: s.excluded.length,
                excludedSha256: s.excluded.length ? sha(JSON.stringify(s.excluded)) : undefined,
                aliasCount: Object.keys(s.aliases).length,
                ...report,
            };
        }),
    };
}

/**
 * The count-only setup probe window statistics (#169). Every field is a non-negative integer counter; no path,
 * argument, answer text or error string is ever copied here, so the safe view built from these counters cannot
 * carry model-controlled content. `toolEventsSeen` counts every protocol tool event in the window; the rest
 * classify the announced read calls against the probe target.
 */
export interface ProbeWindowStats {
    readsAttempted: number;
    targetReads: number;
    settledTargetReads: number;
    permissionDenials: number;
    otherFailures: number;
    unclassedFailures: number;
    completedTargetReads: number;
    wrongTargetReads: number;
    toolEventsSeen: number;
}

export const emptyProbeWindowStats = (): ProbeWindowStats => ({ readsAttempted: 0, targetReads: 0, settledTargetReads: 0, permissionDenials: 0, otherFailures: 0, unclassedFailures: 0, completedTargetReads: 0, wrongTargetReads: 0, toolEventsSeen: 0 });

/**
 * The bounded error class of a failed tool call, reduced to a fixed enum (#169). `permission` is exactly the
 * #140 denial predicate (EPERM/EACCES/permission denied anywhere in the serialized content); `unparsed` is a
 * failure whose content carries no extractable error text at all (malformed). The raw error text never leaves
 * this function.
 */
export const probeErrorClass = (content: unknown): 'permission' | 'not-found' | 'other' | 'unparsed' => {
    const text = JSON.stringify(content ?? []);
    if (text === '[]' || text === '{}' || text === 'null') return 'unparsed';
    if (/EPERM|EACCES|permission denied/i.test(text)) return 'permission';
    if (/ENOENT|no such file/i.test(text)) return 'not-found';
    return 'other';
};

/** One announced native read, its exact target and its denial must share a call id. */
export class ProtectedReadProbe {
    private readonly calls = new Map<string, { read: boolean; path?: string; conflictingPath?: boolean }>();
    private readonly window = emptyProbeWindowStats();
    denied = false;

    constructor(private readonly target: string) {}

    observe(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        const update = value as { sessionUpdate?: string; toolCallId?: string; kind?: string; status?: string; rawInput?: { file_path?: unknown }; content?: unknown };
        if (typeof update.toolCallId !== 'string') return;
        const id = update.toolCallId;
        if (update.sessionUpdate === 'tool_call') {
            this.window.toolEventsSeen++;
            if (update.kind === 'read') this.window.readsAttempted++;
            // A reused id is a new call; mutable updates cannot rewrite its announced kind.
            this.calls.set(id, { read: update.kind === 'read' });
            while (this.calls.size > 128) this.calls.delete(this.calls.keys().next().value!);
        } else if (update.sessionUpdate === 'tool_call_update') {
            this.window.toolEventsSeen++;
        } else return;
        const call = this.calls.get(id);
        if (!call) return; // terminal or never announced: a late update cannot revive old evidence
        const path = update.rawInput?.file_path;
        if (typeof path === 'string') {
            if (call.path !== undefined && call.path !== path) call.conflictingPath = true;
            call.path ??= path; // Qwen reports arguments on the in-progress update, after announcement
        }
        if (update.status === 'failed' || update.status === 'completed') {
            this.calls.delete(id);
            if (!call.read) return;
            if (call.path === this.target && !call.conflictingPath) {
                this.window.settledTargetReads++;
                if (update.status === 'completed') {
                    this.window.completedTargetReads++;
                    return;
                }
                const cls = probeErrorClass(update.content);
                if (cls === 'permission') {
                    this.window.permissionDenials++;
                    this.denied = true;
                } else if (cls === 'unparsed') this.window.unclassedFailures++;
                else this.window.otherFailures++;
            } else this.window.wrongTargetReads++;
        }
    }

    /** A copy of the window counters: a snapshot taken at probe evaluation is bound to the setup window forever. */
    stats(): ProbeWindowStats {
        return { ...this.window };
    }
}

/**
 * What one peer's setup-only protected-file probe actually observed (issue #150). The serialized readiness is
 * built from this and nothing else: a probe that never settled or never ran is `unknown`, one that settled
 * without the structured denial evidence is `failed`, and only the observed structured denial (a guard denial
 * for Pi, `ProtectedReadProbe.denied` for Qwen) is `denied` — never a synthesized denial success.
 */
export type ProbeOutcome =
    | { checked: true; result: 'denied'; evidence: 'guard-denial' | 'tool-failure'; reason?: undefined }
    | { checked: boolean; result: 'failed' | 'unknown'; evidence?: undefined; reason: string };

/** One peer's probe window, reduced to what its readiness record may claim. */
export function evaluateProbe(peer: string, observation: { denial: boolean; answers: string[]; settled: boolean; state: string }): ProbeOutcome {
    if (observation.state === 'offline' || observation.state === 'paused') return { checked: false, result: 'unknown', reason: `the probe peer is ${observation.state}` };
    if (!observation.settled) return { checked: false, result: 'unknown', reason: 'the probe never settled before its deadline' };
    if (observation.answers.some((s) => s.includes('AHUB_PROBE_ACCESSIBLE'))) return { checked: true, result: 'failed', reason: 'the peer reported the protected file accessible' };
    const marked = observation.answers.some((s) => s.includes('AHUB_PROBE_DENIED'));
    // Pi's denial must pair the guard denial with the peer's own probe answer; Qwen's is the bound tool failure alone.
    if (observation.denial && (peer === 'qwen' || marked)) return { checked: true, result: 'denied', evidence: peer === 'pi' ? 'guard-denial' : 'tool-failure' };
    return { checked: true, result: 'failed', reason: observation.denial ? 'the denial evidence lacks the peer probe answer' : 'no structured denial evidence was observed' };
}

/**
 * The fixed trace events of the bounded setup-probe diagnosis (#169). The safe view carries only these keys,
 * each with a count: how many window events of that kind were observed. Nothing else — no paths, no tool
 * arguments, no answer text, no error strings — may appear under any of them.
 */
export const PROBE_TRACE_EVENTS = ['target-read-attempted', 'target-matched', 'tool-settled', 'permission-outcome', 'structured-error-class', 'answer-only', 'peer-offline', 'deadline', 'protocol-evidence-unavailable'] as const;
export type ProbeTraceEvent = (typeof PROBE_TRACE_EVENTS)[number];

/**
 * The diagnosed category of a setup probe outcome (#169). `verified-denial` is the satisfied predicate; every
 * other category is a distinct failure cause: the peer reported or achieved access (`accessible`), answered
 * without any tool call (`answer-only`), never attempted a read (`no-read-attempted`), read only other paths
 * (`wrong-target`), saw a permission refusal that is not the evidence class this peer's predicate accepts
 * (`permission-refused`), saw the denial evidence without the peer's pairing answer (`denial-unconfirmed`),
 * failed the target read with a malformed or non-permission error (`unsupported-error`), went offline
 * (`peer-offline`) or ran out the probe deadline (`deadline`). `protocol-evidence-unavailable` is a settled
 * window with answers or activity the protocol stream cannot account for; `unknown` is everything unresolved.
 */
export const PROBE_DIAGNOSIS_CATEGORIES = ['verified-denial', 'accessible', 'answer-only', 'no-read-attempted', 'wrong-target', 'permission-refused', 'denial-unconfirmed', 'unsupported-error', 'peer-offline', 'deadline', 'protocol-evidence-unavailable', 'unknown'] as const;
export type ProbeDiagnosisCategory = (typeof PROBE_DIAGNOSIS_CATEGORIES)[number];

/** Where the diagnosed cause lies (#169): agent behavior, tool event coverage, normalization, none (a verified denial), or explicitly unknown. */
export const PROBE_DIAGNOSIS_ORIGINS = ['agent-behavior', 'tool-event-coverage', 'normalization', 'none', 'unknown'] as const;
export type ProbeDiagnosisOrigin = (typeof PROBE_DIAGNOSIS_ORIGINS)[number];

/** One peer's bounded probe diagnosis, bound to that peer, its session and the setup probe window (#169). */
export interface ProbeDiagnosis {
    peer: string;
    session?: string;
    window: 'setup-probe';
    category: ProbeDiagnosisCategory;
    origin: ProbeDiagnosisOrigin;
    counts: Record<ProbeTraceEvent, number>;
}

/** A session id enters the safe view only as an opaque bounded token; anything else is dropped. */
const cleanSessionId = (value: unknown): string | undefined => (typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined);

/**
 * Why the native protected-file probe evidence predicate was not satisfied (#169), reduced to a fixed category,
 * a coarse origin and count-only trace events. The decision order mirrors evaluateProbe exactly, so the diagnosis
 * can never disagree with the predicate it explains: accessible first, then the satisfied denial, then the
 * failure causes. Causes that cannot be told apart (a marker answer with no tool events could be agent behavior
 * or a tool-event coverage gap) stay explicitly `unknown`. This function changes no predicate.
 */
export function diagnoseProbe(peer: string, observation: { denial: boolean; answers: string[]; settled: boolean; state: string; deadlineExpired: boolean; stats: ProbeWindowStats; sessionId?: string }): ProbeDiagnosis {
    const s = observation.stats;
    const counts: Record<ProbeTraceEvent, number> = {
        'target-read-attempted': s.readsAttempted,
        'target-matched': s.targetReads,
        'tool-settled': s.settledTargetReads,
        'permission-outcome': s.permissionDenials,
        'structured-error-class': s.permissionDenials + s.otherFailures,
        'answer-only': 0,
        'peer-offline': 0,
        deadline: 0,
        'protocol-evidence-unavailable': 0,
    };
    const marked = observation.answers.some((a) => a.includes('AHUB_PROBE_DENIED'));
    const accessible = observation.answers.some((a) => a.includes('AHUB_PROBE_ACCESSIBLE'));
    let category: ProbeDiagnosisCategory = 'unknown';
    let origin: ProbeDiagnosisOrigin = 'unknown';
    if (observation.state === 'offline' || observation.state === 'paused') {
        category = 'peer-offline';
        counts['peer-offline'] = 1;
    } else if (!observation.settled) {
        if (observation.deadlineExpired) {
            category = 'deadline';
            counts.deadline = 1;
        }
        if (s.toolEventsSeen === 0) counts['protocol-evidence-unavailable'] = 1;
    } else if (accessible || s.completedTargetReads > 0) {
        category = 'accessible';
        origin = 'agent-behavior';
    } else if (observation.denial && (peer === 'qwen' || marked)) {
        category = 'verified-denial';
        origin = 'none';
    } else if (observation.denial) {
        // The structured denial was observed but the peer's own probe answer never paired with it (#150 stands).
        category = 'denial-unconfirmed';
        origin = 'agent-behavior';
    } else if (s.permissionDenials > 0) {
        // A refusal was seen, but not in the evidence class this peer's predicate accepts (e.g. Pi's seatbelt
        // kernel error string, which is not its guard denial): a normalization boundary, not agent behavior.
        category = 'permission-refused';
        origin = 'normalization';
    } else if (s.unclassedFailures > 0 || s.otherFailures > 0) {
        category = 'unsupported-error';
        origin = s.unclassedFailures > 0 ? 'normalization' : 'agent-behavior';
    } else if (s.targetReads === 0 && s.readsAttempted > 0) {
        category = 'wrong-target';
        origin = 'agent-behavior';
    } else if (s.readsAttempted === 0 && observation.answers.length > 0) {
        category = 'answer-only';
        counts['answer-only'] = 1;
        if (s.toolEventsSeen === 0) counts['protocol-evidence-unavailable'] = 1;
        // Agent behavior (the model never called the tool) and a tool-event coverage gap are indistinguishable here.
    } else if (s.readsAttempted === 0) {
        category = s.toolEventsSeen === 0 ? 'protocol-evidence-unavailable' : 'no-read-attempted';
        origin = s.toolEventsSeen === 0 ? 'unknown' : 'agent-behavior';
        if (s.toolEventsSeen === 0) counts['protocol-evidence-unavailable'] = 1;
    }
    return { peer, session: cleanSessionId(observation.sessionId), window: 'setup-probe', category, origin, counts };
}

/**
 * The strict scalar allowlist serialization of a probe diagnosis (#169): every key is fixed, every string comes
 * from a fixed enum (or the sanitized session token), every count is coerced to a non-negative safe integer.
 * Whatever nested content the model or the tool stream carried, it cannot inject keys or strings into this view.
 */
export function safeProbeDiagnosis(d: ProbeDiagnosis): Record<string, unknown> {
    const counts: Record<string, number> = {};
    for (const e of PROBE_TRACE_EVENTS) {
        const n: unknown = d.counts[e];
        counts[e] = typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    }
    const out: Record<string, unknown> = {
        peer: d.peer === 'pi' || d.peer === 'qwen' ? d.peer : 'unknown',
        window: 'setup-probe',
        category: (PROBE_DIAGNOSIS_CATEGORIES as readonly string[]).includes(d.category) ? d.category : 'unknown',
        origin: (PROBE_DIAGNOSIS_ORIGINS as readonly string[]).includes(d.origin) ? d.origin : 'unknown',
        counts,
    };
    const session = cleanSessionId(d.session);
    if (session !== undefined) out.session = session;
    return out;
}

/**
 * The serialized sandboxProbe readiness of one peer (#150). Only an observed structured denial serializes
 * `checked: true, result: "denied"`; a missing or failed probe is explicit, never a synthesized denial. Qwen's
 * record also carries the seatbelt layer's kernel probe, which ran before the peer launched. A failed or unknown
 * probe additionally carries its bounded diagnosis (#169) — the unavailable setup reason, kept separate from
 * any active-window peer failure — while a verified denial's record keeps its exact pre-#169 shape.
 */
export function probeReadiness(peer: string, outcome: ProbeOutcome | undefined, targetSha256: string, kernelDenied?: boolean, diagnosis?: ProbeDiagnosis): Record<string, unknown> {
    const o: ProbeOutcome = outcome ?? { checked: false, result: 'unknown', reason: 'the probe never ran' };
    const probe: Record<string, unknown> = { checked: o.checked, result: o.result, target_sha256: targetSha256 };
    if (o.evidence) probe.evidence = o.evidence;
    if (o.reason) probe.reason = o.reason;
    if (diagnosis && o.result !== 'denied') probe.diagnosis = safeProbeDiagnosis(diagnosis);
    if (peer === 'qwen' && kernelDenied !== undefined) probe.kernelProbe = kernelDenied ? { checked: true, result: 'denied' } : { checked: false, result: 'unknown' };
    return probe;
}

export interface RequestLinkage {
    requests: number;
    completed: number;
    identified: number;
    cancelledUnidentified: number;
    mismatches: number;
    providerMissing: number;
}

/** The preserved metadata of a terminal active-turn peer failure (#160): peer, original failure class and time. */
export interface PeerFailure {
    peer: string;
    failureClass: string;
    failedAt: string;
    activeElapsedMs: number;
    generation: number;
}

/**
 * The terminal active-turn failure latch of one attempt (#160). A required peer's terminal failure during the
 * active phase ends the whole attempt at once, with the original failure class and time preserved (the first
 * latch wins), instead of waiting out the wall limit for an answer the failed peer cannot produce. The latch is
 * fenced twice: by phase — only the active window between `begin` and `freeze` latches, so a setup-phase failure
 * (an expected denied tool read is a tool error, and even a turn failure there never latches) and a stop or
 * watchdog callback during teardown are recorded as events but never change the end cause — and by generation:
 * each attempt's active phase is a new generation, so a callback belonging to an earlier turn cannot bind to it.
 */
export class ActiveFailureLatch {
    private phase: 'setup' | 'active' | 'ended' = 'setup';
    private generation = 0;
    private activeStart = 0;
    private latched: PeerFailure | undefined;

    /** Opens the attempt's next active generation at `now` (ms epoch): a fresh generation latches afresh. */
    begin(now: number): void {
        this.phase = 'active';
        this.generation += 1;
        this.activeStart = now;
        this.latched = undefined;
    }

    /** Freezes the end cause at active_end: later failures are teardown events only. */
    freeze(): void {
        this.phase = 'ended';
    }

    /** Records a peer's terminal turn failure. The first failure of the active generation latches; every other call is an event. */
    note(peer: string, reason: string, now: number): { latched: boolean; phase: string } {
        if (this.phase !== 'active') return { latched: false, phase: this.phase };
        this.latched ??= { peer, failureClass: reason.slice(0, 300), failedAt: new Date(now).toISOString(), activeElapsedMs: now - this.activeStart, generation: this.generation };
        return { latched: true, phase: this.phase };
    }

    /** The first failure of the current active generation, if one latched. */
    get failure(): PeerFailure | undefined {
        return this.latched;
    }

    /** The current generation (`begin` increments it); what an active-window diagnostic binds to. */
    get currentGeneration(): number {
        return this.generation;
    }

    /** Whether the end cause was frozen at active_end. */
    get frozen(): boolean {
        return this.phase === 'ended';
    }
}

/**
 * Why the active poll ends this tick (#160), or undefined to keep waiting. A latched terminal peer failure
 * outranks both an unreachable peer (its failure callback is what latches, so the original class is kept) and
 * the idle wait for answers: the attempt stops at once instead of idling out the wall limit. An operator's
 * interrupt outranks the failure. The wall limit is checked after terminal causes on the final tick.
 */
export function activeExit(state: { stopRequested: boolean; terminalFailure: boolean; peerUnreachable: boolean; settled: boolean; quietMs: number; wallExpired?: boolean }): string | undefined {
    if (state.stopRequested) return 'interrupted';
    if (state.terminalFailure) return 'peer-failure';
    if (state.peerUnreachable) return 'native-failure';
    if (state.settled && state.quietMs >= 1000) return 'completed';
    if (state.wallExpired) return 'wall-timeout';
    return undefined;
}

/** A new peer-failure submission must retain the same active-window tree as a completed one. */
export function activeTreeFlag(end: string, changed: boolean | null): string | undefined {
    if ((end === 'completed' || end === 'peer-failure') && changed !== false) return changed ? 'tree-changed-after-active-time' : 'tree-unverified-after-active-time';
    return undefined;
}

/**
 * The pinned Qwen 0.24.7 ACP turn error for a native tool-call loop-protection stop (#175): the session's
 * `session/prompt` request rejects with code -32603, this exact message and error data
 * `{ code: 'LOOP_DETECTED', errorKind: 'loop_detected', loopType? }` (pinned source: qwen-code v0.24.7
 * packages/cli/src/acp-integration/session/Session.ts, LOOP_DETECTED_TURN_ERROR_MESSAGE). The adapter's
 * failure callback surfaces the message only — the structured error data is not forwarded — so the exact
 * pinned message contract is the supported evidence. Any other text is an unknown native cause, and the
 * raw message is never copied into an export.
 */
export const QWEN_0_24_7_LOOP_PROTECTION_MESSAGE = 'Tool-call loop protection stopped this turn. The session is still available; send a more specific instruction to continue.';

/** The fixed terminal classes of a native active-window termination (#175, #179). Unknown native causes stay unknown. */
export const NATIVE_TERMINAL_CLASSES = ['tool-loop-protection', 'tool-step-ceiling', 'unknown'] as const;
export type NativeTerminalClass = (typeof NATIVE_TERMINAL_CLASSES)[number];

/** The evidence kinds a terminal class may stand on: Qwen's pinned message (#175) or Pi's validated extension signal (#179). */
export type NativeTerminalEvidence = 'pinned-message' | 'extension-signal' | 'none';

/**
 * Classify a peer's terminal turn failure. Qwen classifies by the pinned build's documented message
 * contract only: the raw reason is compared, never returned or stored, and the same words from another
 * peer are not evidence of a native loop-protection stop. Pi classifies ONLY by the validated extension
 * ceiling signal (#179): a schema-valid, session/turn-bound `tool-step-ceiling` record carried with the
 * failure, never its free text — a reason that merely resembles the ceiling stays unknown.
 */
export function classifyNativeTermination(peer: string, reason: string | undefined, ceiling?: PiToolStepCeiling): { class: NativeTerminalClass; evidence: NativeTerminalEvidence } {
    if (peer === 'qwen' && reason === QWEN_0_24_7_LOOP_PROTECTION_MESSAGE) return { class: 'tool-loop-protection', evidence: 'pinned-message' };
    if (peer === 'pi' && ceiling !== undefined) return { class: 'tool-step-ceiling', evidence: 'extension-signal' };
    return { class: 'unknown', evidence: 'none' };
}

/** The ACP protocol's fixed tool kinds (ToolKind in the schema): what an announced call may carry. */
export const ACP_TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;

/**
 * The canonical tool categories of the active-window summary (#175): the protocol kinds, `mcp` for an
 * announcement the #138 canonical binding resolves against the session's configured servers (bound identity
 * takes precedence over the mutable kind), and `unclassed` for everything else. Categories are never
 * re-derived from title text beyond the #138 binding, and titles are never exported.
 */
export const ACTIVE_TOOL_CATEGORIES = [...ACP_TOOL_KINDS, 'mcp', 'unclassed'] as const;
export type ActiveToolCategory = (typeof ACTIVE_TOOL_CATEGORIES)[number];

/**
 * The scalar counters of the active-window summary (#175). `updateEvents` counts every protocol tool event;
 * `distinctCallIds` the unique reported ids; neither is an execution count. `announcements` counts `tool_call`
 * starts (a reused id is a new call, as the adapter treats it); `settled` terminal updates bound to an
 * in-window announced call; `unsettled` calls open at freeze; `unresolved` terminal updates bound to no
 * in-window call (stale or foreign); `duplicateSettlements` repeated terminal updates for an already settled
 * call. The failure classes come from the #169 error-class predicate on the settled content; the repeat
 * counters are computed at freeze from the announcements' opaque repeat keys.
 */
export const ACTIVE_TRACE_COUNTERS = ['updateEvents', 'announcements', 'distinctCallIds', 'reusedIds', 'settled', 'unsettled', 'unresolved', 'duplicateSettlements', 'completed', 'failedPermission', 'failedNotFound', 'failedOther', 'failedUnparsed', 'repeatGroups', 'repeatedAnnouncements', 'maxRepeat'] as const;
export type ActiveTraceCounter = (typeof ACTIVE_TRACE_COUNTERS)[number];

/** The count-only active-window tool statistics (#175): fixed counter and category keys, nothing else. */
export interface ActiveWindowStats {
    counts: Record<ActiveTraceCounter, number>;
    categories: Record<ActiveToolCategory, number>;
}

const zeroCounts = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Retention bound for the per-window tracking maps; eviction follows the probe's oldest-first rule. */
const ACTIVE_TRACE_CAP = 4096;

/**
 * The count-only active-window ACP tool trace of one peer (#175), the active-phase analogue of the #169
 * setup probe window. Every counter is a non-negative integer; no title, argument, path, tool response or
 * error text is retained (the repeat key is a hash of the announced category and title, compared and counted,
 * never exported). The trace is fenced like the #160 latch: `begin` opens the active generation at
 * active_start, `freeze` closes it at active_end, and observations outside the active phase — the setup
 * probes, teardown, a stale cancelled turn — are dropped, so windows and peers never mix counters.
 */
export class ActiveToolTrace {
    private phase: 'inactive' | 'active' | 'ended' = 'inactive';
    private generation = 0;
    private session: string | undefined;
    private counts = zeroCounts(ACTIVE_TRACE_COUNTERS);
    private categories = zeroCounts(ACTIVE_TOOL_CATEGORIES);
    private readonly open = new Map<string, true>(); // announced in this window, not settled yet
    private readonly announcedIds = new Set<string>();
    private readonly settledIds = new Set<string>();
    private readonly seenIds = new Set<string>();
    private readonly repeatKeys = new Map<string, number>();

    constructor(private readonly peer: string, private readonly mcpServers: readonly string[] = []) {}

    /** Opens the next active window: a fresh generation binds afresh and inherits nothing. */
    begin(generation: number, sessionId?: string): void {
        this.counts = zeroCounts(ACTIVE_TRACE_COUNTERS);
        this.categories = zeroCounts(ACTIVE_TOOL_CATEGORIES);
        this.open.clear();
        this.announcedIds.clear();
        this.settledIds.clear();
        this.seenIds.clear();
        this.repeatKeys.clear();
        this.phase = 'active';
        this.generation = generation;
        this.session = sessionId;
    }

    /** Closes the window at active_end: calls still open are unsettled, and the repeat counters settle. */
    freeze(): void {
        if (this.phase !== 'active') return;
        this.phase = 'ended';
        this.counts.unsettled = this.open.size;
        this.open.clear();
        const groups = [...this.repeatKeys.values()].filter((n) => n >= 2);
        this.counts.repeatGroups = groups.length;
        this.counts.repeatedAnnouncements = groups.reduce((a, n) => a + n - 1, 0);
        this.counts.maxRepeat = groups.reduce((a, n) => Math.max(a, n), 0);
    }

    observe(value: unknown): void {
        if (this.phase !== 'active') return;
        if (!value || typeof value !== 'object') return;
        const u = value as { sessionUpdate?: unknown; toolCallId?: unknown; kind?: unknown; title?: unknown; status?: unknown; content?: unknown };
        if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return;
        if (typeof u.toolCallId !== 'string') return;
        const id = u.toolCallId;
        this.counts.updateEvents++;
        if (!this.seenIds.has(id)) this.counts.distinctCallIds++;
        this.seenIds.add(id);
        while (this.seenIds.size > ACTIVE_TRACE_CAP) this.seenIds.delete(this.seenIds.values().next().value!);
        if (u.sessionUpdate === 'tool_call') {
            this.counts.announcements++;
            // A reused id is a new call (the adapter's own semantics): it starts clean, and what the earlier
            // call settled cannot attach to it.
            if (this.announcedIds.has(id)) this.counts.reusedIds++;
            this.announcedIds.add(id);
            this.settledIds.delete(id);
            const category = this.categoryOf(u);
            this.categories[category]++;
            const key = sha(`${category}\n${typeof u.title === 'string' ? u.title : ''}`);
            this.repeatKeys.set(key, (this.repeatKeys.get(key) ?? 0) + 1);
            while (this.repeatKeys.size > ACTIVE_TRACE_CAP) this.repeatKeys.delete(this.repeatKeys.keys().next().value!);
            this.open.set(id, true);
            while (this.open.size > ACTIVE_TRACE_CAP) this.open.delete(this.open.keys().next().value!);
            return;
        }
        if (u.status !== 'completed' && u.status !== 'failed') return; // a progress update is an event, never a settlement
        if (this.settledIds.has(id)) {
            this.counts.duplicateSettlements++;
            return;
        }
        if (!this.open.has(id)) {
            this.counts.unresolved++; // settled without an in-window announcement: stale or foreign, never an execution
            return;
        }
        this.open.delete(id);
        this.settledIds.add(id);
        this.counts.settled++;
        if (u.status === 'completed') {
            this.counts.completed++;
            return;
        }
        const cls = probeErrorClass(u.content);
        if (cls === 'permission') this.counts.failedPermission++;
        else if (cls === 'not-found') this.counts.failedNotFound++;
        else if (cls === 'unparsed') this.counts.failedUnparsed++;
        else this.counts.failedOther++;
    }

    private categoryOf(u: { kind?: unknown; title?: unknown }): ActiveToolCategory {
        if (canonicalMcpToolName(typeof u.title === 'string' ? u.title : undefined, this.mcpServers)) return 'mcp';
        const kind = typeof u.kind === 'string' ? u.kind : '';
        return (ACP_TOOL_KINDS as readonly string[]).includes(kind) ? (kind as ActiveToolCategory) : 'unclassed';
    }

    /** A copy of the window counters: a snapshot binds to the window it was taken in. */
    stats(): ActiveWindowStats {
        return { counts: { ...this.counts }, categories: { ...this.categories } };
    }

    /** What the window is bound to: this peer, its session and the active generation. */
    get binding(): { peer: string; session?: string; generation: number } {
        return { peer: this.peer, ...(this.session !== undefined ? { session: this.session } : {}), generation: this.generation };
    }
}

/**
 * The repeated/no-op/denied patterns a diagnosis may report (#175), each only when its supported observations
 * establish it: `repeated-announcements` when one opaque repeat key was announced more than once in the window,
 * `denied-operations` when a settled call failed with the permission error class. No-op outcomes have no
 * supported protocol signal and are never reported.
 */
export const ACTIVE_LOOP_PATTERNS = ['repeated-announcements', 'denied-operations'] as const;
export type ActiveLoopPattern = (typeof ACTIVE_LOOP_PATTERNS)[number];

/**
 * One latched active-window termination, reduced to fixed enums and counts (#175). `observations` is the
 * evidence availability of the window stream: the pinned Qwen peer's ACP tool updates are observed
 * (`acp-tool-stream`); a peer without an observed protocol stream is explicit (`unavailable`), with no counts.
 * `capabilities` is the unsupported ceiling: the pinned build does not expose its native guard threshold, its
 * guard predicate or a no-op outcome signal over the ACP failure surface, so none is ever derived from event
 * totals.
 */
export interface ActiveLoopDiagnosis {
    peer: string;
    session?: string;
    generation: number;
    window: 'active';
    terminal: NativeTerminalClass;
    terminalEvidence: NativeTerminalEvidence;
    observations: 'acp-tool-stream' | 'unavailable';
    capabilities: { nativeGuardThreshold: 'unavailable'; nativeGuardPredicate: 'unavailable'; noopOutcomes: 'unavailable' };
    supportedPatterns: ActiveLoopPattern[];
    counts?: Record<ActiveTraceCounter, number>;
    categories?: Record<ActiveToolCategory, number>;
    /**
     * The validated Pi tool-step ceiling signal (#179), present only when the terminal class stands on
     * it. `unit` is the fixed counter unit; `count` is the producer's counter at the rejection, already
     * including the rejected pre-effect invocation (so always > limit); `limit` is the configured
     * ceiling; `turnGeneration` is the extension's native turn scope the adapter bound the signal to.
     * Counter/reset semantics are the producer contract in src/pi/ceiling.ts; counted calls are
     * execution attempts, never asserted successful effects.
     */
    ceiling?: { unit: 'tool-step'; count: number; limit: number; turnGeneration: number };
}

/**
 * Compose the bounded diagnosis of a latched terminal failure (#175) from the failure's original class and
 * the frozen count-only trace of the failed peer. It explains the latched failure and never changes it: the
 * latch, the end cause and the record's preserved failure class are exactly what #160 made them. The raw
 * failure text is read by the classifier and appears nowhere in the diagnosis.
 */
export function diagnoseActiveTermination(failure: PeerFailure, trace?: ActiveToolTrace, ceiling?: PiToolStepCeiling): ActiveLoopDiagnosis {
    const terminal = classifyNativeTermination(failure.peer, failure.failureClass, failure.peer === 'pi' ? ceiling : undefined);
    const stats = trace?.stats();
    const supportedPatterns: ActiveLoopPattern[] = [];
    if (stats) {
        if (stats.counts.repeatGroups > 0) supportedPatterns.push('repeated-announcements');
        if (stats.counts.failedPermission > 0) supportedPatterns.push('denied-operations');
    }
    const session = trace?.binding.session;
    return {
        peer: failure.peer,
        ...(session !== undefined ? { session } : {}),
        generation: failure.generation,
        window: 'active',
        terminal: terminal.class,
        terminalEvidence: terminal.evidence,
        observations: stats ? 'acp-tool-stream' : 'unavailable',
        capabilities: { nativeGuardThreshold: 'unavailable', nativeGuardPredicate: 'unavailable', noopOutcomes: 'unavailable' },
        supportedPatterns,
        ...(stats ? { counts: stats.counts, categories: stats.categories } : {}),
        ...(terminal.class === 'tool-step-ceiling' && ceiling ? { ceiling: { unit: 'tool-step', count: ceiling.count, limit: ceiling.limit, turnGeneration: ceiling.generation } } : {}),
    };
}

/**
 * The Pi ceiling signal store of one attempt (#179): keyed by the latch's active generation. A signal is
 * stored only by the callback that LATCHED the failure (`first`: the latch was unlatched before it and the
 * phase was active) and only for that peer — a later failure's signal, a setup/teardown-phase signal and a
 * signal arriving beside another peer's failure never attach, so the frozen active cause cannot be
 * overwritten.
 */
export function storeCeilingSignal(signals: Map<number, PiToolStepCeiling>, failure: PeerFailure | undefined, peer: string, ceiling: PiToolStepCeiling | undefined, first: boolean): void {
    if (!first || !ceiling || peer !== 'pi' || failure?.peer !== 'pi') return;
    signals.set(failure.generation, ceiling);
}

/** The signal bound to a latched failure: the same peer and the same active generation, else none (#179). */
export function boundCeilingSignal(failure: PeerFailure | undefined, signals: Map<number, PiToolStepCeiling>): PiToolStepCeiling | undefined {
    if (!failure || failure.peer !== 'pi') return undefined;
    return signals.get(failure.generation);
}

/**
 * The strict scalar allowlist serialization of an active-window termination diagnosis (#175), the #169 safe
 * view's shape applied here: every key is fixed, every string comes from a fixed enum (or the sanitized
 * session token), every count is coerced to a non-negative safe integer. A terminal class without its
 * evidence serializes as unknown: the loop-protection class needs the pinned message (#175), the
 * tool-step-ceiling class needs the extension-signal evidence and a re-validated count/limit/turn block
 * (#179). Whatever nested content the tool stream carried, it cannot inject keys or strings into this view.
 */
export function safeActiveLoopDiagnosis(d: ActiveLoopDiagnosis): Record<string, unknown> {
    const evidence: NativeTerminalEvidence = d.terminalEvidence === 'pinned-message' || d.terminalEvidence === 'extension-signal' ? d.terminalEvidence : 'none';
    // The ceiling class stands only with its evidence and a re-validated block: the fixed unit, finite
    // nonnegative safe-integer counts with count > limit and a nonnegative native turn generation.
    const c = d.ceiling as { unit?: unknown; count?: unknown; limit?: unknown; turnGeneration?: unknown } | undefined;
    const ceilingValid = !!c && c.unit === 'tool-step'
        && Number.isSafeInteger(c.count) && (c.count as number) >= 1
        && Number.isSafeInteger(c.limit) && (c.limit as number) >= 0
        && (c.count as number) > (c.limit as number)
        && Number.isSafeInteger(c.turnGeneration) && (c.turnGeneration as number) >= 0;
    const ceilingClass = d.terminal === 'tool-step-ceiling' && evidence === 'extension-signal' && ceilingValid;
    const pinnedClass = evidence === 'pinned-message' && (NATIVE_TERMINAL_CLASSES as readonly string[]).includes(d.terminal) && d.terminal !== 'tool-step-ceiling';
    const out: Record<string, unknown> = {
        peer: d.peer === 'pi' || d.peer === 'qwen' ? d.peer : 'unknown',
        window: 'active',
        generation: Number.isSafeInteger(d.generation) && d.generation >= 0 ? d.generation : 0,
        terminal: pinnedClass || ceilingClass ? d.terminal : 'unknown',
        terminalEvidence: evidence,
        observations: d.observations === 'acp-tool-stream' ? 'acp-tool-stream' : 'unavailable',
        capabilities: { nativeGuardThreshold: 'unavailable', nativeGuardPredicate: 'unavailable', noopOutcomes: 'unavailable' },
        supportedPatterns: (Array.isArray(d.supportedPatterns) ? d.supportedPatterns : []).filter((p): p is ActiveLoopPattern => (ACTIVE_LOOP_PATTERNS as readonly string[]).includes(p as string)),
    };
    if (ceilingClass) out.ceiling = { unit: 'tool-step', count: c!.count, limit: c!.limit, turnGeneration: c!.turnGeneration };
    const session = cleanSessionId(d.session);
    if (session !== undefined) out.session = session;
    if (out.observations === 'acp-tool-stream' && d.counts && d.categories) {
        const counts: Record<string, number> = {};
        for (const c of ACTIVE_TRACE_COUNTERS) {
            const n: unknown = (d.counts as Record<string, unknown>)[c];
            counts[c] = typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
        }
        const categories: Record<string, number> = {};
        for (const c of ACTIVE_TOOL_CATEGORIES) {
            const n: unknown = (d.categories as Record<string, unknown>)[c];
            categories[c] = typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
        }
        out.counts = counts;
        out.categories = categories;
    }
    return out;
}

/**
 * Request-linkage qualification over the relay's journaled records (#139). A request's served model comes only
 * from its own record. Every identified record is evidence, whatever its outcome: a request cancelled after its
 * header or a generation event identified the served model still flags a confirmed mismatch. Only
 * cancelled-before-identification is non-evidence — reported in the coverage, certifying nothing. A completed
 * request that was never identified (a heartbeat-only stream identifies nothing) fails the attempt.
 */
export function qualifyRequests(records: RelayRequestRecord[], expected: { backend: string; servedModel: string; provider?: string }): { verified: boolean; reasons: string[]; coverage: RequestLinkage } {
    const completed = records.filter((r) => r.outcome === 'completed');
    const coverage: RequestLinkage = {
        requests: records.length,
        completed: completed.length,
        identified: completed.filter((r) => r.identified).length,
        cancelledUnidentified: records.filter((r) => r.outcome === 'cancelled' && !r.identified).length,
        mismatches: records.filter((r) => r.mismatch === true).length,
        providerMissing: completed.filter((r) => r.identified && r.provider === undefined).length,
    };
    const reasons: string[] = [];
    if (!records.length) reasons.push('no upstream generation request was journaled');
    else if (!completed.length) reasons.push('no completed generation request; cancelled or failed requests identify nothing');
    for (const r of records) {
        if (!r.identified) {
            if (r.outcome === 'completed') reasons.push(`request ${r.id}: completed without served-model identity (a heartbeat-only stream identifies nothing)`);
            continue;
        }
        if (r.requestedModel !== expected.backend) reasons.push(`request ${r.id}: asked upstream for ${r.requestedModel ?? 'unknown'}, not the fixed backend`);
        if (r.mismatch) reasons.push(`request ${r.id}: served model differs from the upstream-configured model${r.outcome === 'cancelled' ? ' (cancelled after identification; the mismatch stands)' : ''}`);
        else if (r.actualModel !== expected.servedModel) reasons.push(`request ${r.id}: served ${r.actualModel ?? 'unknown'}, not ${expected.servedModel}`);
        if (r.provider !== undefined && expected.provider !== undefined && r.provider !== expected.provider) reasons.push(`request ${r.id}: provider differs from the pinned provider`);
    }
    return { verified: reasons.length === 0, reasons, coverage };
}

/**
 * The version a command reports under the environment it will actually run with (correction 1): the extra env
 * applied, and the seatbelt profile wrapped around it when one is given. Qwen's PATH bootstrap reported the
 * managed build in the normal home and fell back to the base build under QWEN_HOME isolation, so the check runs
 * inside the final isolation environment, never against the operator's PATH.
 */
export async function effectiveBuild(command: string[], opts: { cwd?: string; env?: Record<string, string>; sandboxProfile?: string; timeoutMs?: number } = {}): Promise<string> {
    const args = opts.sandboxProfile ? ['/usr/bin/sandbox-exec', '-f', opts.sandboxProfile, ...command] : command;
    const p = Bun.spawn(args, { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe', ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* already gone */ } }, opts.timeoutMs ?? 60_000);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).finally(() => clearTimeout(timer));
    if (code) throw new Error(`${command[0]} exit ${code}: ${stderr.slice(0, 300)}`);
    return stdout.trim();
}

/** The x.y.z a `--version` output reports, or undefined. */
export const parseVersion = (output: string) => /\d+\.\d+\.\d+/.exec(output)?.[0];

/** An exclusive claim (correction 6): written once or not at all; an existing file is evidence, never overwritten. */
export function claimExclusive(path: string, payload: string): void {
    writeFileSync(path, payload, { flag: 'wx', mode: 0o600 });
}

/**
 * The binary submission patch over exactly the guarded source layout, with new files bound in (correction 4):
 * `git add -N` marks intent-to-add so a source file the agents created appears in `git diff --binary`.
 */
export async function collectSubmissionPatch(cwd: string, base: string, sourceDirs: string[]): Promise<string> {
    await cmd(['git', 'add', '-N', '--', ...sourceDirs], cwd);
    return cmd(['git', 'diff', '--binary', base, '--', ...sourceDirs], cwd);
}

/**
 * Unconditional disposal (correction 5): every closer runs whatever the earlier ones did; the failures are
 * returned for the record, never thrown over the active-window evidence that was captured before disposal began.
 */
export async function disposeAll(closers: Iterable<() => Promise<void> | void>): Promise<string[]> {
    // Each closer is invoked through an async boundary so a synchronous throw cannot skip the rest.
    const settled = await Promise.allSettled([...closers].map(async (close) => close()));
    return settled.flatMap((s) => (s.status === 'rejected' ? [String(s.reason).slice(0, 200)] : []));
}

/** A run record is written fresh: existing attempt evidence is rejected, never overwritten (correction 6). */
export function writeRecordFresh(path: string, payload: string): void {
    if (existsSync(path)) throw new Error(`attempt evidence already exists; preserve it and prepare a new cohort: ${path}`);
    writeFileSync(path, payload, { mode: 0o600 });
}

async function cmd(args: string[], cwd?: string, timeoutMs = 180_000): Promise<string> {
    const p = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', detached: true });
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).finally(() => clearTimeout(timer));
    if (code) throw new Error(`${args[0]} exit ${code}: ${stderr.slice(0, 300)}`);
    return stdout;
}

/** Every regular file below root, hashed; a symlink or special file is refused. */
function tree(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
            if (ent.name === '.git') continue;
            const p = join(dir, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (ent.isFile()) out[relative(root, p)] = sha(readFileSync(p));
            else throw new Error('unexpected nonregular fixture entry');
        }
    };
    walk(root);
    return out;
}

const canonical = (o: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/** The pid of a peer's spawned process. The adapters keep it private; the driver records it once, with its start time. */
const procPid = (peer: unknown): number | undefined => (peer as { proc?: { pid?: number } }).proc?.pid;

/** The fixture metadata hash: the same five names runner.py's fixture_metadata_sha256 binds, byte-identical JSON. */
function fixtureMetadataHash(root: string): string {
    const names = ['AGENTS.md', '.gitignore', '.claude/settings.json', '.agenthub/config.json', '.agenthub/routing.toml'];
    const values: Record<string, string | null> = {};
    for (const name of names) values[name] = existsSync(join(root, name)) ? sourceHash(join(root, name)) : null;
    return sha(JSON.stringify(values));
}

async function main(): Promise<number> {
    process.umask(0o077);
    const argv = process.argv.slice(2);
    const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const runArg = arg('--run'), inputArg = arg('--private-inputs'), upstreamArg = arg('--upstream-root'), probeArg = arg('--probe-target'), qwenPackageArg = arg('--qwen-package');
    if (!runArg || !inputArg || !upstreamArg || !probeArg || !qwenPackageArg)
        throw new Error('usage: bun scripts/benchmarks/native-pi-qwen.ts --run RUN_DIR --private-inputs PRIVATE_DIR --upstream-root COOPERBENCH_ROOT --probe-target HIDDEN_FILE --qwen-package QWEN_PACKAGE_DIR [--cases 0,1] [--repeat n] [--setup-only] [--protect PATH ...]');
    // macOS only: seatbelt, and start times the teardown proves processes by (#115).
    if (process.platform !== 'darwin') throw new Error(`the native benchmark runner runs on macOS only, not ${process.platform}`);
    const repo = resolve(import.meta.dir, '../..');
    const runs = realPath(runArg);
    const readIfThere = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
    const refuseReuse = () => {
        const reuse = reuseProblem(readIfThere(join(runs, 'restoration.json')), readIfThere(join(runs, 'restoration-ledger.json')));
        if (reuse) throw new Error(`${reuse}: run bun scripts/benchmarks/restore.ts --run ${runs} first`);
    };
    refuseReuse(); // first, before anything is read: locked modes would become the originals (#120)
    const privateInputs = realPath(inputArg), upstreamRoot = realPath(upstreamArg), qwenPackage = realPath(qwenPackageArg);
    if (runs === repo || runs.startsWith(repo + '/') || repo.startsWith(runs + '/')) throw new Error('private run root must be outside the repository');
    if (!existsSync(join(runs, 'prepared.json'))) throw new Error('prepared run missing');
    const m = JSON.parse(readFileSync(join(runs, 'manifest.json'), 'utf8')), prepared = JSON.parse(readFileSync(join(runs, 'prepared.json'), 'utf8'));
    requireToolStudyCondition(m.study_condition);
    if ((lstatSync(runs).mode & 0o777) !== 0o700) throw new Error('run directory must have mode 0700');
    const selfPath = join(import.meta.dir, 'native-pi-qwen.ts');
    const pins: Record<string, string> = prepared.source_pins ?? {};
    const pinProblem = () => {
        if (prepared.runner_sha256 !== sourceHash(join(import.meta.dir, 'runner.py')) || prepared.pi_qwen_runner_sha256 !== sourceHash(selfPath) || prepared.peer_bus_sha256 !== sourceHash(join(import.meta.dir, 'peer-bus-mcp.py')) || prepared.teardown_sha256 !== sourceHash(join(import.meta.dir, 'teardown.ts')) || prepared.process_table_sha256 !== sourceHash(join(import.meta.dir, '../../src/hub/child-process.ts')) || prepared.evaluator_sha256 !== sourceHash(join(import.meta.dir, 'evaluate.py'))) return 'benchmark runner changed after preparation';
        for (const [path, digest] of Object.entries(pins)) if (sourceHash(join(repo, path)) !== digest) return `candidate source pin changed: ${path}`;
        return undefined;
    };
    {
        const problem = pinProblem();
        if (problem) throw new Error(problem);
    }
    const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    if (packageJson.version !== m.hub_version || m.versions?.hub !== packageJson.version) throw new Error('hub version differs from the pinned manifest');
    const config = loadConfig(repo);
    const omni = new OmniRoute(config.omniroute);
    if (!QWEN_SURFACE_ATTESTATION) throw new Error('expected Qwen surface attestation unavailable');
    verifySurfaceSource(qwenPackage, QWEN_SURFACE_ATTESTATION);
    const qwenCommand = [realPath(Bun.which('node') ?? (() => { throw new Error('node is unavailable'); })()), '--expose-gc', join(qwenPackage, 'cli.js')];
    const piCommand: string[] = config.pi.cmd;
    const peerBus = realPath(join(import.meta.dir, 'peer-bus-mcp.py'));
    const python = realPath(Bun.which('python3') ?? (() => { throw new Error('python3 is unavailable'); })());
    if ((await cmd(['git', '-C', upstreamRoot, 'rev-parse', 'HEAD'])).trim() !== m.upstream.commit) throw new Error('pinned CooperBench checkout differs from the manifest');

    const repeat = arg('--repeat') !== undefined ? Number(arg('--repeat')) : 0;
    if (!Number.isInteger(repeat) || repeat < 0) throw new Error('--repeat takes a whole number (0 for the first repeat)');
    const selected = arg('--cases') ? arg('--cases')!.split(',').map(Number) : m.cases.map((_: unknown, i: number) => i);
    if (!selected.length || new Set(selected).size !== selected.length || selected.some((i: number) => !Number.isInteger(i) || i < 0 || i >= m.cases.length)) throw new Error('invalid case selection');
    const setupOnly = argv.includes('--setup-only');

    // Executable lifecycle preflight (correction 7): every binary the cohort can spawn answers a trivial command
    // before any fixture is touched, so a broken toolchain fails the run before setup, not mid-attempt.
    await cmd(['git', '--version']);
    if (m.arms.some((a: string) => a !== 'solo-qwen')) {
        const v = parseVersion(await effectiveBuild([...piCommand, '--version'], { cwd: repo }));
        if (v !== m.versions.pi) throw new Error(`effective Pi build ${v ?? 'unknown'} differs from the pinned ${m.versions.pi}`);
    }
    if (m.arms.some((a: string) => a !== 'solo-pi')) {
        await cmd(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true']);
        // Exercise the Qwen CLI itself (review #146), with an isolated home as the sessions get it: a missing or
        // wrong-version package fails here, before any fixture or attempt directory is touched. The per-arm check
        // then re-verifies the same build inside the seatbelt profile (correction 1).
        const preflightHome = mkdtempSync(join(tmpdir(), 'ahub-v3-qwen-preflight-'));
        try {
            const qv = await effectiveBuild([...qwenCommand, '--version'], { cwd: repo, env: { QWEN_HOME: preflightHome, QWEN_RUNTIME_DIR: preflightHome, TMPDIR: preflightHome } });
            if (parseVersion(qv) !== m.versions.qwen) throw new Error(`effective Qwen build ${parseVersion(qv) ?? qv.slice(0, 80)} differs from the pinned ${m.versions.qwen}`);
        } finally {
            rmSync(preflightHome, { recursive: true, force: true });
        }
    }
    if (m.arms.includes('joint-pi-qwen')) await cmd([python, '-c', 'pass']);

    const probeTarget = realPath(probeArg);
    const protectedRoots = [privateInputs, upstreamRoot];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--protect' && argv[i + 1]) protectedRoots.push(realPath(argv[i + 1]!));
    if (!protectedRoots.slice(2).length) throw new Error('pass --protect for every prior artifact/session file');
    if (!existsSync(probeTarget) || !protectedRoots.some((root) => probeTarget === root || probeTarget.startsWith(root + '/'))) throw new Error('sandbox probe target must be inside an exact protected root');
    const probeTargetSha = sha(await Bun.file(probeTarget).bytes());

    const cachedInputs = m.cases.map((_: unknown, i: number) => JSON.parse(readFileSync(join(privateInputs, `case-${i.toString().padStart(2, '0')}.json`), 'utf8')));
    const privateCaseHashes: Record<number, string> = {};
    for (let i = 0; i < cachedInputs.length; i++) {
        const input = cachedInputs[i], expected = m.cases[i];
        for (let k = 0; k < 2; k++) if (sha(input.prompts[k]) !== expected.prompt_sha256[k]) throw new Error('private prompt hash mismatch');
        if (input.repo !== expected.repo || input.task !== expected.task || JSON.stringify(input.features) !== JSON.stringify(expected.features)) throw new Error('private case identity differs from the selected manifest pair');
        privateCaseHashes[i] = sourceHash(join(privateInputs, `case-${i.toString().padStart(2, '0')}.json`));
    }

    // Every selected fixture root proved to be the directory preparation left, before anything is written or
    // launched (#119); each arm checks its own again right before it touches the fixture.
    const fixtureDir = (i: number, kind: string) => join(runs, 'fixtures', `${i.toString().padStart(2, '0')}-${kind}`);
    for (const i of selected) for (const kind of m.arms) {
        const dir = fixtureDir(i, kind), problem = fixtureRootProblem(dir);
        if (problem) throw new Error(`prepared fixture root was replaced after preparation (${problem}): ${dir}`);
        if (realPath(dir) !== dir) throw new Error(`prepared fixture root was replaced after preparation (its real path is not its prepared path): ${dir}`);
    }
    if ((existsSync(join(runs, 'runs')) && readdirSync(join(runs, 'runs')).length) || existsSync(join(runs, 'recovery')) || existsSync(join(runs, 'attempts'))) throw new Error('run directory already contains attempts; use a new attempt directory');

    const runnerIdentity = processTable()?.find((r) => r.pid === process.pid);
    if (!runnerIdentity) throw new Error('the process table cannot be read: the runner cannot record what it starts');
    const actorLedger = new Map<string, Actor[]>();
    const persistLedger = () => writeAtomic(join(runs, 'restoration-ledger.json'), JSON.stringify({ runner: { pid: runnerIdentity.pid, started: runnerIdentity.started }, protected: { paths: {}, restored: true }, siblings: {}, actors: Object.fromEntries(actorLedger), trust: undefined }, null, 2));
    refuseReuse(); // again right before the marker (#120)
    writeAtomic(join(runs, 'restoration.json'), JSON.stringify({ restored: false, reason: 'the runner is running, or died before writing its outcome', runner: { pid: runnerIdentity.pid, started: runnerIdentity.started }, recover: `bun scripts/benchmarks/restore.ts --run ${runs}` }));
    let stopRequested = false;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { stopRequested = true; });
    let containmentUncertain = false;
    const setupClosers = new Set<() => Promise<void> | void>();
    const summaries: unknown[] = [];
    let processed = 0;
    const plannedCells: { caseIndex: number; arm: string }[] = [];
    for (const i of selected) for (const kind of v3ArmOrder(m.arms, i, repeat, m.cases.length)) plannedCells.push({ caseIndex: i, arm: kind });

    async function arm(index: number, kind: string): Promise<void> {
        const problem = pinProblem();
        if (problem) throw new Error(problem);
        const cas = m.cases[index], name = `${index.toString().padStart(2, '0')}-${kind}`, dir = fixtureDir(index, kind);
        const sourceDirs: string[] = cas.source_dirs;
        const preparedFixture = prepared.fixtures.find((x: { case: number; arm: string }) => x.case === index && x.arm === kind);
        if (!preparedFixture || resolve(preparedFixture.cwd) !== resolve(dir)) throw new Error('fixture baseline identity mismatch');
        const identity: FixtureRootIdentity = captureFixtureRoot(dir);
        if (realPath(dir) !== dir) throw new Error(`prepared fixture root was replaced after preparation (its real path is not its prepared path): ${dir}`);
        // Correction 6: existing attempt evidence rejects the arm before anything is written.
        const attemptDir = join(runs, 'attempts', name);
        if (existsSync(attemptDir)) throw new Error('attempt directory exists; never reuse an attempted fixture');
        mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
        claimExclusive(join(attemptDir, 'started.json'), JSON.stringify({ runnerPid: process.pid, at: new Date().toISOString(), sourceSHA256: sourceHash(selfPath), attemptId: name }));
        const base = (await cmd(['git', 'rev-parse', 'HEAD'], dir)).trim();
        const initial = tree(dir);
        if (base !== preparedFixture.base_commit || sha(canonical(initial)) !== preparedFixture.baseline_sha256 || Object.keys(initial).length !== preparedFixture.baseline_paths) throw new Error('fixture baseline changed after preparation');
        const metadataBaseline = fixtureMetadataHash(dir);
        const builds: Record<string, { version: string; binary: string }> = {};
        const events: unknown[] = [];
        const answers: Record<string, string[]> = { pi: [], qwen: [] };
        const nativeTools: unknown[] = [];
        const deniedNative = new Set<string>();
        const qwenReadProbe = new ProtectedReadProbe(probeTarget);
        // Per-peer observed probe outcomes (issue #150): the readiness record reports only these.
        const probeResults = new Map<string, ProbeOutcome>();
        // Per-peer bounded probe diagnoses (issue #169): why the evidence predicate was not satisfied. They
        // explain probeResults, never change them; Pi's window counters are filled by its executeTool wrapper.
        const probeDiagnoses = new Map<string, ProbeDiagnosis>();
        const piProbeStats = emptyProbeWindowStats();
        let kernelProbeDenied = false;
        const owners = new Map<string, Actor>();
        const qwenUsageDiagnostics: unknown[] = [];
        const tokens: { pi: number; qwen: number | null } = { pi: 0, qwen: null };
        let active = false, deadline: number | undefined, relayToken = '';
        const captureNow = () => {
            const table = processTable();
            if (!table) return;
            extend(owners, table);
            actorLedger.set(dir, [...owners.values()]);
            persistLedger();
        };
        const log = (event: string, data: Record<string, unknown> = {}) => {
            const row = { at: new Date().toISOString(), event, ...data };
            events.push(row);
            writeAtomic(join(attemptDir, 'events.json'), JSON.stringify(events, null, 2));
            console.log(JSON.stringify({ attemptId: name, caseIndex: index, repeat, arm: kind, ...row }));
        };
        const clean = (text: string) => (relayToken ? text.replaceAll(relayToken, '[redacted]') : text);
        const peers: (PiPeer | AcpPeer)[] = [];
        let relay: Awaited<ReturnType<typeof startModelRelay>> | undefined;
        let endDetail = 'infrastructure-error', error: string | undefined, elapsedMs = 0, started = 0;
        // The attempt's terminal peer-failure latch (#160): armed at active_start, frozen at active_end.
        const failureLatch = new ActiveFailureLatch();
        // #175: the per-peer count-only active-window tool traces. Only Qwen has an observed protocol tool
        // stream (the stdout tap below); a peer without one is diagnosed with observations unavailable.
        const activeTraces = new Map<string, ActiveToolTrace>();
        // Both natives report terminal turn failure through the same latch (#160, review): a failure during the
        // active phase latches and ends the attempt; the same callback before active_start (the setup probes,
        // where an expected denied tool read is a tool error, never a turn failure) or after the frozen
        // active_end (stop/watchdog during teardown) is an event only, never the end cause.
        // #179: a Pi failure may carry the extension's validated tool-step ceiling signal. It is stored only
        // beside the failure this callback latched — never beside another peer's, a later failure's or a
        // setup/teardown event — keyed by the latch's active generation.
        const piCeilingSignals = new Map<number, PiToolStepCeiling>();
        const noteTurnFailure = async (peer: string, reason: string, ceiling?: PiToolStepCeiling) => {
            const unlatched = failureLatch.failure === undefined;
            const noted = failureLatch.note(peer, clean(reason), Date.now());
            storeCeilingSignal(piCeilingSignals, failureLatch.failure, peer, ceiling, unlatched && noted.phase === 'active');
            log('failure', { peer, reason: clean(reason), ...(noted.latched ? { terminal: true } : { phase: noted.phase }) });
        };
        let activeTree: Record<string, string> | undefined, finalTree: Record<string, string> | undefined;
        let surfaceRecord: Record<string, unknown> | undefined;
        let probeIdentity: { servedModel?: string; provider?: string } = {};
        const setup = Date.now();
        try {
            // The fixed backend's identity, probed fresh each attempt before any generation request.
            const identityProbe = await omni.chat({ model: m.fixed_backend, messages: [{ role: 'user', content: 'Reply only PIN_OK' }], max_tokens: 20 }, { signal: AbortSignal.timeout(30_000) });
            if (identityProbe.servedModel !== m.expected_served_model || identityProbe.provider !== m.expected_provider) throw new Error('fixed model/provider identity not verified');
            probeIdentity = { servedModel: identityProbe.servedModel, provider: identityProbe.provider };
            log('physical_model_probe', { requested: m.fixed_backend, served: identityProbe.servedModel, provider: identityProbe.provider, replyPresent: !!identityProbe.message.content?.trim() });

            relay = await startModelRelay({
                observeRequestMetadata: true,
                observeToolSurface: true,
                omni,
                allowedDGXmodels: { 'dgx/coding': m.fixed_backend },
                expectedServedModels: { 'dgx/coding': m.expected_served_model },
                admitRequest: async () => {
                    if (stopRequested) return { allowed: false, reason: 'study interrupted' };
                    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
                    if (remainingMs !== undefined && remainingMs <= 0) return { allowed: false, reason: 'active wall limit reached' };
                    return { allowed: true, ...(remainingMs === undefined ? {} : { remainingMs }) };
                },
            });
            relayToken = relay.token;
            setupClosers.add(async () => { await relay?.close(); });
            const bus = new Bus({ batchMs: 0 });
            const toolToken = randomUUID();
            const toolServer = Bun.serve({
                hostname: '127.0.0.1', port: 0,
                async fetch(req) {
                    if (req.headers.has('origin') || req.headers.get('authorization') !== 'Bearer ' + toolToken) return new Response('denied', { status: 403 });
                    const a = (await req.json()) as { text?: unknown };
                    if (kind !== 'joint-pi-qwen' || !active) return new Response('unavailable', { status: 403 });
                    bus.publish(newEnvelope('qwen', String(a.text).slice(0, 4000), { to: ['pi'] }));
                    log('peer_message', { from: 'qwen', to: 'pi', chars: String(a.text).length });
                    return new Response('ok');
                },
            });
            setupClosers.add(() => { toolServer.stop(true); });
            const relayPort = new URL(relay.url).port;

            const hasQwen = kind !== 'solo-pi', hasPi = kind !== 'solo-qwen';
            let sb: string | undefined;
            if (hasQwen) {
                const sandbox = profile(dir, false, [], []);
                const qhome = join(attemptDir, 'qwen-home');
                mkdirSync(qhome, { mode: 0o700 });
                const temp = join(attemptDir, 'qwen-temp');
                mkdirSync(temp, { mode: 0o700 });
                const qprofile = sandbox + `\n(allow file-read* (subpath ${sbplString(qwenPackage)}))\n(allow file-read* file-write* (subpath ${sbplString(qhome)}) (subpath ${sbplString(temp)}))\n(allow file-read* (literal ${sbplString(peerBus)}))\n(allow network-outbound (remote ip ${sbplString('localhost:' + relayPort)}) (remote ip ${sbplString('localhost:' + String(toolServer.port))}))\n(deny file-write* (subpath ${sbplString(dir)}))\n(allow file-write* ${sourceDirs.map((d) => '(subpath ' + sbplString(join(dir, d)) + ')').join(' ')})\n(deny file-write* (subpath ${sbplString(join(dir, 'tests'))}) (subpath ${sbplString(join(dir, '.git'))}) (literal ${sbplString(join(dir, 'AGENTS.md'))}))`;
                sb = join(attemptDir, 'qwen.sb');
                writeFileSync(sb, qprofile, { mode: 0o600 });
                // Correction 1: the effective build under the final isolation environment (seatbelt profile,
                // QWEN_HOME and TMPDIR as the session gets them), never the PATH bootstrap's report.
                const qv = await effectiveBuild([...qwenCommand, '--version'], { cwd: dir, env: { QWEN_HOME: qhome, QWEN_RUNTIME_DIR: qhome, TMPDIR: temp }, sandboxProfile: sb });
                if (parseVersion(qv) !== m.versions.qwen) throw new Error(`effective Qwen build ${parseVersion(qv) ?? qv.slice(0, 80)} differs from the pinned ${m.versions.qwen}`);
                builds.qwen = { version: m.versions.qwen, binary: join(qwenPackage, 'cli.js') };
                log('native_version', { peer: 'qwen', ...builds.qwen });
                // The kernel denies the protected read under this profile before any agent runs.
                const check = Bun.spawnSync(['/usr/bin/sandbox-exec', '-f', sb, '/bin/sh', '-c', 'head -c 1 "$1" >/dev/null 2>&1; test "$?" -ne 0', 'probe', probeTarget], { cwd: dir });
                if (check.exitCode) throw new Error('kernel protected-file denial failed');
                kernelProbeDenied = true;
                log('kernel_probe', { denied: true });
            }
            if (hasPi) {
                const pv = parseVersion(await effectiveBuild([...piCommand, '--version'], { cwd: dir }));
                if (pv !== m.versions.pi) throw new Error(`effective Pi build ${pv ?? 'unknown'} differs from the pinned ${m.versions.pi}`);
                builds.pi = { version: m.versions.pi, binary: piCommand.join(' ') };
                log('native_version', { peer: 'pi', ...builds.pi });
            }

            const excluded = ['exec', 'run_shell_command', 'agent', 'skill', 'save_memory', 'web_fetch', 'web_search', 'image_gen', 'lsp', 'cron_create', 'cron_list', 'cron_delete', 'loop_wakeup', 'create_sub_session', 'list_agents', 'task_stop', 'task_create', 'task_update', 'task_list', 'team_create', 'team_delete', 'team_plan_approval', 'request_shutdown', 'send_message', 'monitor', 'notebook_edit', 'read_mcp_resource', 'enter_worktree', 'exit_worktree', 'workflow', 'artifact', 'record_artifact', 'record_source', 'report_findings', 'get_goal', 'update_goal', 'propose_goal'];
            if (hasPi) {
                const sandbox = profile(dir, false, [], []);
                const pi = new PiPeer('pi', {
                    cwd: dir, stateDir: join(attemptDir, 'pi-state'), mode: 'headless', backend: 'dgx', model: 'dgx/coding', cmd: piCommand,
                    relay: { url: relay.url, token: relay.token, models: relay.models.map((id) => ({ id, contextWindow: 262144, maxTokens: 4096 })) },
                    // #182: benchmark-specific descriptors generated from the executor policy below, never the
                    // general production TOOL_SCHEMAS (which advertise capabilities this wrapper refuses).
                    tools: benchPiToolDescriptors({ sourceDirs, joint: kind === 'joint-pi-qwen' }),
                    maxSteps: 100, watchdogMs: 300_000,
                    onTokens: (n) => { tokens.pi += n; },
                    onTurnFailure: (_e, reason, ceiling) => noteTurnFailure('pi', reason, ceiling),
                    executeTool: async (name, raw, _id, _sid, signal) => {
                        const a = raw as Record<string, unknown>;
                        let target = '';
                        if (stopRequested || (deadline !== undefined && Date.now() >= deadline)) return 'error: attempt stopped before tool execution';
                        // #169: count-only setup probe window trace. The pre-active window is exactly the setup
                        // probes (the only pre-active tool turns); these counters change no predicate — the
                        // protected target read still needs the guard denial in the catch below (#150).
                        const setupWindow = !active;
                        if (setupWindow) {
                            piProbeStats.toolEventsSeen++;
                            if (name === 'read') {
                                piProbeStats.readsAttempted++;
                                if (typeof a.path === 'string' && resolve(dir, a.path) === probeTarget) piProbeStats.targetReads++;
                            }
                        }
                        try {
                            // #182: the argument-level policy the published descriptors are generated from.
                            // Read never refuses here, so the probe's guard-denial evidence path below is
                            // unchanged; execution-time guardPath and the post-resolution scope re-check stand.
                            const refusal = benchPiToolProblem(name, a, { cwd: dir, sourceDirs, joint: kind === 'joint-pi-qwen', active });
                            if (refusal) return `error: ${refusal}`;
                            if (['read', 'write', 'edit'].includes(name)) {
                                const p = guardPath({ cwd: dir, deny: [] }, String(a.path), name === 'read' ? 'read' : 'write');
                                target = relative(dir, p);
                                if (name !== 'read' && !isSourcePath(sourceDirs, target)) return 'error: source edits only under ' + sourceDirs.join(', ') + '/';
                            }
                            if (name === 'hub_send') {
                                bus.publish(newEnvelope('pi', String(a.text).slice(0, 4000), { to: ['qwen'] }));
                                log('peer_message', { from: 'pi', to: 'qwen' });
                                return 'sent';
                            }
                            const result = await runTool(name, JSON.stringify(a), { cwd: dir, deny: [], sandboxProfile: sandbox, signal, permit: async () => true, send: () => '' });
                            if (setupWindow && name === 'read' && !(typeof a.path === 'string' && resolve(dir, a.path) === probeTarget)) piProbeStats.wrongTargetReads++;
                            log('pi_tool', { name, path: target, ok: !result.startsWith('error:') });
                            return result;
                        } catch {
                            // Correction 2: a native read attempt on the protected file, denied by the guard, is the
                            // structured evidence; the model's marker alone never proves the probe.
                            if (name === 'read' && typeof a.path === 'string' && resolve(dir, a.path) === probeTarget) {
                                deniedNative.add('pi');
                                if (setupWindow) { piProbeStats.settledTargetReads++; piProbeStats.permissionDenials++; }
                                log('native_read_denied', { peer: 'pi', guard: 'guardPath' });
                            } else if (setupWindow && name === 'read') piProbeStats.wrongTargetReads++;
                            return 'error: outside benchmark scope';
                        }
                    },
                });
                peers.push(pi);
            }
            if (hasQwen) {
                const qhome = join(attemptDir, 'qwen-home'), temp = join(attemptDir, 'qwen-temp');
                const qwen = new AcpPeer('qwen', {
                    cwd: dir,
                    cmd: ['/usr/bin/sandbox-exec', '-f', sb!, ...qwenCommand, '--acp', '--bare', '--advisor', 'off', '--auth-type', 'openai', '--model', 'dgx/coding', '--openai-base-url', relay.url, '--approval-mode', 'auto-edit', '--telemetry=false', '--exclude-tools', ...excluded],
                    env: { OPENAI_API_KEY: relay.token, OMNIROUTE_API_KEY: relay.token, QWEN_HOME: qhome, QWEN_RUNTIME_DIR: qhome, TMPDIR: temp },
                    launchModel: 'dgx/coding',
                    preamble: kind === 'joint-pi-qwen' ? 'For implementation contracts to Pi use the exact MCP tool mcp__pilot-peer-bus__hub_send. The unprefixed hub_send tool is not registered in Qwen.' : undefined,
                    watchdogMs: 300_000,
                    mcpServers: kind === 'joint-pi-qwen' ? [{ name: 'pilot-peer-bus', command: python, args: [peerBus], env: [{ name: 'AGENTHUB_PILOT_TOOL_URL', value: `http://127.0.0.1:${toolServer.port}` }, { name: 'AGENTHUB_PILOT_TOOL_TOKEN', value: toolToken }] }] : [],
                    // #138: the adapter resolves the announced `hub_send (pilot-peer-bus MCP Server)` title to the
                    // canonical name itself; the whitelist is the exact canonical name and nothing else.
                    autoApprove: (title) => title === 'mcp__pilot-peer-bus__hub_send',
                    onTokens: (n) => { tokens.qwen = n; },
                    onTurnFailure: (_e, reason) => noteTurnFailure('qwen', reason),
                    onUsageDiagnostic: (reading) => { if (qwenUsageDiagnostics.length < 32) qwenUsageDiagnostics.push(reading); },
                    log: (s) => log('qwen_log', { text: clean(s).slice(0, 500) }),
                    onPermission: async (req) => {
                        const match = /\{.*\}/s.exec(req.title);
                        let a: Record<string, unknown> | undefined;
                        try { a = match ? (JSON.parse(match[0]) as Record<string, unknown>) : undefined; } catch { a = undefined; }
                        let allow = !!(a && typeof a.text === 'string' && Object.keys(a).every((k) => k === 'text') && a.text.length <= 4000 && kind === 'joint-pi-qwen' && active);
                        try {
                            if (a && !req.title.includes('[cut,') && !('command' in a) && typeof a.file_path === 'string') {
                                const p = guardPath({ cwd: dir, deny: [] }, a.file_path, 'write');
                                allow = isSourcePath(sourceDirs, relative(dir, p)) && ((typeof a.old_string === 'string' && typeof a.new_string === 'string') || typeof a.content === 'string');
                            }
                        } catch { allow = false; }
                        const option = allow ? req.options.find((o) => o.kind === 'allow_once')?.optionId : undefined;
                        log('qwen_permission', { tool: req.tool, title: clean(req.title).slice(0, 900), approved: !!option });
                        return option;
                    },
                });
                peers.push(qwen);
                // #175: the active-window trace binds the #138 canonical binding to this session's configured
                // MCP servers (the joint arm's peer bus), never a title re-derivation.
                activeTraces.set('qwen', new ActiveToolTrace('qwen', kind === 'joint-pi-qwen' ? ['pilot-peer-bus'] : []));
            }
            for (const p of peers) bus.add(p);
            bus.tap((e: BusEvent) => {
                if (e.t === 'state') log('state', { peer: e.peer, state: e.state });
                if (e.t === 'envelope' && ['pi', 'qwen'].includes(e.env.from)) {
                    answers[e.env.from as 'pi' | 'qwen']!.push(e.env.body);
                    log('answer', { peer: e.env.from, text: clean(e.env.body), dropped: e.dropped });
                }
            });
            for (const peer of peers) {
                withFixtureRoot(dir, identity, () => {});
                // Both adapters assign their spawned child synchronously inside start(), before the handshake's
                // first await. Register it before awaiting startup: a kill while the handshake is in flight must
                // still find the actor in the ledger, or recovery marks the run restored with the native process
                // left running (review #146). Signals only ever go to identities read from the table.
                const startPromise = peer.start();
                let startSettled = false;
                void startPromise.then(() => { startSettled = true; }, () => { startSettled = true; });
                let row;
                const registerEnd = Date.now() + 10_000;
                while (!row && !startSettled && Date.now() < registerEnd) {
                    const pid = procPid(peer);
                    if (pid !== undefined) {
                        const table = processTable();
                        row = table?.find((r) => r.pid === pid);
                    }
                    if (!row) await Bun.sleep(25);
                }
                if (row) {
                    owners.set(`${row.pid}@${row.started}`, { role: 'native-peer', pid: row.pid, started: row.started, pgid: row.pgid, via: `the ${peer.id} process this arm launched` });
                    actorLedger.set(dir, [...owners.values()]);
                    persistLedger();
                }
                await startPromise; // a handshake failure rethrows here, with the child already in the ledger
                if (!row) throw new Error(`could not prove which process is this arm's ${peer.id}`);
                captureNow();
                if (peer.id === 'qwen') {
                    let buffer = '';
                    const proc = (peer as unknown as { proc?: { stdout?: NodeJS.EventEmitter } }).proc;
                    proc?.stdout?.on('data', (b: unknown) => {
                        buffer += String(b);
                        while (buffer.includes('\n')) {
                            const i = buffer.indexOf('\n'), line = buffer.slice(0, i);
                            buffer = buffer.slice(i + 1);
                            try {
                                const msg = JSON.parse(line), u = msg.params?.update;
                                if (u?.sessionUpdate?.startsWith('tool_call')) {
                                    nativeTools.push(u);
                                    // Correction 2: a failed native read of the protected file, EPERM/EACCES from
                                    // the kernel, bound to the same call's announcement and exact input path.
                                    qwenReadProbe.observe(u);
                                    // #175: the active-window trace counts only between its begin and freeze;
                                    // setup probe and teardown events are phase-gated out here.
                                    activeTraces.get('qwen')?.observe(u);
                                    log('qwen_tool', { kind: u.kind, title: clean(String(u.title ?? '')).slice(0, 350), status: u.status, toolCallId: u.toolCallId });
                                }
                            } catch { /* not protocol output */ }
                        }
                    });
                }
                // Setup-only protected-file probe (correction 2): a native read attempt with structured denial
                // evidence. A model-written AHUB_PROBE_DENIED without that evidence never passes.
                const count = answers[peer.id]!.length;
                bus.publish(newEnvelope('user', `Setup-only protected-file probe: attempt to read ${probeTarget} with your native read tool. The file must be inaccessible. Do not infer or implement anything. Final answer exactly [FYI] AHUB_PROBE_DENIED if denied, else [FYI] AHUB_PROBE_ACCESSIBLE.`, { to: [peer.id] }));
                const deniedRead = () => {
                    if (peer.id === 'pi') return deniedNative.has('pi');
                    return qwenReadProbe.denied;
                };
                const settledProbe = () => peer.state === 'idle' && (answers[peer.id]!.length > count || (peer.id === 'qwen' && deniedRead()));
                const probeStart = Date.now();
                while (Date.now() - probeStart < 60_000 && !settledProbe()) {
                    if (peer.state === 'offline' || peer.state === 'paused') break; // recorded by evaluateProbe; the arm still fails below
                    await Bun.sleep(100);
                }
                const probeObservation = { denial: peer.id === 'pi' ? deniedNative.has('pi') : qwenReadProbe.denied, answers: answers[peer.id]!.slice(count), settled: settledProbe(), state: peer.state };
                const outcome = evaluateProbe(peer.id, probeObservation);
                probeResults.set(peer.id, outcome);
                // #169: the bounded diagnosis of WHY the evidence predicate was not satisfied. The stats snapshot
                // binds it to this setup probe window (Pi's counters count only pre-active tool calls; Qwen's are
                // snapshotted here, before the active phase can add to them). It explains the outcome and never
                // changes it: the arm still fails below on anything but an observed structured denial.
                const diagnosis = diagnoseProbe(peer.id, {
                    ...probeObservation,
                    deadlineExpired: !probeObservation.settled && peer.state !== 'offline' && peer.state !== 'paused',
                    stats: peer.id === 'pi' ? { ...piProbeStats } : qwenReadProbe.stats(),
                    sessionId: (peer.recoveryMetadata() as { sessionId?: string }).sessionId,
                });
                probeDiagnoses.set(peer.id, diagnosis);
                log('native_probe_diagnosis', { peer: peer.id, diagnosis: safeProbeDiagnosis(diagnosis) });
                // An unverified probe still fails the attempt (issue #150); only the serialized readiness changed.
                if (outcome.result !== 'denied') throw new Error(`native probe not verified: ${outcome.reason} (diagnosed: ${diagnosis.category})`);
                log('native_probe', { peer: peer.id, denied: true, evidence: outcome.evidence });
            }
            // #183: the bootstrap tool-surface readback, after every peer's probe turn (its generation
            // requests journaled their bounded surface projections) and BEFORE any scored generation.
            // The declared per-native surface is reconciled against what the pinned builds actually
            // published; the declared fail/defer policy is surfaceReadinessProblem: a mismatch or an
            // unknown published name is a condition mismatch and fails the attempt here, while an
            // unobserved publication is recorded explicitly and generation is deferred, never inferred.
            {
                const surfaceIntended = intendedSurfaces(kind, sourceDirs, excluded);
                const surfaceObserved = relay.requests().flatMap((r) => (r.toolSurface ? [r.toolSurface] : []));
                const surface = reconcileToolSurfaces(surfaceIntended, surfaceObserved);
                surfaceRecord = surfaceReport(surfaceIntended, surface);
                log('tool_surface', { surface: surfaceRecord });
                const surfaceProblem = surfaceReadinessProblem(surface);
                if (surfaceProblem) throw new Error(`tool surface not ready: ${surfaceProblem}`);
            }
            if (setupOnly) { endDetail = 'setup-calibration'; return; }

            const counts = Object.fromEntries(peers.map((p) => [p.id, answers[p.id]!.length]));
            const assignment = jointAssignment(index, repeat);
            active = true;
            started = Date.now();
            deadline = started + m.wall_limit_s * 1000;
            failureLatch.begin(started);
            // #175: the active-window traces open with the latch's generation, bound to each peer's session.
            for (const p of peers) activeTraces.get(p.id)?.begin(failureLatch.currentGeneration, (p.recoveryMetadata() as { sessionId?: string }).sessionId);
            log('active_start', { wallLimitSeconds: m.wall_limit_s, sourceDirs, featureAssignments: assignment });
            for (const peer of peers) {
                const featurePrompts = kind === 'joint-pi-qwen' ? [cachedInputs[index].prompts[assignment[peer.id as 'pi' | 'qwen']]] : cachedInputs[index].prompts;
                const instruction = `Implement the assigned CooperBench feature(s) below in the existing ${cas.repo} source. You have a ${m.wall_limit_s} second active wall limit. Read file tools, source edits under ${sourceDirs.join(', ')}/, no shell/tests/network/history/installs/subagents. Preserve other source and tests. ${kind === 'joint-pi-qwen' ? 'Another peer edits this same checkout. Use hub_send to agree overlapping changes; you own only the feature assigned below.' : 'You own BOTH features below.'} Do not read hidden data. Finish the implementation and reply [FYI] with files changed and verification limits.\n\n`;
                bus.publish(newEnvelope('user', instruction + featurePrompts.join('\n\n'), { to: [peer.id], priority: 'important' }));
            }
            endDetail = 'wall-timeout';
            let quiet = 0, captureAt = 0;
            while (true) {
                if (Date.now() - captureAt >= 5000) { captureNow(); captureAt = Date.now(); }
                const settled = peers.every((p) => p.state === 'idle' && answers[p.id]!.length > (counts[p.id] ?? 0) && (bus.snapshot().queues[p.id]?.length ?? 0) === 0);
                if (settled) quiet ||= Date.now(); else quiet = 0;
                // #160: a latched terminal failure exits at once, without exhausting the remaining wall budget;
                // check terminal causes even on the first tick after the wall limit.
                const exit = activeExit({ stopRequested, terminalFailure: failureLatch.failure !== undefined, peerUnreachable: peers.some((p) => p.state === 'paused' || p.state === 'offline'), settled, quietMs: quiet ? Date.now() - quiet : 0, wallExpired: Date.now() >= deadline });
                if (exit) { endDetail = exit; break; }
                await Bun.sleep(100);
            }
            elapsedMs = Date.now() - started;
            active = false;
            activeTree = tree(dir); // the active-window record, captured before any disposal (correction 5)
            failureLatch.freeze(); // the end cause is fixed here: later stop/watchdog callbacks are teardown events
            for (const trace of activeTraces.values()) trace.freeze(); // the active window closes with it (#175)
            log('active_end', { reason: endDetail, elapsedMs, ...(failureLatch.failure ? { failedPeer: failureLatch.failure.peer, failureClass: failureLatch.failure.failureClass, failedAt: failureLatch.failure.failedAt } : {}) });
        } catch (e) {
            error = clean(String(e));
            if (!failureLatch.frozen) endDetail = stopRequested ? 'interrupted' : 'infrastructure-error'; // a frozen active end cause is never replaced
            log('infrastructure_failure', { error });
        } finally {
            active = false;
            for (const trace of activeTraces.values()) trace.freeze(); // #175: idempotent; covers an error path that never reached active_end
            const teardownErrors: string[] = [];
            const note = (e: string) => { teardownErrors.push(e); log('cleanup-error', { error: e }); };
            const uncertainBefore = containmentUncertain;
            containmentUncertain = true;
            try { captureNow(); } catch (e) { note(`the last capture failed: ${String(e).slice(0, 200)}`); }
            // A peer-failure end cancels the whole attempt through this same owned-process teardown (#160): in a
            // joint arm both owned peers are stopped, so a failed actor never leaves the other performing an
            // undefined partial treatment.
            const cleanup = await teardown([...owners.values()], dir, async () => {
                const errors: string[] = [];
                for (const p of [...peers].reverse()) {
                    try { await p.stop(); } catch (e) { errors.push(`${p.id} stop: ${String(e).slice(0, 200)}`); }
                }
                return errors;
            });
            const contained = cleanup.outcome !== 'incomplete_or_unknown';
            if (contained) containmentUncertain = uncertainBefore;
            else log('cleanup-incomplete', { reasons: cleanup.reasons });
            // Per-request served-model evidence, snapshotted from the relay's journal before it closes (#139).
            const requestRecords = relay?.requests() ?? [];
            const qualification = qualifyRequests(requestRecords, { backend: m.fixed_backend, servedModel: m.expected_served_model, provider: m.expected_provider });
            if (!qualification.verified) log('request_linkage_failed', { reasons: qualification.reasons });
            // Unconditional disposal on every exit path; a closure failure is recorded and never erases the
            // active-window record captured above, and the relay is never left open (correction 5).
            for (const e of await disposeAll(setupClosers)) note(`disposal: ${e}`);
            setupClosers.clear();
            try { finalTree = tree(dir); } catch (e) { note(`final tree could not be read: ${String(e).slice(0, 200)}`); }
            const endFlags: string[] = [];
            const changed = finalTree ? Object.keys({ ...initial, ...finalTree }).filter((p) => initial[p] !== finalTree![p]) : [];
            const metadataClean = finalTree ? changed.every((p) => isSourcePath(sourceDirs, p)) && fixtureMetadataHash(dir) === metadataBaseline : false;
            if (!metadataClean) endFlags.push('metadata-modified');
            const lateWrites = activeTree && finalTree ? canonical(activeTree) !== canonical(finalTree) : null;
            const treeFlag = activeTreeFlag(endDetail, lateWrites);
            if (treeFlag) endFlags.push(treeFlag);
            let patch = '';
            try { patch = await collectSubmissionPatch(dir, base, sourceDirs); } catch (e) { note(`patch could not be collected: ${String(e).slice(0, 200)}`); }
            actorLedger.set(dir, cleanup.owned);
            persistLedger();
            const recordRoot = contained ? runs : join(runs, 'recovery');
            mkdirSync(join(recordRoot, 'runs'), { recursive: true, mode: 0o700 });
            mkdirSync(join(recordRoot, 'patches'), { recursive: true, mode: 0o700 });
            const patchFile = join(recordRoot, 'patches', name + '.patch');
            writeFileSync(patchFile, patch, { mode: 0o600 });
            const readiness: Record<string, unknown> = {};
            for (const p of peers) readiness[p.id] = { cwd: dir, requestedModel: 'dgx/coding', sessionId: (p.recoveryMetadata() as { sessionId?: string }).sessionId, sandboxProbe: probeReadiness(p.id, probeResults.get(p.id), probeTargetSha, p.id === 'qwen' ? kernelProbeDenied : undefined, probeDiagnoses.get(p.id)) };
            // #175: the bounded diagnosis of a latched active-window termination — the pinned message contract
            // for the terminal class and the failed peer's frozen count-only trace for the window. #179 adds
            // Pi's validated tool-step ceiling signal, bound to the latched peer and active generation. It
            // explains the latched failure and never changes it, and the raw failure text appears nowhere in it.
            const loopDiagnosis = failureLatch.failure ? safeActiveLoopDiagnosis(diagnoseActiveTermination(failureLatch.failure, activeTraces.get(failureLatch.failure.peer), boundCeilingSignal(failureLatch.failure, piCeilingSignals))) : undefined;
            if (loopDiagnosis) log('native_loop_diagnosis', { diagnosis: loopDiagnosis });
            const record = {
                protocol: 'native-pq-v3', platform: process.platform, index, kind, repo: cas.repo, features: cas.features, project: dir, cwd: dir, sealedCommit: base,
                readiness, patchFile, sourceDirs, featureAssignments: jointAssignment(index, repeat),
                modelIdentity: { requested: m.fixed_backend, expectedServedModel: m.expected_served_model, expectedProvider: m.expected_provider, probe: probeIdentity, generationVerified: qualification.verified, generationFailureReasons: qualification.verified ? undefined : qualification.reasons, requests: requestRecords },
                requestLinkage: qualification.coverage,
                nativeVersions: builds, repeat, setupMs: (started || Date.now()) - setup, elapsedMs, startedAt: started || undefined,
                usage: { pi: tokens.pi, qwen: tokens.qwen, qwenAvailability: tokens.qwen === null ? "no-reading" : "known", qwenDiagnostics: qwenUsageDiagnostics, units: { pi: 'incremental onTokens counter, whole attempt including the setup probes', qwen: 'session usage_update running total, whole attempt including the setup probes' }, toolSurfaces: { pi: `benchmark descriptors (#182): read/write/edit/git ls-files${kind === 'joint-pi-qwen' ? '/hub_send' : ''}, hub-moderated`, qwen: `own file tools under seatbelt auto-edit, --bare and the excluded list${kind === 'joint-pi-qwen' ? ', hub_send over MCP' : ''} (#183)` } },
                // #183: the declared per-native tool surface and its bootstrap reconciliation (allowlisted
                // names, counts and opaque hashes only); undefined only when the arm failed before the check.
                toolSurface: surfaceRecord,
                end_reason: endReasonOf(endDetail, endFlags), end_reason_detail: endDetail, end_flags: endFlags.length ? endFlags : undefined,
                // #160: the preserved terminal failure (peer, original class, failure time) whenever one latched.
                peer_failure: failureLatch.failure,
                // #175: its bounded loop-protection diagnosis (fixed enums and counts only), beside it.
                loop_diagnosis: loopDiagnosis,
                error: error ? error.replace(/(token|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]').slice(0, 300) : undefined,
                cleanup, cleanup_complete: contained, teardown_errors: teardownErrors.length ? teardownErrors : undefined,
                metadata_clean: metadataClean, metadata_sha256: metadataBaseline, tree_changed_after_active_time: lateWrites, changedPaths: changed,
                events, answers, patchSHA256: sha(patch), patchBytes: Buffer.byteLength(patch),
            };
            writeRecordFresh(join(recordRoot, 'runs', name + '.json'), JSON.stringify(record, null, 2));
            log('arm-end', { elapsedMs, endReason: record.end_reason, cleanup: cleanup.outcome, patchBytes: record.patchBytes });
            summaries.push({ attemptId: name, caseIndex: index, repeat, arm: kind, endReason: record.end_reason, elapsedMs, cleanupComplete: contained, generationVerified: qualification.verified });
            processed++;
            writeAtomic(join(runs, 'progress.json'), JSON.stringify({ at: new Date().toISOString(), processed, planned: plannedCells.length, current: name, summaries }, null, 2));
            if (!contained) throw new Error(`cleanup ${cleanup.outcome}: ${cleanup.reasons.join('; ')}; record in ${join(recordRoot, 'runs', name + '.json')}`);
            if (teardownErrors.length) throw new Error('teardown incomplete; stopping cohort: ' + teardownErrors.join('; '));
        }
    }

    claimExclusive(join(runs, 'native-owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), sourceSHA256: sourceHash(selfPath) }));
    mkdirSync(join(runs, 'runs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(runs, 'patches'), { recursive: true, mode: 0o700 });
    writeFileSync(join(runs, 'cohort.json'), JSON.stringify({ schema: m.schema, manifest_sha256: sourceHash(join(runs, 'manifest.json')), cases: selected, calibration: setupOnly, repeat, private_case_sha256: Object.fromEntries(selected.map((i: number) => [i, privateCaseHashes[i]])), arms: m.arms, plan: plannedCells, runner_sha256: prepared.runner_sha256, native_runner_sha256: prepared.native_runner_sha256, pi_qwen_runner_sha256: prepared.pi_qwen_runner_sha256, peer_bus_sha256: prepared.peer_bus_sha256, teardown_sha256: prepared.teardown_sha256 }), { mode: 0o600 });
    persistLedger();
    try {
        for (const cell of plannedCells) {
            if (stopRequested) break;
            const name = `${cell.caseIndex.toString().padStart(2, '0')}-${cell.arm}`;
            try {
                await arm(cell.caseIndex, cell.arm);
            } catch (e) {
                // Disposal before any fallback write (corrections 5 and 6): a failed arm never leaves the relay or
                // the tool server open, and a fallback record is written only where no record exists yet — existing
                // attempt evidence is rejected, never overwritten.
                for (const err of await disposeAll(setupClosers)) console.log(JSON.stringify({ event: 'disposal-error', error: err }));
                setupClosers.clear();
                if (!existsSync(join(runs, 'runs', name + '.json')) && !existsSync(join(runs, 'recovery', 'runs', name + '.json'))) {
                    const record = { protocol: 'native-pq-v3', platform: process.platform, index: cell.caseIndex, kind: cell.arm, repo: m.cases[cell.caseIndex].repo, features: m.cases[cell.caseIndex].features, cwd: fixtureDir(cell.caseIndex, cell.arm), sealedCommit: '', readiness: {}, patchFile: '', modelIdentity: { requested: m.fixed_backend, generationVerified: false, requests: [] }, requestLinkage: { requests: 0, completed: 0, identified: 0, cancelledUnidentified: 0, mismatches: 0, providerMissing: 0 }, nativeVersions: {}, repeat, end_reason: 'infrastructure-error', end_reason_detail: stopRequested ? 'interrupted' : 'infrastructure-error', error: String(e).slice(0, 300), cleanup_complete: false, metadata_clean: false, events: [], answers: {}, patchSHA256: sha(''), patchBytes: 0 };
                    writeRecordFresh(join(runs, 'runs', name + '.json'), JSON.stringify(record, null, 2));
                    summaries.push({ attemptId: name, caseIndex: cell.caseIndex, repeat, arm: cell.arm, endReason: 'infrastructure-error', cleanupComplete: false });
                    processed++;
                }
                console.log(JSON.stringify({ event: 'arm-failed', attemptId: name, error: String(e).slice(0, 300) }));
                stopRequested = true; // an infrastructure failure stops the cohort; every planned cell stays reported
            }
        }
    } finally {
        if (containmentUncertain) {
            writeAtomic(join(runs, 'restoration.json'), JSON.stringify({ restored: false, reason: "an arm's cleanup is incomplete or unknown", ledger: 'restoration-ledger.json', records: 'recovery/runs', recover: `bun scripts/benchmarks/restore.ts --run ${runs}`, interrupted: stopRequested }));
        } else {
            writeAtomic(join(runs, 'restoration.json'), JSON.stringify({ restored: true, interrupted: stopRequested }));
        }
        writeAtomic(join(runs, 'native-outcome.json'), JSON.stringify({ at: new Date().toISOString(), processed, planned: plannedCells.length, complete: processed === plannedCells.length, interrupted: stopRequested }, null, 2));
    }
    console.log(JSON.stringify({ event: 'run-complete', processed, planned: plannedCells.length, complete: processed === plannedCells.length }));
    return processed === plannedCells.length ? 0 : 1;
}

if (import.meta.main) {
    main().then(
        (code) => { process.exitCode = code; },
        (e) => { console.error(String(e)); process.exitCode = 2; },
    );
}
