/** Rooms v1 primitives. No transport, storage writes, or module-import self-test. */
export interface PublicHubIdentity {
  readonly fingerprint: string;
  readonly signingKey: string;
  readonly agreementKey: string;
}

declare const identityBrand: unique symbol;
export interface HubIdentity {
  readonly public: PublicHubIdentity;
  readonly [identityBrand]: true;
}
declare const epochBrand: unique symbol;
export interface EpochKey { readonly [epochBrand]: true }

/** Explicit machine-local serialization only; these private bytes are not encrypted. */
export interface LocalIdentityRecord {
  v: 1;
  public: PublicHubIdentity;
  signingPrivateKey: string;
  agreementPrivateKey: string;
}
export interface WrappedEpochKey {
  v: 1;
  owner: string;
  recipient: string;
  ephemeralKey: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  signature: string;
}
export type RoomCryptoCode = "unavailable" | "invalid_input" | "invalid_identity" | "invalid_key" | "authentication_failed";
export class RoomCryptoError extends Error {
  constructor(readonly code: RoomCryptoCode) {
    super(`Room crypto: ${code}`);
    this.name = "RoomCryptoError";
  }
}

interface PrivateIdentity {
  signing: CryptoKey;
  agreement: CryptoKey;
  // Runtime imports are non-extractable. Only this explicit storage record retains secrets.
  // Same-user code can read persisted secrets; this is not a process-isolation boundary.
  record: LocalIdentityRecord;
}
const identities = new WeakMap<HubIdentity, PrivateIdentity>();
const epochKeys = new WeakMap<EpochKey, Uint8Array>();
const utf8 = new TextEncoder();
const DOMAIN = "agent-hub.rooms.v1";
let readiness: Promise<void> | undefined;

const fail = (code: RoomCryptoCode): never => { throw new RoomCryptoError(code); };
const buf = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;
function bytes(value: Uint8Array, length?: number): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) fail("invalid_input");
  return Uint8Array.from(value);
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map(pair => parseInt(pair, 16)));
}
function toHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
}
function transcript(value: unknown[]): Uint8Array { return utf8.encode(JSON.stringify(value)); }

export function encodeBase64url(value: Uint8Array): string {
  return Buffer.from(bytes(value)).toString("base64url");
}
export function decodeBase64url(value: string, expectedLength?: number): Uint8Array {
  if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength < 0
    || typeof value !== "string" || value.length !== Math.ceil(expectedLength * 4 / 3))) fail("invalid_input");
  if (typeof value !== "string" || value.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) fail("invalid_input");
  const decoded = Uint8Array.from(Buffer.from(value, "base64url"));
  if (encodeBase64url(decoded) !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) fail("invalid_input");
  return decoded;
}
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > 65536) fail("invalid_input");
  try { return globalThis.crypto.getRandomValues(new Uint8Array(length)); }
  catch { return fail("unavailable"); }
}

async function operation<T>(fn: () => Promise<T>, code: RoomCryptoCode = "authentication_failed"): Promise<T> {
  await assertRoomCryptoReady();
  try { return await fn(); }
  catch (error) { if (error instanceof RoomCryptoError) throw error; return fail(code); }
}
async function importPrivate(algorithm: "Ed25519" | "X25519", value: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", buf(value), algorithm, false, algorithm === "Ed25519" ? ["sign"] : ["deriveBits"]);
}
async function importPublic(algorithm: "Ed25519" | "X25519", value: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(value), algorithm, false, algorithm === "Ed25519" ? ["verify"] : []);
}
async function generatePair(algorithm: "Ed25519" | "X25519", extractable: boolean): Promise<CryptoKeyPair> {
  const result = await crypto.subtle.generateKey(algorithm, extractable, algorithm === "Ed25519" ? ["sign", "verify"] : ["deriveBits"]);
  if ("publicKey" in result && "privateKey" in result) return result;
  return fail("unavailable");
}
async function agreement(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256));
  if (shared.every(byte => byte === 0)) fail("invalid_key");
  return shared;
}
async function hkdf(raw: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey("raw", buf(raw), "HKDF", false, ["deriveKey"]);
  // Bind the full versioned transcript without exceeding the provider's HKDF info limit.
  // AES AAD and signatures still authenticate the complete, unhashed transcript.
  const infoHash = await crypto.subtle.digest("SHA-256", buf(info));
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: infoHash }, key,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function aes(encrypt: boolean, key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const algorithm = { name: "AES-GCM", iv: buf(nonce), additionalData: buf(aad), tagLength: 128 };
  return new Uint8Array(await (encrypt ? crypto.subtle.encrypt(algorithm, key, buf(input)) : crypto.subtle.decrypt(algorithm, key, buf(input))));
}

