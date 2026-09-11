
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

const loadKey = () => {
    const raw = (process.env.DATA_ENCRYPTION_KEY || '').trim();
    if (!raw) return null;
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error('DATA_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
    }
    return Buffer.from(raw, 'hex');
};

const KEY = loadKey();

const isConfigured = () => KEY !== null;

/** Whether a stored value is one of ours (as opposed to legacy plaintext). */
const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/**
 * Encrypt a string for storage. Empty/undefined values are returned unchanged
 * (there is nothing to protect, and `''` is the schema default).
 * Without a key the value is returned as-is  index.js refuses to boot in
 * production in that state, so this only happens in local development.
 */
const encrypt = (plaintext) => {
    if (plaintext === undefined || plaintext === null || plaintext === '') return plaintext;
    if (!KEY) return String(plaintext);
    const value = String(plaintext);
    if (isEncrypted(value)) return value; // never double-encrypt

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, KEY, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${PREFIX}${iv.toString('base64')}:${ciphertext.toString('base64')}:${tag.toString('base64')}`;
};

/**
 * Decrypt a stored value. Legacy plaintext passes through untouched.
 * Throws if the value is encrypted and the key is missing or wrong  callers
 * that only need to *display* something should catch and mask.
 */
const decrypt = (stored) => {
    if (!isEncrypted(stored)) return stored;
    if (!KEY) {
        throw new Error('DATA_ENCRYPTION_KEY is not set but an encrypted value was read.');
    }

    const parts = stored.slice(PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('Malformed encrypted value.');

    const [ivB64, dataB64, tagB64] = parts;
    const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
    ]);
    return plaintext.toString('utf8');
};

/**
 * Best-effort decrypt for display paths: returns '' instead of throwing, so a
 * key rotation mistake degrades to a blank field rather than a 500.
 */
const decryptOrBlank = (stored) => {
    try {
        return decrypt(stored) || '';
    } catch (err) {
        console.error('[field-crypto] could not decrypt value:', err.message);
        return '';
    }
};

/** `••••1234`  what we keep once the full number is no longer needed. */
const maskIdentifier = (value) => {
    const raw = String(value || '');
    return raw.length > 4 ? `••••${raw.slice(-4)}` : '';
};

module.exports = { encrypt, decrypt, decryptOrBlank, isEncrypted, isConfigured, maskIdentifier, PREFIX };
