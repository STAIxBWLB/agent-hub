import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertRoomCryptoReady, decodeBase64url, decryptEpoch, encodeBase64url, encryptEpoch,
  exportEpochKeyForStorage, exportHubIdentityForStorage, generateEpochKey, generateHubIdentity,
  hmac, importEpochKey, importHubIdentity, randomBytes, RoomCryptoError, sha256, signBytes,
  unwrapEpochKey, verifyBytes, verifyHmac, wrapEpochKey,
  type LocalIdentityRecord, type RoomCryptoCode,
} from "../src/rooms/crypto.ts";

const text = (value: string) => new TextEncoder().encode(value);
const hex = (value: string) => Uint8Array.from(value.match(/../g)!.map(pair => parseInt(pair, 16)));
const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

async function isolatedCrypto(prefix = ""): Promise<typeof import("../src/rooms/crypto.ts")> {
  // Bun caches query variants as one module. A unique dependency-free copy isolates
  // readiness; the optional lexical Bun binding exercises the real version gate.
  const dir = mkdtempSync(join(tmpdir(), "ahub-room-crypto-"));
  const moduleFile = join(dir, "crypto.ts");
  writeFileSync(moduleFile, prefix + readFileSync(new URL("../src/rooms/crypto.ts", import.meta.url), "utf8"));
  try { return await import(pathToFileURL(moduleFile).href); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

async function refused(work: Promise<unknown>, code?: RoomCryptoCode): Promise<void> {
  try { await work; throw new Error("expected refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(RoomCryptoError);
    const refusal = error as RoomCryptoError;
    if (code) expect(refusal.code).toBe(code);
    expect(refusal.message).toBe(`Room crypto: ${refusal.code}`);
    expect(refusal.cause).toBeUndefined();
  }
}

// Independent public standard fixtures, never deployment identities.
// RFC 8032 7.1 TEST 1 and RFC 7748 6.1 Alice identity.
async function vectorIdentity(): Promise<LocalIdentityRecord> {
  const signing = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  return {
    v: 1,
    public: { fingerprint: toHex(await sha256(signing)), signingKey: encodeBase64url(signing),
      agreementKey: encodeBase64url(hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")) },
    signingPrivateKey: encodeBase64url(hex("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")),
    agreementPrivateKey: encodeBase64url(hex("302e020100300506032b656e0422042077076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")),
  };
}

test("room crypto startup checks RFC 8032/7748/5869/4231 and AES-256-GCM known answers", async () => {
  const first = assertRoomCryptoReady();
  expect(assertRoomCryptoReady()).toBe(first);
  await first;
});

test("room signing matches RFC 8032 section 7.1 TEST 1 exactly", async () => {
  const identity = await importHubIdentity(await vectorIdentity());
  const signature = await signBytes(identity, new Uint8Array());
  expect(toHex(signature)).toBe("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  expect(await verifyBytes(identity.public, new Uint8Array(), signature)).toBe(true);
  expect(await verifyBytes(identity.public, text("tampered"), signature)).toBe(false);
  expect(await verifyBytes(identity.public, new Uint8Array(), signature.subarray(1))).toBe(false);
});

test("room HMAC matches RFC 4231 section 4.2 and SHA256 matches the abc known answer", async () => {
  const key = new Uint8Array(20).fill(0x0b), message = text("Hi There");
  const mac = await hmac(key, message);
  expect(toHex(mac)).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  expect(await verifyHmac(key, message, mac)).toBe(true);
  expect(await verifyHmac(key, text("Hi There!"), mac)).toBe(false);
  expect(await verifyHmac(key, message, mac.subarray(1))).toBe(false);
  expect(toHex(await sha256(text("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("canonical base64url refuses padding, alternate bits, nonalphabet and wrong lengths", () => {
  expect(encodeBase64url(hex("00ff7f"))).toBe("AP9_");
  expect(decodeBase64url("AP9_", 3)).toEqual(hex("00ff7f"));
  expect(decodeBase64url("")).toEqual(new Uint8Array());
  for (const value of ["Zg==", "Zh", "Z+", "Z/", "A", " a", "AA\n"]) {
    expect(() => decodeBase64url(value)).toThrow(RoomCryptoError);
  }
  expect(() => decodeBase64url("AA", 2)).toThrow(RoomCryptoError);
  for (const length of [0, -1, 1.5, 65537, NaN]) expect(() => randomBytes(length)).toThrow(RoomCryptoError);
  expect(randomBytes(32)).toHaveLength(32);
});

test("hub identity secrets require explicit local serialization and restoration validates key pairs", async () => {
  const identity = await generateHubIdentity();
  expect(Object.keys(identity)).toEqual(["public"]);
  expect(Object.isFrozen(identity)).toBe(true);
  expect(Object.isFrozen(identity.public)).toBe(true);
  const record = await exportHubIdentityForStorage(identity);
  expect(JSON.stringify(identity)).not.toContain(record.signingPrivateKey);
  expect(JSON.stringify(identity)).not.toContain(record.agreementPrivateKey);
  const restored = await importHubIdentity(record);
  const message = text("identity restoration");
  expect(await verifyBytes(identity.public, message, await signBytes(restored, message))).toBe(true);
  record.public = { ...record.public, fingerprint: "0".repeat(64) };
  expect(identity.public.fingerprint).not.toBe("0".repeat(64));
  await refused(importHubIdentity(record), "invalid_identity");
});

test("import refuses substituted private signing/agreement keys and forged runtime identities", async () => {
  const first = await exportHubIdentityForStorage(await generateHubIdentity());
  const second = await exportHubIdentityForStorage(await generateHubIdentity());
  await refused(importHubIdentity({ ...first, signingPrivateKey: second.signingPrivateKey }), "invalid_identity");
  await refused(importHubIdentity({ ...first, agreementPrivateKey: second.agreementPrivateKey }), "invalid_identity");
  await refused(signBytes({ public: first.public } as never, text("forged")), "invalid_identity");
  await refused(importEpochKey(new Uint8Array(31)), "invalid_input");
  await refused(exportEpochKeyForStorage({} as never), "invalid_key");
});

test("epoch root import/export copies bytes and ordinary serialization carries no key", async () => {
  const raw = new Uint8Array(32).fill(7), key = await importEpochKey(raw);
  raw.fill(8);
  expect(JSON.stringify(key)).toBe("{}");
  const exported = await exportEpochKeyForStorage(key);
  expect(exported).toEqual(new Uint8Array(32).fill(7));
  exported.fill(9);
  expect(await exportEpochKeyForStorage(key)).toEqual(new Uint8Array(32).fill(7));
});

test("epoch encryption binds purpose, stable context, per-frame AAD, nonce and key", async () => {
  const key = await generateEpochKey(), nonce = new Uint8Array(12);
  nonce[11] = 1;
  const context = text("room/epoch/sender/rosterDigest"), aad = text("room|1|sender|1");
  const plaintext = text("only members read this");
  const ciphertext = await encryptEpoch({ key, purpose: "frame", context, nonce, aad, plaintext });
  expect(await decryptEpoch({ key, purpose: "frame", context, nonce, aad, ciphertext })).toEqual(plaintext);
  await refused(decryptEpoch({ key, purpose: "roster", context, nonce, aad, ciphertext }), "authentication_failed");
  await refused(decryptEpoch({ key, purpose: "invite", context, nonce, aad, ciphertext }), "authentication_failed");
  await refused(decryptEpoch({ key, purpose: "frame", context: text("another sender"), nonce, aad, ciphertext }), "authentication_failed");
  await refused(decryptEpoch({ key, purpose: "frame", context, nonce, aad: text("room|1|sender|2"), ciphertext }), "authentication_failed");
  await refused(decryptEpoch({ key, purpose: "frame", context, nonce: new Uint8Array(12), aad, ciphertext }), "authentication_failed");
  await refused(decryptEpoch({ key: await generateEpochKey(), purpose: "frame", context, nonce, aad, ciphertext }), "authentication_failed");
  ciphertext[0] = ciphertext[0]! ^ 1;
  await refused(decryptEpoch({ key, purpose: "frame", context, nonce, aad, ciphertext }), "authentication_failed");
});

test("epoch cipher supports separate invite purpose and defaults AAD to context", async () => {
  const key = await importEpochKey(new Uint8Array(32).fill(11)), nonce = randomBytes(12), context = text("invite-v1");
  const ciphertext = await encryptEpoch({ key, purpose: "invite", context, nonce, plaintext: text("private enrollment metadata") });
  expect(await decryptEpoch({ key, purpose: "invite", context, nonce, ciphertext })).toEqual(text("private enrollment metadata"));
  await refused(encryptEpoch({ key, purpose: "unknown" as never, context, nonce, plaintext: text("refused") }), "invalid_input");
  await refused(encryptEpoch({ key, purpose: "frame", context, nonce: new Uint8Array(11), plaintext: text("refused") }), "invalid_input");
});

test("owner wrapping binds all identities and context while using a fresh ephemeral key and salt", async () => {
  const owner = await generateHubIdentity(), recipient = await generateHubIdentity(), key = await generateEpochKey();
  const context = text("canonical roster and encrypted-roster digest");
  const wrapped = await wrapEpochKey({ owner, recipient: recipient.public, context, key });
  const unwrapped = await unwrapEpochKey({ recipient, owner: owner.public, context, wrapped });
  expect(await exportEpochKeyForStorage(unwrapped)).toEqual(await exportEpochKeyForStorage(key));
  const second = await wrapEpochKey({ owner, recipient: recipient.public, context, key });
  expect(second.ephemeralKey).not.toBe(wrapped.ephemeralKey);
  expect(second.salt).not.toBe(wrapped.salt);
  await refused(unwrapEpochKey({ recipient, owner: owner.public, context: text("another epoch"), wrapped }), "authentication_failed");
  await refused(unwrapEpochKey({ recipient: await generateHubIdentity(), owner: owner.public, context, wrapped }), "authentication_failed");
  await refused(unwrapEpochKey({ recipient, owner: (await generateHubIdentity()).public, context, wrapped }), "authentication_failed");
});

test("large roster contexts bind the full transcript while keeping HKDF info bounded", async () => {
  const owner = await generateHubIdentity(), recipient = await generateHubIdentity(), key = await generateEpochKey();
  const context = new Uint8Array(16 * 1024).fill(97);
  const changed = Uint8Array.from(context);
  changed[changed.length - 1] = 98;
  const wrapped = await wrapEpochKey({ owner, recipient: recipient.public, context, key });
  const restored = await unwrapEpochKey({ recipient, owner: owner.public, context, wrapped });
  expect(await exportEpochKeyForStorage(restored)).toEqual(await exportEpochKeyForStorage(key));
  await refused(unwrapEpochKey({ recipient, owner: owner.public, context: changed, wrapped }), "authentication_failed");
  const nonce = randomBytes(12), plaintext = text("large-context metadata");
  const ciphertext = await encryptEpoch({ key, purpose: "roster", context, nonce, plaintext });
  expect(await decryptEpoch({ key, purpose: "roster", context, nonce, ciphertext })).toEqual(plaintext);
  // Explicit identical AAD isolates HKDF context binding from AES AAD binding.
  await refused(decryptEpoch({ key, purpose: "roster", context: changed, aad: context, nonce, ciphertext }), "authentication_failed");
});

test("wrap refuses tampered or unsigned packets and substituted agreement keys", async () => {
  const owner = await generateHubIdentity(), recipient = await generateHubIdentity(), other = await generateHubIdentity();
  const key = await generateEpochKey(), context = text("epoch1");
  const wrapped = await wrapEpochKey({ owner, recipient: recipient.public, context, key });
  for (const field of ["ephemeralKey", "salt", "nonce", "ciphertext", "signature"] as const) {
    const changed = decodeBase64url(wrapped[field]);
    changed[0] = changed[0]! ^ 1;
    await refused(unwrapEpochKey({ recipient, owner: owner.public, context, wrapped: { ...wrapped, [field]: encodeBase64url(changed) } }), "authentication_failed");
  }
  await refused(unwrapEpochKey({ recipient, owner: owner.public, context, wrapped: { ...wrapped, signature: "" } }), "invalid_input");
  const substituted = { ...recipient.public, agreementKey: other.public.agreementKey };
  const mismatchedWrap = await wrapEpochKey({ owner, recipient: substituted, context, key });
  await refused(unwrapEpochKey({ recipient, owner: owner.public, context, wrapped: mismatchedWrap }), "authentication_failed");
  await refused(wrapEpochKey({ owner, recipient: { ...recipient.public, agreementKey: encodeBase64url(new Uint8Array(32)) }, context, key }));
});

test("revoked member cannot unwrap a fresh epoch key wrapped only for remaining members", async () => {
  const owner = await generateHubIdentity(), retained = await generateHubIdentity(), revoked = await generateHubIdentity();
  const oldKey = await generateEpochKey(), newKey = await generateEpochKey();
  const oldWrap = await wrapEpochKey({ owner, recipient: revoked.public, context: text("epoch1"), key: oldKey });
  expect(await exportEpochKeyForStorage(await unwrapEpochKey({ recipient: revoked, owner: owner.public, context: text("epoch1"), wrapped: oldWrap })))
    .toEqual(await exportEpochKeyForStorage(oldKey));
  const newWrap = await wrapEpochKey({ owner, recipient: retained.public, context: text("epoch2"), key: newKey });
  await refused(unwrapEpochKey({ recipient: revoked, owner: owner.public, context: text("epoch2"), wrapped: newWrap }), "authentication_failed");
  const nonce = randomBytes(12), context = text("epoch2/sender/roster2");
  const ciphertext = await encryptEpoch({ key: newKey, purpose: "frame", nonce, context, plaintext: text("after revoke") });
  await refused(decryptEpoch({ key: oldKey, purpose: "frame", nonce, context, ciphertext }), "authentication_failed");
});

test("startup failure is cached, sanitized and blocks room security operations", async () => {
  const isolated = await isolatedCrypto();
  const probe = spyOn(crypto.subtle, "digest").mockImplementation(async () => { throw new Error("secret-test-provider-detail"); });
  try {
    await expect(isolated.assertRoomCryptoReady()).rejects.toMatchObject({ code: "unavailable", message: "Room crypto: unavailable" });
    expect(probe).toHaveBeenCalledTimes(1);
  } finally { probe.mockRestore(); }
  await expect(isolated.assertRoomCryptoReady()).rejects.toMatchObject({ code: "unavailable" });
  await expect(isolated.generateHubIdentity()).rejects.toMatchObject({ code: "unavailable" });
  await expect(isolated.hmac(new Uint8Array(32), text("blocked"))).rejects.toMatchObject({ code: "unavailable" });
});


test("room startup refuses an old or unknown runtime before crypto", async () => {
  for (const version of ["1.4.1", "1.3.99", "0.99.99", "unknown"]) {
    const isolated = await isolatedCrypto(`const Bun = { version: ${JSON.stringify(version)} };\n`);
    await expect(isolated.assertRoomCryptoReady()).rejects.toMatchObject({ code: "unavailable" });
    await expect(isolated.generateEpochKey()).rejects.toMatchObject({ code: "unavailable" });
  }
  const absent = await isolatedCrypto("const Bun = undefined;\n");
  await expect(absent.assertRoomCryptoReady()).rejects.toMatchObject({ code: "unavailable" });
});