export const ROOM_MIN_BUN_VERSION = "1.4.2";

/** Cached actual built-in known-answer checks. Failure disables all async room crypto. */
export function assertRoomCryptoReady(): Promise<void> {
  readiness ??= (async () => {
    try {
      if (typeof Bun === "undefined" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(Bun.version)) fail("unavailable");
      const version = Bun.version.split(".").map(part => Number.parseInt(part, 10));
      const minimum = ROOM_MIN_BUN_VERSION.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if (version[i]! < minimum[i]!) fail("unavailable");
        if (version[i]! > minimum[i]!) break;
      }
      await selfTest();
    } catch { fail("unavailable"); }
  })();
  return readiness;
}

async function selfTest(): Promise<void> {
  const check = (actual: Uint8Array, expected: string) => { if (!equal(actual, hex(expected))) fail("unavailable"); };
  // RFC 8032 section 7.1, TEST 1. PKCS8 prefixes encode RFC 8410 private keys.
  const ed = await importPrivate("Ed25519", hex("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
  const edPublic = await importPublic("Ed25519", hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", ed, new Uint8Array()));
  check(signature, "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  if (!await crypto.subtle.verify("Ed25519", edPublic, buf(signature), new Uint8Array())) fail("unavailable");
  signature[0] = signature[0]! ^ 1;
  if (await crypto.subtle.verify("Ed25519", edPublic, buf(signature), new Uint8Array())) fail("unavailable");
  // RFC 7748 section 6.1.
  const x = await importPrivate("X25519", hex("302e020100300506032b656e0422042077076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"));
  const xPublic = await importPublic("X25519", hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"));
  check(await agreement(x, xPublic), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
  let rejected = false;
  try { await agreement(x, await importPublic("X25519", new Uint8Array(32))); } catch { rejected = true; }
  if (!rejected) fail("unavailable");
  // RFC 5869 appendix A.1, SHA-256, 42-byte output.
  const hk = await crypto.subtle.importKey("raw", new Uint8Array(22).fill(0x0b), "HKDF", false, ["deriveBits"]);
  check(new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(hex("000102030405060708090a0b0c")), info: buf(hex("f0f1f2f3f4f5f6f7f8f9")) }, hk, 336)),
    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  // GCM specification test case 14, AES-256, zero key/IV/plaintext.
  // https://csrc.nist.gov/groups/ST/toolkit/BCM/documents/proposedmodes/gcm/gcm-spec.pdf
  const aesKey = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const ciphertext = await aes(true, aesKey, new Uint8Array(12), new Uint8Array(), new Uint8Array(16));
  check(ciphertext, "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919");
  if (!equal(await aes(false, aesKey, new Uint8Array(12), new Uint8Array(), ciphertext), new Uint8Array(16))) fail("unavailable");
  rejected = false;
  ciphertext[0] = ciphertext[0]! ^ 1;
  try { await aes(false, aesKey, new Uint8Array(12), new Uint8Array(), ciphertext); } catch { rejected = true; }
  if (!rejected) fail("unavailable");
  // RFC 4231 section 4.2, test case 1.
  const hm = await crypto.subtle.importKey("raw", new Uint8Array(20).fill(0x0b), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hm, utf8.encode("Hi There")));
  check(mac, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  if (!await crypto.subtle.verify("HMAC", hm, buf(mac), utf8.encode("Hi There"))) fail("unavailable");
  mac[0] = mac[0]! ^ 1;
  if (await crypto.subtle.verify("HMAC", hm, buf(mac), utf8.encode("Hi There"))) fail("unavailable");
  check(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // A KAT-only implementation might still lack generation, used by identity and wraps.
  await generatePair("Ed25519", true);
  await generatePair("X25519", true);
}

function publicCopy(value: PublicHubIdentity): PublicHubIdentity {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "agreementKey,fingerprint,signingKey"
    || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) fail("invalid_identity");
  decodeBase64url(value.signingKey, 32);
  decodeBase64url(value.agreementKey, 32);
  return Object.freeze({ fingerprint: value.fingerprint, signingKey: value.signingKey, agreementKey: value.agreementKey });
}
async function checkedPublic(value: PublicHubIdentity): Promise<PublicHubIdentity> {
  const copy = publicCopy(value);
  if (toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf(decodeBase64url(copy.signingKey, 32))))) !== copy.fingerprint) fail("invalid_identity");
  return copy;
}
/** Reject unusable/low-order X25519 public keys before admitting a member. */
export async function assertAgreementKeyUsable(identity: PublicHubIdentity): Promise<void> {
  const pub = publicCopy(identity);
  return operation(async () => {
    await checkedPublic(pub);
    const probe = await generatePair("X25519", false);
    await agreement(probe.privateKey, await importPublic("X25519", decodeBase64url(pub.agreementKey, 32)));
  }, "invalid_key");
}
function identityState(identity: HubIdentity): PrivateIdentity {
  return identities.get(identity) ?? fail("invalid_identity");
}
function rootState(key: EpochKey): Uint8Array { return epochKeys.get(key) ?? fail("invalid_key"); }

export async function generateHubIdentity(): Promise<HubIdentity> {
  return operation(async () => {
    const signing = await generatePair("Ed25519", true);
    const agreementKeys = await generatePair("X25519", true);
    const signingRaw = new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey));
    return importHubIdentity({ v: 1, public: {
      fingerprint: toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf(signingRaw)))),
      signingKey: encodeBase64url(signingRaw),
      agreementKey: encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", agreementKeys.publicKey))),
    }, signingPrivateKey: encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", signing.privateKey))),
    agreementPrivateKey: encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", agreementKeys.privateKey))) });
  }, "invalid_key");
}
export async function importHubIdentity(record: LocalIdentityRecord): Promise<HubIdentity> {
  if (!record || record.v !== 1 || Object.keys(record).sort().join(",") !== "agreementPrivateKey,public,signingPrivateKey,v") fail("invalid_identity");
  const pub = publicCopy(record.public);
  const signingPrivateKey = record.signingPrivateKey;
  const agreementPrivateKey = record.agreementPrivateKey;
  const signingRaw = decodeBase64url(signingPrivateKey, 48);
  const agreementRaw = decodeBase64url(agreementPrivateKey, 48);
  return operation(async () => {
    await checkedPublic(pub);
    const signing = await importPrivate("Ed25519", signingRaw);
    const privateAgreement = await importPrivate("X25519", agreementRaw);
    const challenge = randomBytes(32);
    const signature = await crypto.subtle.sign("Ed25519", signing, buf(challenge));
    if (!await crypto.subtle.verify("Ed25519", await importPublic("Ed25519", decodeBase64url(pub.signingKey, 32)), signature, buf(challenge))) fail("invalid_identity");
    const probe = await generatePair("X25519", false);
    const left = await agreement(privateAgreement, probe.publicKey);
    const right = await agreement(probe.privateKey, await importPublic("X25519", decodeBase64url(pub.agreementKey, 32)));
    if (!equal(left, right)) fail("invalid_identity");
    const identity = Object.freeze({ public: pub }) as HubIdentity;
    identities.set(identity, { signing, agreement: privateAgreement, record: { v: 1, public: pub, signingPrivateKey, agreementPrivateKey } });
    return identity;
  }, "invalid_identity");
}
export async function exportHubIdentityForStorage(identity: HubIdentity): Promise<LocalIdentityRecord> {
  return operation(async () => {
    const record = identityState(identity).record;
    return { ...record, public: { ...record.public } };
  }, "invalid_identity");
}
export async function generateEpochKey(): Promise<EpochKey> { return importEpochKey(randomBytes(32)); }
export async function importEpochKey(raw: Uint8Array): Promise<EpochKey> {
  const copy = bytes(raw, 32);
  return operation(async () => {
    const key = Object.freeze({}) as EpochKey;
    epochKeys.set(key, copy);
    return key;
  }, "invalid_key");
}
export async function exportEpochKeyForStorage(key: EpochKey): Promise<Uint8Array> {
  return operation(async () => Uint8Array.from(rootState(key)), "invalid_key");
}
export async function sha256(input: Uint8Array): Promise<Uint8Array> {
  const copy = bytes(input);
  return operation(async () => new Uint8Array(await crypto.subtle.digest("SHA-256", buf(copy))));
}
export async function signBytes(identity: HubIdentity, input: Uint8Array): Promise<Uint8Array> {
  const copy = bytes(input);
  return operation(async () => new Uint8Array(await crypto.subtle.sign("Ed25519", identityState(identity).signing, buf(copy))), "invalid_identity");
}
export async function verifyBytes(identity: PublicHubIdentity, input: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const pub = publicCopy(identity), copy = bytes(input), sig = bytes(signature);
  return operation(async () => {
    await checkedPublic(pub);
    if (sig.length !== 64) return false;
    return crypto.subtle.verify("Ed25519", await importPublic("Ed25519", decodeBase64url(pub.signingKey, 32)), buf(sig), buf(copy));
  });
}
export async function hmac(rawKey: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const key = bytes(rawKey), copy = bytes(input);
  if (key.length === 0) fail("invalid_key");
  return operation(async () => {
    const imported = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", imported, buf(copy)));
  });
}
export async function verifyHmac(rawKey: Uint8Array, input: Uint8Array, mac: Uint8Array): Promise<boolean> {
  const key = bytes(rawKey), copy = bytes(input), tag = bytes(mac);
  if (key.length === 0) fail("invalid_key");
  return operation(async () => {
    if (tag.length !== 32) return false;
    const imported = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("HMAC", imported, buf(tag), buf(copy));
  });
}

