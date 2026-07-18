const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const randomToken = (bytes = 32): string => {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);

  return base64UrlEncode(values);
};

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const base64UrlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export const base64UrlDecode = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const encodeKey = (value: string): string => base64UrlEncode(textEncoder.encode(value));

export const decodeKey = (value: string): string => textDecoder.decode(base64UrlDecode(value));

export const encryptSecret = async (value: string, secret: string): Promise<string> => {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importAesKey(secret);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(value));

  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
};

export const decryptSecret = async (value: string, secret: string): Promise<string> => {
  const [ivValue, encryptedValue] = value.split('.');

  if (!ivValue || !encryptedValue) {
    throw new Error('Invalid encrypted value.');
  }

  const key = await importAesKey(secret);
  const iv = base64UrlDecode(ivValue);
  const encrypted = base64UrlDecode(encryptedValue);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encrypted),
  );

  return textDecoder.decode(decrypted);
};

export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const importAesKey = async (secret: string): Promise<CryptoKey> => {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));

  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  return buffer;
};
