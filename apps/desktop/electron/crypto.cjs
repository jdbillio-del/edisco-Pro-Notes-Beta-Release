const crypto = require("crypto");

// Envelope format (byte layout)
// - magic: 8 bytes ASCII
// - version: 1 byte
// - scrypt N,r,p: 3x uint32be
// - salt: 16 bytes
// - iv: 12 bytes
// - tag: 16 bytes
// - ciphertext: rest
//
// Notes:
// - We normalize passphrases to NFKC to reduce accidental mismatches.
// - We derive a master key via scrypt, then HKDF subkeys for DB vs file encryption.
const DB_MAGIC = Buffer.from("EDNENC01", "ascii");
const DB_VERSION = 1;

const FILE_MAGIC = Buffer.from("EDNFILE1", "ascii");
const FILE_VERSION = 1;

const DEFAULT_SCRYPT_PARAMS = Object.freeze({
  N: 32768, // 2^15: interactive, reasonably strong on modern desktops
  r: 8,
  p: 1
});

const SALT_LEN = 16;
const IV_LEN = 12; // AES-GCM recommended nonce size
const TAG_LEN = 16; // AES-GCM default tag length

const normalizePassphrase = (passphrase) => {
  if (typeof passphrase !== "string") return "";
  return passphrase.normalize("NFKC");
};

const u32 = (value) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
};

const readU32 = (buf, offset) => buf.readUInt32BE(offset);

const hkdfSubkey = (masterKey, info) => {
  // salt intentionally empty; masterKey already has scrypt salt.
  return crypto.hkdfSync("sha256", masterKey, Buffer.alloc(0), Buffer.from(info, "utf8"), 32);
};

const deriveKeysFromPassphrase = (passphrase, salt, params = DEFAULT_SCRYPT_PARAMS) => {
  const normalized = normalizePassphrase(passphrase);
  const masterKey = crypto.scryptSync(normalized, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    // Keep maxmem conservative but high enough for the chosen params.
    maxmem: 128 * 1024 * 1024
  });

  const dbKey = hkdfSubkey(masterKey, "edisconotes:db");
  const fileKey = hkdfSubkey(masterKey, "edisconotes:files");

  return { masterKey, dbKey, fileKey, kdfSalt: Buffer.from(salt), kdfParams: { ...params } };
};

const aesGcmEncrypt = (key, plaintext, aad) => {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext };
};

const aesGcmDecrypt = (key, iv, tag, ciphertext, aad) => {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

const buildDbHeader = (params, salt, iv) =>
  Buffer.concat([
    DB_MAGIC,
    Buffer.from([DB_VERSION]),
    u32(params.N),
    u32(params.r),
    u32(params.p),
    salt,
    iv
  ]);

const sealDatabaseBytes = (plaintext, vault) => {
  if (!vault?.dbKey || !vault?.kdfSalt || !vault?.kdfParams) {
    throw new Error("Vault not initialized.");
  }

  const header = buildDbHeader(vault.kdfParams, vault.kdfSalt, Buffer.alloc(IV_LEN));
  // We want AAD to cover all header fields; IV is included separately in the final header.
  const { iv, tag, ciphertext } = aesGcmEncrypt(vault.dbKey, plaintext, header.subarray(0, header.length - IV_LEN));
  const fullHeader = buildDbHeader(vault.kdfParams, vault.kdfSalt, iv);
  return Buffer.concat([fullHeader, tag, ciphertext]);
};

const openVaultFromDatabaseEnvelope = (envelopeBytes, passphrase) => {
  const buf = Buffer.from(envelopeBytes);
  const minLen = DB_MAGIC.length + 1 + 12 + SALT_LEN + IV_LEN + TAG_LEN;
  if (buf.length < minLen) {
    throw new Error("Encrypted database is corrupted (too small).");
  }

  const magic = buf.subarray(0, DB_MAGIC.length);
  if (!magic.equals(DB_MAGIC)) {
    throw new Error("Not an eDisco Notes encrypted database.");
  }

  const version = buf.readUInt8(DB_MAGIC.length);
  if (version !== DB_VERSION) {
    throw new Error(`Unsupported encrypted DB version: ${version}`);
  }

  let offset = DB_MAGIC.length + 1;
  const params = {
    N: readU32(buf, offset),
    r: readU32(buf, offset + 4),
    p: readU32(buf, offset + 8)
  };
  offset += 12;

  const salt = buf.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;

  const iv = buf.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;

  const tag = buf.subarray(offset, offset + TAG_LEN);
  offset += TAG_LEN;

  const ciphertext = buf.subarray(offset);
  const vault = deriveKeysFromPassphrase(passphrase, salt, params);

  const aad = buildDbHeader(params, salt, Buffer.alloc(IV_LEN)).subarray(0, DB_MAGIC.length + 1 + 12 + SALT_LEN);
  const plaintext = aesGcmDecrypt(vault.dbKey, iv, tag, ciphertext, aad);
  return { plaintext, vault };
};

const buildFileHeader = (iv) => Buffer.concat([FILE_MAGIC, Buffer.from([FILE_VERSION]), iv]);

const sealFileBytes = (plaintext, fileKey) => {
  const aad = buildFileHeader(Buffer.alloc(IV_LEN));
  const { iv, tag, ciphertext } = aesGcmEncrypt(fileKey, plaintext, aad.subarray(0, aad.length - IV_LEN));
  const header = buildFileHeader(iv);
  return Buffer.concat([header, tag, ciphertext]);
};

const openFileBytes = (envelopeBytes, fileKey) => {
  const buf = Buffer.from(envelopeBytes);
  const minLen = FILE_MAGIC.length + 1 + IV_LEN + TAG_LEN + 1;
  if (buf.length < minLen) {
    throw new Error("Encrypted attachment is corrupted (too small).");
  }
  const magic = buf.subarray(0, FILE_MAGIC.length);
  if (!magic.equals(FILE_MAGIC)) {
    throw new Error("Not an encrypted attachment.");
  }
  const version = buf.readUInt8(FILE_MAGIC.length);
  if (version !== FILE_VERSION) {
    throw new Error(`Unsupported encrypted attachment version: ${version}`);
  }
  let offset = FILE_MAGIC.length + 1;
  const iv = buf.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const tag = buf.subarray(offset, offset + TAG_LEN);
  offset += TAG_LEN;
  const ciphertext = buf.subarray(offset);
  const aad = buildFileHeader(Buffer.alloc(IV_LEN)).subarray(0, FILE_MAGIC.length + 1);
  return aesGcmDecrypt(fileKey, iv, tag, ciphertext, aad);
};

const destroyKeyMaterial = (vault) => {
  if (!vault) return;
  for (const key of [vault.masterKey, vault.dbKey, vault.fileKey]) {
    if (Buffer.isBuffer(key)) {
      key.fill(0);
    }
  }
};

module.exports = {
  DEFAULT_SCRYPT_PARAMS,
  FILE_MAGIC,
  FILE_VERSION,
  IV_LEN,
  TAG_LEN,
  deriveKeysFromPassphrase,
  openVaultFromDatabaseEnvelope,
  sealDatabaseBytes,
  sealFileBytes,
  openFileBytes,
  destroyKeyMaterial
};
