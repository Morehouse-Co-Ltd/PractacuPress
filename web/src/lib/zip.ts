/**
 * 最小 ZIP 读写器（主题包专用）。
 *
 * 为什么自己写：主题包需要在浏览器里组装与解析，而仓库不引入第三方 zip 依赖。
 * 写入只用 STORE（不压缩），读取同时支持 STORE 与 Deflate——Windows 资源管理器、
 * PowerShell 的 Compress-Archive 默认写 Deflate，必须能读。
 *
 * 边界：
 * - 不写 ZIP64；单个包与单文件都受调用方上限约束（主题包 ≤32 MiB）；
 * - 不读加密条目、不跟随符号链接；
 * - 文件名按 UTF-8 处理（通用标志位 bit 11），拒绝绝对路径与 `..`。
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipInputEntry {
  name: string;
  data: Uint8Array | string;
}

export interface ZipLimits {
  /** 条目数上限。 */
  maxEntries?: number;
  /** 解压后总量上限（字节）。 */
  maxBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 600;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const next = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    next[i] = value >>> 0;
  }
  crcTable = next;
  return next;
}

export function crc32(data: Uint8Array): number {
  const lookup = table();
  let value = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    value = lookup[(value ^ data[i]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function encoded(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

/** 校验条目名：拒绝空名、绝对路径、`..`、反斜杠与控制字符。 */
export function safeZipName(name: string): string {
  const value = name.replace(/\\/g, '/').trim();
  if (!value) throw new Error('主题包里有空文件名。');
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    throw new Error(`主题包里的路径不能是绝对路径：${name}`);
  }
  if (value.split('/').some((segment) => segment === '..' || segment === '.' || !segment)) {
    throw new Error(`主题包里的路径不合法：${name}`);
  }
  if (/[\u0000-\u001f]/.test(value)) {
    throw new Error(`主题包里的文件名包含控制字符：${name}`);
  }
  return value;
}

function dosDateTime(date: Date): { time: number; day: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, day: day & 0xffff };
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/** 组装一个 ZIP。全部条目使用 STORE，浏览器不需要压缩库。 */
export function createZip(entries: ZipInputEntry[], now = new Date()): Blob {
  const prepared: ZipEntry[] = entries.map((entry) => ({
    name: safeZipName(entry.name),
    data: typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data,
  }));
  const { time, day } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of prepared) {
    const name = encoded(entry.name);
    const checksum = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    writeU32(view, 0, LOCAL_SIG);
    writeU16(view, 4, 20);
    writeU16(view, 6, FLAG_UTF8);
    writeU16(view, 8, METHOD_STORE);
    writeU16(view, 10, time);
    writeU16(view, 12, day);
    writeU32(view, 14, checksum);
    writeU32(view, 18, entry.data.length);
    writeU32(view, 22, entry.data.length);
    writeU16(view, 26, name.length);
    writeU16(view, 28, 0);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    writeU32(headerView, 0, CENTRAL_SIG);
    writeU16(headerView, 4, 20);
    writeU16(headerView, 6, 20);
    writeU16(headerView, 8, FLAG_UTF8);
    writeU16(headerView, 10, METHOD_STORE);
    writeU16(headerView, 12, time);
    writeU16(headerView, 14, day);
    writeU32(headerView, 16, checksum);
    writeU32(headerView, 20, entry.data.length);
    writeU32(headerView, 24, entry.data.length);
    writeU16(headerView, 28, name.length);
    writeU16(headerView, 30, 0);
    writeU16(headerView, 32, 0);
    writeU16(headerView, 34, 0);
    writeU16(headerView, 36, 0);
    writeU32(headerView, 38, 0);
    writeU32(headerView, 42, offset);
    header.set(name, 46);

    chunks.push(local, entry.data);
    central.push(header);
    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, EOCD_SIG);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, prepared.length);
  writeU16(endView, 10, prepared.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, offset);
  writeU16(endView, 20, 0);

  // 拼成一个连续的 Uint8Array 再交给 Blob：BlobPart 不接受带 ArrayBufferLike
  // 泛型的视图，而逐个传又会依赖实现细节。
  const parts = [...chunks, ...central, end];
  const total = parts.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return new Blob([output.buffer as ArrayBuffer], { type: 'application/zip' });
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Stream = (
    globalThis as unknown as { DecompressionStream?: new (format: string) => unknown }
  ).DecompressionStream;
  if (!Stream) {
    throw new Error('当前浏览器不支持解压 Deflate 主题包；请用 STORE 方式重新打包，或升级浏览器。');
  }
  const stream = new Stream('deflate-raw') as {
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
  };
  const writer = stream.writable.getWriter();
  void writer.write(data);
  void writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

function findEnd(view: DataView): number {
  const start = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIG) return offset;
  }
  throw new Error('不是有效的 zip 文件（找不到目录结尾）。');
}

/** 读取一个 ZIP。Deflate 条目通过浏览器内置的 DecompressionStream 解压。 */
export async function readZip(
  input: Blob | ArrayBuffer | Uint8Array,
  limits: ZipLimits = {},
): Promise<ZipEntry[]> {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const buffer =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(await input.arrayBuffer());
  if (buffer.length < 22) throw new Error('文件太小，不是有效的 zip。');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const end = findEnd(view);
  const count = view.getUint16(end + 10, true);
  if (count > maxEntries) throw new Error(`主题包文件过多（${count} > ${maxEntries}）。`);
  const centralOffset = view.getUint32(end + 16, true);
  let cursor = centralOffset;
  let total = 0;
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || view.getUint32(cursor, true) !== CENTRAL_SIG) {
      throw new Error('zip 目录损坏。');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (flags & 0x1) throw new Error('主题包里有加密条目，无法读取。');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 主题包。');
    }
    const rawName = buffer.slice(cursor + 46, cursor + 46 + nameLength);
    const name = safeZipName(decoder.decode(rawName));

    if (localOffset + 30 > buffer.length || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`zip 条目损坏：${name}`);
    }
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const endData = start + compressed;
    if (endData > buffer.length) throw new Error(`zip 条目越界：${name}`);
    const raw = buffer.slice(start, endData);

    let data: Uint8Array;
    if (method === METHOD_STORE) {
      data = raw;
    } else if (method === METHOD_DEFLATE) {
      data = await inflateRaw(raw);
    } else {
      throw new Error(`不支持的压缩方式（${method}）：${name}`);
    }
    if (data.length !== uncompressed) {
      throw new Error(`zip 条目大小不一致：${name}`);
    }
    total += data.length;
    if (total > maxBytes) throw new Error(`主题包解压后过大（超过 ${maxBytes} 字节）。`);
    if (!name.endsWith('/')) entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
