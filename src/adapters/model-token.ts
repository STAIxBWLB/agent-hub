/** #844 native model word: no spaces or leading dash, at most 128 ASCII bytes. */
const NATIVE_WORD = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
export function isNativeModelToken(value: unknown): value is string { return typeof value === "string" && NATIVE_WORD.test(value); }