export type EpochPurpose = "frame" | "roster" | "invite";
export interface EpochCipherInput {
  key: EpochKey;
  purpose: EpochPurpose;
  context: Uint8Array;
  nonce: Uint8Array;
  /** Defaults to context. Frame callers separate stable sender-key context from per-frame AAD. */
  aad?: Uint8Array;
}
async function epochCipher(encrypt: boolean, input: EpochCipherInput, data: Uint8Array): Promise<Uint8Array> {
  const context = bytes(input.context), nonce = bytes(input.nonce, 12), aad = bytes(input.aad ?? context), copy = bytes(data);
  const purpose = input.purpose, root = input.key;
  if (!["frame", "roster", "invite"].includes(purpose)) fail("invalid_input");
  return operation(async () => {
    const key = await hkdf(rootState(root), new Uint8Array(32), transcript([DOMAIN, purpose, encodeBase64url(context)]));
    return aes(encrypt, key, nonce, aad, copy);
  });
}
export async function encryptEpoch(input: EpochCipherInput & { plaintext: Uint8Array }): Promise<Uint8Array> {
  return epochCipher(true, input, input.plaintext);
}
export async function decryptEpoch(input: EpochCipherInput & { ciphertext: Uint8Array }): Promise<Uint8Array> {
  return epochCipher(false, input, input.ciphertext);
}

