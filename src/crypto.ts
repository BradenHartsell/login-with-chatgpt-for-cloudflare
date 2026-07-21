const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function signSessionId(value: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return `${value}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySessionId(signed: string, secret: string): Promise<string | undefined> {
  const separator = signed.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const value = signed.slice(0, separator);
  const signature = safeDecode(signed.slice(separator + 1));
  if (!signature) return undefined;
  const key = await importHmacKey(secret);
  return (await crypto.subtle.verify("HMAC", key, signature, encoder.encode(value))) ? value : undefined;
}

export async function encryptJson(value: unknown, secret: string, context: string): Promise<string> {
  const key = await importEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptJson(secret: string, context: string, payload: string): Promise<unknown | undefined> {
  const [ivPart, ciphertextPart] = payload.split(".");
  if (!ivPart || !ciphertextPart) return undefined;
  const iv = safeDecode(ivPart);
  const ciphertext = safeDecode(ciphertextPart);
  if (!iv || !ciphertext) return undefined;
  try {
    const key = await importEncryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      key,
      ciphertext,
    );
    return JSON.parse(decoder.decode(plaintext)) as unknown;
  } catch {
    return undefined;
  }
}

export function randomSessionId(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const material = await deriveKeyMaterial(secret, "cookie-signing-v1");
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function importEncryptionKey(secret: string): Promise<CryptoKey> {
  const material = await deriveKeyMaterial(secret, "token-encryption-v1");
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function deriveKeyMaterial(secret: string, purpose: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(`${purpose}\0${secret}`));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeDecode(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}
