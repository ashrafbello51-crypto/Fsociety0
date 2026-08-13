// server/uploads.js
// Controlled media handling: validate by file SIGNATURE (not extension/MIME
// spoofing), extract dimensions, strip metadata, optionally optimize via an
// installed image library, and produce safe storage metadata.
const crypto = require('crypto');
const config = require('./config');

const IMAGE_TYPES = {
  'image/jpeg': { ext: 'jpg' },
  'image/png': { ext: 'png' },
  'image/webp': { ext: 'webp' },
  'image/gif': { ext: 'gif' },
};
const DOC_TYPES = {
  'application/pdf': { ext: 'pdf' },
  'text/plain': { ext: 'txt' },
  'text/csv': { ext: 'csv' },
};
// Everything we are willing to accept. SVG and executables are deliberately
// absent. We never trust the client-declared type — detection decides.
const ALLOWED = { ...IMAGE_TYPES, ...DOC_TYPES };

function generateStorageKey(ext) {
  return crypto.randomBytes(32).toString('hex') + '.' + ext;
}

function sanitizeFilename(name) {
  if (!name) return 'file';
  let s = String(name).replace(/\\/g, '/').split('/').pop() || 'file';
  s = s.replace(/[^\w.\-]+/g, '_').slice(0, 200);
  return s || 'file';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------- dimension parsing (pure JS, best-effort) ----------
function pngDims(b) {
  try { return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; } catch { return null; }
}
function jpegDims(b) {
  try {
    for (let i = 2; i < b.length - 9; i++) {
      if (b[i] === 0xff && b[i + 1] >= 0xc0 && b[i + 1] <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(b[i + 1])) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
    }
  } catch {}
  return null;
}
function gifDims(b) {
  try { return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }; } catch { return null; }
}
function webpDims(b) {
  try {
    const fourCC = b.toString('ascii', 12, 16);
    if (fourCC === 'VP8X') {
      const w = (b[20] | (b[21] << 8) | (b[22] << 16)) + 1;
      const h = (b[23] | (b[24] << 8) | (b[25] << 16)) + 1;
      return { width: w, height: h };
    }
    if (fourCC === 'VP8 ') {
      return { width: b.readUInt16LE(19) + 1, height: b.readUInt16LE(21) + 1 };
    }
    if (fourCC === 'VP8L') {
      const wb = (b[17] | (b[18] << 8)) & 0x3fff;
      const hb = ((b[18] >> 6) | (b[19] << 2) | (b[20] << 10)) & 0x3fff;
      return { width: wb + 1, height: hb + 1 };
    }
  } catch {}
  return null;
}

function isTextBuffer(buf) {
  if (buf.includes(0)) return false; // NUL byte => binary, not text
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}
function looksCsv(buf) {
  const head = buf.slice(0, 4096).toString('utf-8');
  const nl = head.indexOf('\n');
  const first = nl > -1 ? head.slice(0, nl) : head;
  return /[,;\t]/.test(first) && nl > -1;
}

// Detect true type from bytes. Returns {mime, kind, ext, dimensions} or null.
function detectType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return { mime: 'image/jpeg', kind: 'image', ext: 'jpg', dimensions: jpegDims(buffer) };
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG' && buffer[7] === 0x0a)
    return { mime: 'image/png', kind: 'image', ext: 'png', dimensions: pngDims(buffer) };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
    return { mime: 'image/webp', kind: 'image', ext: 'webp', dimensions: webpDims(buffer) };
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF89a' || buffer.toString('ascii', 0, 6) === 'GIF87a'))
    return { mime: 'image/gif', kind: 'image', ext: 'gif', dimensions: gifDims(buffer) };
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-')
    return { mime: 'application/pdf', kind: 'document', ext: 'pdf' };
  if (isTextBuffer(buffer))
    return looksCsv(buffer)
      ? { mime: 'text/csv', kind: 'document', ext: 'csv' }
      : { mime: 'text/plain', kind: 'document', ext: 'txt' };
  return null;
}