function pubTuple(identity: PublicHubIdentity): string[] { return [identity.fingerprint, identity.signingKey, identity.agreementKey]; }
function wrapContext(context: Uint8Array, owner: PublicHubIdentity, recipient: PublicHubIdentity, ephemeral: string): Uint8Array {
  return transcript([DOMAIN, "wrap", encodeBase64url(context), pubTuple(owner), pubTuple(recipient), ephemeral]);
}
function wrapSignature(context: Uint8Array, owner: PublicHubIdentity, recipient: PublicHubIdentity, wrapped: Omit<WrappedEpochKey, "signature">): Uint8Array {
  return transcript([DOMAIN, "wrap-signature", encodeBase64url(context), pubTuple(owner), pubTuple(recipient), wrapped.v,
    wrapped.owner, wrapped.recipient, wrapped.ephemeralKey, wrapped.salt, wrapped.nonce, wrapped.ciphertext]);
}
export async function wrapEpochKey(input: { owner: HubIdentity; recipient: PublicHubIdentity; context: Uint8Array; key: EpochKey }): Promise<WrappedEpochKey> {
  const context = bytes(input.context), recipient = publicCopy(input.recipient), owner = input.owner, root = input.key;
  return operation(async () => {
    const ownerState = identityState(owner);
    await checkedPublic(recipient);
    const ephemeral = await generatePair("X25519", true);
    const ephemeralKey = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)));
    const salt = randomBytes(32), nonce = randomBytes(12);
    const info = wrapContext(context, owner.public, recipient, ephemeralKey);
    const shared = await agreement(ephemeral.privateKey, await importPublic("X25519", decodeBase64url(recipient.agreementKey, 32)));
    const key = await hkdf(shared, salt, info);
    const wrapped: Omit<WrappedEpochKey, "signature"> = { v: 1, owner: owner.public.fingerprint, recipient: recipient.fingerprint,
      ephemeralKey, salt: encodeBase64url(salt), nonce: encodeBase64url(nonce),
      ciphertext: encodeBase64url(await aes(true, key, nonce, info, rootState(root))) };
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", ownerState.signing, buf(wrapSignature(context, owner.public, recipient, wrapped))));
    return { ...wrapped, signature: encodeBase64url(signature) };
  });
}
export async function unwrapEpochKey(input: { recipient: HubIdentity; owner: PublicHubIdentity; context: Uint8Array; wrapped: WrappedEpochKey }): Promise<EpochKey> {
  const context = bytes(input.context), owner = publicCopy(input.owner), recipient = input.recipient;
  const source = input.wrapped;
  if (!source || Object.keys(source).sort().join(",") !== "ciphertext,ephemeralKey,nonce,owner,recipient,salt,signature,v" || source.v !== 1) fail("invalid_input");
  const wrapped = { ...source };
  const ephemeral = decodeBase64url(wrapped.ephemeralKey, 32), salt = decodeBase64url(wrapped.salt, 32), nonce = decodeBase64url(wrapped.nonce, 12);
  const ciphertext = decodeBase64url(wrapped.ciphertext, 48), signature = decodeBase64url(wrapped.signature, 64);
  return operation(async () => {
    const recipientState = identityState(recipient);
    await checkedPublic(owner);
    if (wrapped.owner !== owner.fingerprint || wrapped.recipient !== recipient.public.fingerprint) fail("authentication_failed");
    if (!await crypto.subtle.verify("Ed25519", await importPublic("Ed25519", decodeBase64url(owner.signingKey, 32)), buf(signature),
      buf(wrapSignature(context, owner, recipient.public, wrapped)))) fail("authentication_failed");
    const info = wrapContext(context, owner, recipient.public, wrapped.ephemeralKey);
    const shared = await agreement(recipientState.agreement, await importPublic("X25519", ephemeral));
    const key = await hkdf(shared, salt, info);
    return importEpochKey(await aes(false, key, nonce, info, ciphertext));
  });
}
