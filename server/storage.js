// server/storage.js
// Pluggable storage backend. The database stores ONLY metadata; binaries live
// here. Local disk is used for development; production swaps in object storage
// via environment variables (never hardcoded credentials).
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Storage keys are opaque random hex (plus a type-derived extension). They are
// never derived from the original filename, so path traversal is impossible.
function assertSafeKey(storageKey) {
  if (typeof storageKey !== 'string' || !/^[a-f0-9]+\.[a-z0-9]+$/.test(storageKey)) {
    throw new Error('Invalid storage key');
  }
  return storageKey;
}

class LocalStorage {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }
  _path(storageKey) {
    // storageKey is validated; joining with an absolute base keeps it inside dir.
    return path.join(this.dir, assertSafeKey(storageKey));
  }
  async save(buffer, { storageKey }) {
    await fs.promises.writeFile(this._path(storageKey), buffer);
    return { storageKey };
  }
  async read(storageKey) {
    return fs.promises.readFile(this._path(storageKey));
  }
  async exists(storageKey) {
    try { await fs.promises.access(this._path(storageKey)); return true; } catch { return false; }
  }
  async delete(storageKey) {
    try { await fs.promises.unlink(this._path(storageKey)); } catch {}
  }
}

// Production object storage. Wiring is config-driven and lazy: the AWS SDK is
// only required if STORAGE_DRIVER=s3. Without the SDK (or misconfiguration)
// operations fail loudly rather than silently writing to the wrong place.
class S3Storage {
  constructor(opts) {
    this.bucket = opts.bucket;
    this.region = opts.region;
    this.client = null;
  }
  _client() {
    if (this.client) return this.client;
    let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand;
    try {
      ({ S3Client } = require('@aws-sdk/client-s3'));
      ({ PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
    } catch {
      throw new Error('S3 storage driver requires @aws-sdk/client-s3 to be installed');
    }
    const creds = {};
    if (process.env.AWS_ACCESS_KEY_ID) creds.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    if (process.env.AWS_SECRET_ACCESS_KEY) creds.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    this._cmd = { PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
    this.client = new S3Client({ region: this.region, credentials: Object.keys(creds).length ? creds : undefined });
    return this.client;
  }
  async save(buffer, { storageKey }) {
    const client = this._client();
    await client.send(new this._cmd.PutObjectCommand({ Bucket: this.bucket, Key: storageKey, Body: buffer }));
    return { storageKey };
  }
  async read(storageKey) {
    const client = this._client();
    const res = await client.send(new this._cmd.GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
  async delete(storageKey) {
    try {
      const client = this._client();
      await client.send(new this._cmd.DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    } catch {}
  }
}

function createStorage() {
  if (config.storageDriver === 's3') {
    const bucket = process.env.S3_BUCKET;
    const region = process.env.S3_REGION || process.env.AWS_REGION;
    if (!bucket || !region) throw new Error('S3 storage requires S3_BUCKET and S3_REGION env vars');
    return new S3Storage({ bucket, region });
  }
  return new LocalStorage(config.uploadsDir);
}

module.exports = { createStorage, LocalStorage, S3Storage, assertSafeKey };