// ---------- metadata stripping (pure JS, defensive) ----------
function stripJpegMeta(buf) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return buf;
  const keep = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xdb, 0xdc, 0xdd, 0xda, 0xc4, 0xcc]);
  const out = [0xff, 0xd8];
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd9) { out.push(0xff, 0xd9); break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xda) {
      // SOS: copy header, then copy entropy-coded data verbatim until EOI.
      for (let k = i; k < i + len + 2; k++) out.push(buf[k]);
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), i + len + 2);
      const end = eoi === -1 ? buf.length : eoi + 2;
      for (let k = i + len + 2; k < end; k++) out.push(buf[k]);
      break;
    }
    if (keep.has(marker)) { for (let k = i; k < i + len + 2; k++) out.push(buf[k]); }
    i += len + 2;
  }
  return Buffer.from(out);
}
function stripPngMeta(buf) {
  if (!(buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG')) return buf;
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'tRNS', 'bKGD', 'pHYs', 'IEND']);
  let out = buf.slice(0, 8);
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const total = 12 + len;
    if (keep.has(type)) out = Buffer.concat([out, buf.slice(i, i + total)]);
    if (type === 'IEND') break;
    i += total;
  }
  return out;
}

async function optimizeSharp(sharp, buf, detected) {
  let img = sharp(buf, { failOn: 'none' }).rotate().withMetadata({ exif: false, icc: false });
  img = img.resize(1920, 1920, { fit: 'inside', withoutEnlargement: true });
  if (detected.mime === 'image/png') img = img.png({ compressionLevel: 9 });
  else if (detected.mime === 'image/webp') img = img.webp({ quality: 82 });
  else img = img.jpeg({ quality: 82, mozjpeg: true });
  const [out, meta] = await Promise.all([img.toBuffer(), img.metadata()]);
  if (!out || out.length >= buf.length + 2048) return fallbackStrip(buf, detected);
  return { buffer: out, width: meta.width, height: meta.height };
}
async function optimizeJimp(Jimp, buf, detected) {
  const image = await Jimp.read(buf);
  if (image.bitmap.width > 1920 || image.bitmap.height > 1920) image.resize(1920, Jimp.AUTO);
  const mime = detected.mime === 'image/png' ? Jimp.MIME_PNG : Jimp.MIME_JPEG;
  const out = await image.getBufferAsync(mime);
  return { buffer: out, width: image.bitmap.width, height: image.bitmap.height };
}
function fallbackStrip(buf, detected) {
  let out = buf;
  if (detected.mime === 'image/jpeg') out = stripJpegMeta(buf);
  else if (detected.mime === 'image/png') out = stripPngMeta(buf);
  return { buffer: out, width: detected.dimensions?.width, height: detected.dimensions?.height };
}

// Detect + validate + optimize. Throws {status, message} on rejection.
// `declaredMime` is intentionally NOT trusted for type decisions.
async function validateAndProcess(buffer, originalname, declaredMime, userId) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const e = new Error('Empty file'); e.status = 400; throw e;
  }
  const detected = detectType(buffer);
  if (!detected || !ALLOWED[detected.mime]) {
    const e = new Error('Unsupported or unrecognized file type'); e.status = 415; throw e;
  }
  const limit = detected.kind === 'image' ? config.maxImageBytes : config.maxDocBytes;
  if (buffer.length > limit) {
    const e = new Error(`File exceeds the ${detected.kind} size limit (${Math.round(limit / 1048576)}MB)`);
    e.status = 413; throw e;
  }

  let result;
  if (detected.kind === 'image') {
    try {
      const sharp = require('sharp');
      result = await optimizeSharp(sharp, buffer, detected);
    } catch (sharpErr) {
      try {
        const Jimp = require('jimp');
        result = await optimizeJimp(Jimp, buffer, detected);
      } catch {
        result = fallbackStrip(buffer, detected);
      }
    }
  } else {
    result = { buffer, width: null, height: null };
  }

  const optimized = result.buffer || buffer;
  return {
    buffer: optimized,
    mimeType: detected.mime,
    size: optimized.length,
    width: result.width || null,
    height: result.height || null,
    originalFilename: sanitizeFilename(originalname),
    checksum: sha256(optimized),
    storageKey: generateStorageKey(detected.ext),
  };
}

module.exports = { validateAndProcess, detectType, ALLOWED };
