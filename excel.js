const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAX_ENTRIES = 500;
const MAX_UNCOMPRESSED = 8_000_000;
const MAX_FILE = 4_000_000;
const MAX_ROWS = 2000;
const MAX_COLS = 32;
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47]);
const CODEPAGE = {
  936: "gb18030",
  949: "euc-kr",
  950: "big5",
  932: "shift_jis",
  1252: "windows-1252",
  65001: "utf-8",
  1200: "utf-16le",
  54936: "gb18030",
};

export function isExcelName(name) {
  return /\.(xlsx|xlsm|xltx|xltm|xlt|xls|xlsb)$/i.test(String(name || ""));
}

export class ExcelFormatError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export async function readExcelSheets(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 8) throw new ExcelFormatError("empty");
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return sheetsFromZip(bytes);
  if (OLE_MAGIC.every((byte, i) => bytes[i] === byte)) return sheetsFromOle(bytes);
  const text = decodeLoose(bytes);
  if (/urn:schemas-microsoft-com:office:spreadsheet/i.test(text) || /<workbook[\s>]/i.test(text)) {
    return sheetsFromSpreadsheetMl(text);
  }
  if (/<table[\s>]/i.test(text) && /<t[dh][\s>]/i.test(text)) return sheetsFromHtml(text);
  throw new ExcelFormatError("unknown");
}

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeLoose(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  const cjk = (utf8.match(/[\u3400-\u9fff]/g) || []).length;
  if (bad > 0 && cjk === 0) {
    try {
      const gb = new TextDecoder("gb18030").decode(bytes);
      const gbCjk = (gb.match(/[\u3400-\u9fff]/g) || []).length;
      if (gbCjk > cjk) return gb.replace(/^\uFEFF/, "");
    } catch {
      /* keep utf-8 */
    }
  }
  return utf8.replace(/^\uFEFF/, "");
}

function decodeCompressed(bytes, codepage) {
  const encoding = CODEPAGE[codepage] || "windows-1252";
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function assertSafeXml(xml) {
  if (/<!doctype|<!entity/i.test(String(xml).slice(0, 20000))) throw new ExcelFormatError("unsafe-xml");
}

function parseXml(xml) {
  assertSafeXml(xml);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (!doc || doc.documentElement?.localName === "parsererror") throw new ExcelFormatError("bad-xml");
  return doc;
}

function attr(el, name) {
  if (!el) return "";
  const direct = el.getAttribute(name);
  if (direct != null) return direct;
  const attrs = el.attributes;
  if (!attrs) return "";
  for (let i = 0; i < attrs.length; i += 1) {
    if (attrs[i].localName === name) return attrs[i].value;
  }
  return "";
}

function elements(root, name) {
  if (!root) return [];
  return [...root.getElementsByTagNameNS("*", name)];
}

function findEocd(bytes) {
  const start = Math.max(0, bytes.length - (22 + 65535));
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (u32(bytes, i) !== ZIP_EOCD) continue;
    const comment = u16(bytes, i + 20);
    if (i + 22 + comment === bytes.length) return i;
  }
  return -1;
}

async function inflateRaw(bytes, max) {
  if (typeof DecompressionStream !== "function") throw new ExcelFormatError("inflate");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw new ExcelFormatError("too-large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function unzip(bytes) {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new ExcelFormatError("bad-zip");
  const entries = u16(bytes, eocd + 10);
  const cdOffset = u32(bytes, eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new ExcelFormatError("too-large");
  if (entries > MAX_ENTRIES) throw new ExcelFormatError("too-large");
  const files = new Map();
  let cursor = cdOffset;
  let budget = MAX_UNCOMPRESSED;
  for (let n = 0; n < entries && cursor + 46 <= bytes.length; n += 1) {
    if (u32(bytes, cursor) !== ZIP_CENTRAL) break;
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const compSize = u32(bytes, cursor + 20);
    const rawSize = u32(bytes, cursor + 24);
    const nameLen = u16(bytes, cursor + 28);
    const extraLen = u16(bytes, cursor + 30);
    const commentLen = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen)).replace(/\\/g, "/");
    cursor += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new ExcelFormatError("encrypted");
    if (compSize === 0xffffffff || rawSize === 0xffffffff) throw new ExcelFormatError("too-large");
    const lower = name.toLowerCase();
    if (!name || name.endsWith("/") || lower.includes("/media/") || lower.includes("/embeddings/")) continue;
    if (localOffset + 30 > bytes.length) continue;
    if (u32(bytes, localOffset) !== ZIP_LOCAL) continue;
    const localName = u16(bytes, localOffset + 26);
    const localExtra = u16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    const compressed = bytes.subarray(dataStart, dataStart + compSize);
    if (compressed.length < compSize) continue;
    const declared = method === 0 ? compSize : rawSize || MAX_FILE;
    if (declared > MAX_FILE || declared > budget) throw new ExcelFormatError("too-large");
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = await inflateRaw(compressed, Math.min(MAX_FILE, budget));
    else throw new ExcelFormatError("bad-zip");
    budget -= data.length;
    files.set(name.replace(/^\/+/, ""), data);
  }
  if (files.has("EncryptionInfo") || files.has("encryption.xml")) throw new ExcelFormatError("encrypted");
  return files;
}

function textOf(bytes) {
  return bytes ? new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "") : "";
}

function fileBySuffix(files, suffix) {
  const want = suffix.toLowerCase();
  for (const [name, data] of files) {
    if (name.toLowerCase().endsWith(want)) return { name, data };
  }
  return null;
}

function fileGet(files, path) {
  if (!path) return null;
  if (files.has(path)) return files.get(path);
  const lower = path.toLowerCase();
  for (const [name, data] of files) {
    if (name.toLowerCase() === lower) return data;
  }
  return null;
}

function resolvePath(baseFile, target) {
  if (!target) return "";
  const clean = target.replace(/\\/g, "/");
  if (clean.startsWith("/")) return clean.replace(/^\/+/, "");
  const slash = baseFile.lastIndexOf("/");
  const dir = slash >= 0 ? baseFile.slice(0, slash + 1) : "";
  const parts = `${dir}${clean}`.split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function relsPath(part) {
  const slash = part.lastIndexOf("/");
  const dir = slash >= 0 ? part.slice(0, slash) : "";
  const file = slash >= 0 ? part.slice(slash + 1) : part;
  return `${dir}/_rels/${file}.rels`.replace(/^\/+/, "");
}

function isDateFormat(format, id) {
  const num = Number(id);
  if (DATE_FMT_IDS.has(num)) return true;
  if (!format) return false;
  const stripped = String(format).replace(/\[[^\]]*]/g, "").replace(/"[^"]*"/g, "");
  if (!/[yYmdDhHsS年月日时分秒]/.test(stripped)) return false;
  return !/^[#0?,.\s]+$/.test(stripped);
}

function excelSerialToText(serial, date1904) {
  if (!Number.isFinite(serial)) return "";
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
  const ms = epoch + Math.round(serial * 86400000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const frac = Math.abs(serial - Math.trunc(serial));
  if (frac < 1e-8) return day;
  const total = Math.round(frac * 86400);
  return `${day} ${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}`;
}

function richText(el) {
  if (!el) return "";
  let out = "";
  for (const child of el.children) {
    if (child.localName === "t") out += child.textContent || "";
    else if (child.localName === "r") {
      for (const part of child.children) {
        if (part.localName === "t") out += part.textContent || "";
      }
    }
  }
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = parseXml(xml);
  return elements(doc, "si").slice(0, 20000).map((si) => richText(si));
}

function parseStyles(xml) {
  const dates = new Set();
  if (!xml) return dates;
  const doc = parseXml(xml);
  const formats = new Map();
  for (const fmt of elements(doc, "numFmt")) formats.set(attr(fmt, "numFmtId"), attr(fmt, "formatCode"));
  const parent = elements(doc, "cellXfs")[0];
  const xfs = parent ? [...parent.children].filter((el) => el.localName === "xf") : [];
  xfs.forEach((xf, index) => {
    const id = attr(xf, "numFmtId");
    if (isDateFormat(formats.get(id), id)) dates.add(index);
  });
  return dates;
}

function cellText(cell, shared, dates, date1904) {
  const kind = attr(cell, "t") || "n";
  if (kind === "inlineStr") return richText(elements(cell, "is")[0]);
  let raw = "";
  for (const child of cell.children) {
    if (child.localName === "v") {
      raw = child.textContent || "";
      break;
    }
  }
  if (kind === "s") return /^\d+$/.test(raw) ? shared[Number(raw)] || "" : "";
  if (kind === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (kind === "e") return "";
  if (kind === "str") return raw;
  if (kind === "d") return raw.replace("T", " ").replace(/Z$/, "");
  if ((kind === "n" || kind === "") && raw && /^-?\d+(\.\d+)?$/.test(raw)) {
    const style = Number(attr(cell, "s"));
    if (Number.isInteger(style) && dates.has(style)) return excelSerialToText(Number(raw), date1904);
  }
  return raw;
}

function decodeRef(ref) {
  const match = /^([A-Z]{1,3})(\d+)$/.exec(String(ref || "").toUpperCase());
  if (!match) return null;
  let col = 0;
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(match[2]) - 1 };
}

function gridToRows(grid) {
  const indexes = [...grid.keys()].filter((row) => row >= 0 && row < 50000).sort((a, b) => a - b).slice(0, MAX_ROWS);
  return indexes.map((rowIndex) => {
    const cols = grid.get(rowIndex);
    let max = 0;
    for (const col of cols.keys()) max = Math.max(max, col);
    max = Math.min(max, MAX_COLS - 1);
    const row = [];
    for (let col = 0; col <= max; col += 1) row.push(cols.get(col) || "");
    return row;
  });
}

function putCell(grid, row, col, value) {
  if (row < 0 || col < 0 || col >= MAX_COLS || row >= 50000) return;
  if (!grid.has(row) && grid.size >= MAX_ROWS) return;
  if (!grid.has(row)) grid.set(row, new Map());
  grid.get(row).set(col, value);
}

function sheetRows(xml, shared, dates, date1904) {
  const doc = parseXml(xml);
  const grid = new Map();
  const sheetData = elements(doc, "sheetData")[0] || doc;
  let autoRow = 0;
  for (const rowEl of elements(sheetData, "row")) {
    if (rowEl.parentElement && rowEl.parentElement !== sheetData && sheetData !== doc) continue;
    const rowRef = Number(attr(rowEl, "r"));
    const rowIndex = Number.isInteger(rowRef) && rowRef > 0 ? rowRef - 1 : autoRow;
    autoRow = rowIndex + 1;
    let autoCol = 0;
    for (const cell of elements(rowEl, "c")) {
      if (cell.parentElement !== rowEl) continue;
      const pos = decodeRef(attr(cell, "r"));
      const col = pos ? pos.col : autoCol;
      const row = pos ? pos.row : rowIndex;
      autoCol = col + 1;
      putCell(grid, row, col, cellText(cell, shared, dates, date1904));
    }
  }
  return gridToRows(grid);
}

async function sheetsFromZip(bytes) {
  const files = await unzip(bytes);
  const content = fileBySuffix(files, "[content_types].xml");
  const contentText = textOf(content?.data);
  const names = [...files.keys()].map((name) => name.toLowerCase());
  const binaryBook = /sheet\.binary|workbook\.bin/i.test(contentText) || names.some((name) => name.endsWith("workbook.bin"));
  if (binaryBook && !names.some((name) => /\/worksheets\/sheet\d+\.xml$/.test(name))) {
    throw new ExcelFormatError("xlsb");
  }
  const workbook = fileBySuffix(files, "/workbook.xml") || fileBySuffix(files, "workbook.xml");
  if (!workbook || workbook.name.toLowerCase().endsWith(".rels")) throw new ExcelFormatError("unknown");
  const workbookXml = textOf(workbook.data);
  const workbookDoc = parseXml(workbookXml);
  const date1904 = ["1", "true"].includes(attr(elements(workbookDoc, "workbookPr")[0], "date1904"));
  const rels = new Map();
  let sharedTarget = "";
  let stylesTarget = "";
  const relFile = fileGet(files, relsPath(workbook.name));
  if (relFile) {
    for (const rel of elements(parseXml(textOf(relFile)), "Relationship")) {
      const id = attr(rel, "Id");
      const target = resolvePath(workbook.name, attr(rel, "Target"));
      if (id) rels.set(id, target);
      const type = attr(rel, "Type");
      if (type.endsWith("/sharedStrings")) sharedTarget = target;
      if (type.endsWith("/styles")) stylesTarget = target;
    }
  }
  const shared = parseSharedStrings(textOf(fileGet(files, sharedTarget) || fileBySuffix(files, "/sharedstrings.xml")?.data));
  const dates = parseStyles(textOf(fileGet(files, stylesTarget) || fileBySuffix(files, "/styles.xml")?.data));
  const described = elements(workbookDoc, "sheet");
  const sheets = [];
  const seen = new Set();
  for (const sheet of described) {
    const target = rels.get(attr(sheet, "id"));
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const xml = fileGet(files, target);
    if (!xml) continue;
    try {
      sheets.push({ name: attr(sheet, "name"), rows: sheetRows(textOf(xml), shared, dates, date1904) });
    } catch {
      /* skip a chart sheet or a broken worksheet */
    }
    if (sheets.length >= 20) break;
  }
  if (!sheets.length) {
    for (const [name, data] of files) {
      if (!/\/worksheets\/sheet\d+\.xml$/i.test(name)) continue;
      try {
        sheets.push({ name: "", rows: sheetRows(textOf(data), shared, dates, date1904) });
      } catch {
        /* ignore a part that is not a worksheet */
      }
      if (sheets.length >= 20) break;
    }
  }
  if (!sheets.length) throw new ExcelFormatError("unknown");
  return sheets;
}

function sheetsFromHtml(text) {
  if (/<!entity/i.test(String(text).slice(0, 20000))) throw new ExcelFormatError("unsafe-xml");
  const doc = new DOMParser().parseFromString(text, "text/html");
  return [...doc.querySelectorAll("table")].slice(0, 20).map((table, index) => {
    const rows = [...table.rows].map((row) => {
      const out = [];
      let col = 0;
      for (const cell of row.cells) {
        const span = Math.min(Number(cell.colSpan) || 1, MAX_COLS);
        out[col] = cell.textContent || "";
        col += span;
      }
      return out.map((value) => value || "");
    });
    const caption = table.caption?.textContent || table.getAttribute("data-name") || "";
    return { name: caption || (index === 0 ? "" : `Sheet${index + 1}`), rows };
  });
}

function sheetsFromSpreadsheetMl(text) {
  const doc = parseXml(text);
  return elements(doc, "Worksheet").slice(0, 20).map((sheet) => {
    const grid = new Map();
    let autoRow = 0;
    for (const rowEl of elements(sheet, "Row")) {
      const rowRef = Number(attr(rowEl, "Index"));
      const rowIndex = Number.isInteger(rowRef) && rowRef > 0 ? rowRef - 1 : autoRow;
      autoRow = Math.max(autoRow, rowIndex + 1);
      let autoCol = 0;
      for (const cell of elements(rowEl, "Cell")) {
        if (cell.parentElement !== rowEl) continue;
        const colRef = Number(attr(cell, "Index"));
        const col = Number.isInteger(colRef) && colRef > 0 ? colRef - 1 : autoCol;
        autoCol = col + 1;
        const data = elements(cell, "Data")[0];
        let value = data?.textContent || "";
        if ((attr(data, "Type") || "").toLowerCase() === "datetime") value = value.replace("T", " ").replace(/\.\d+(Z)?$/, "");
        putCell(grid, rowIndex, col, value);
      }
    }
    return { name: attr(sheet, "Name"), rows: gridToRows(grid) };
  });
}

function sectorOffset(sec, sectorSize) {
  return (sec + 1) * sectorSize;
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function readFatChain(bytes, fat, start, size, sectorSize) {
  if (!size) return new Uint8Array(0);
  const out = new Uint8Array(size);
  let sec = start;
  let filled = 0;
  const seen = new Set();
  while (sec < 0xfffffff0 && filled < size) {
    if (seen.has(sec)) break;
    seen.add(sec);
    const off = sectorOffset(sec, sectorSize);
    if (off < 0 || off + Math.min(sectorSize, size - filled) > bytes.length) break;
    const take = Math.min(sectorSize, size - filled);
    out.set(bytes.subarray(off, off + take), filled);
    filled += take;
    sec = fat[sec];
  }
  return out;
}

function sheetsFromOle(bytes) {
  if (bytes.length < 512) throw new ExcelFormatError("bad-xls");
  const sectorShift = u16(bytes, 0x1e);
  const sectorSize = 2 ** sectorShift;
  if (sectorSize !== 512 && sectorSize !== 4096) throw new ExcelFormatError("bad-xls");
  const miniSize = 2 ** u16(bytes, 0x20);
  const cutoff = u32(bytes, 0x38) || 4096;
  const difat = [];
  for (let i = 0; i < 109; i += 1) {
    const sec = u32(bytes, 0x4c + i * 4);
    if (sec >= 0xfffffff0) break;
    difat.push(sec);
  }
  let nextDifat = u32(bytes, 0x44);
  let guard = 0;
  while (nextDifat < 0xfffffff0 && guard < 100) {
    guard += 1;
    const off = sectorOffset(nextDifat, sectorSize);
    const count = sectorSize / 4 - 1;
    for (let i = 0; i < count; i += 1) {
      const sec = u32(bytes, off + i * 4);
      if (sec >= 0xfffffff0) break;
      difat.push(sec);
    }
    nextDifat = u32(bytes, off + count * 4);
  }
  const fat = [];
  for (const sec of difat) {
    const off = sectorOffset(sec, sectorSize);
    if (off + sectorSize > bytes.length) continue;
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(u32(bytes, off + i * 4));
  }
  const miniFat = [];
  let miniSec = u32(bytes, 0x3c);
  guard = 0;
  while (miniSec < 0xfffffff0 && guard < 200) {
    guard += 1;
    const off = sectorOffset(miniSec, sectorSize);
    if (off + sectorSize > bytes.length) break;
    for (let i = 0; i < sectorSize / 4; i += 1) miniFat.push(u32(bytes, off + i * 4));
    miniSec = fat[miniSec];
  }
  let dirSec = u32(bytes, 0x30);
  const dirChunks = [];
  const seenDir = new Set();
  while (dirSec < 0xfffffff0 && dirChunks.length < 64) {
    if (seenDir.has(dirSec)) break;
    seenDir.add(dirSec);
    const off = sectorOffset(dirSec, sectorSize);
    if (off + sectorSize > bytes.length) break;
    dirChunks.push(bytes.subarray(off, off + sectorSize));
    dirSec = fat[dirSec];
  }
  const directory = concat(dirChunks);
  const entries = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const entry = directory.subarray(offset, offset + 128);
    const type = entry[66];
    if (!type) continue;
    const nameBytes = u16(entry, 64);
    const chars = nameBytes >= 2 ? (nameBytes - 2) / 2 : 0;
    const name = new TextDecoder("utf-16le").decode(entry.subarray(0, chars * 2));
    const start = u32(entry, 116);
    const size = Number((BigInt(u32(entry, 124)) << 32n) | BigInt(u32(entry, 120)));
    entries.push({ name, type, start, size });
  }
  const root = entries.find((entry) => entry.type === 5);
  if (entries.some((entry) => entry.name === "EncryptedPackage")) throw new ExcelFormatError("encrypted");
  const book = entries.find((entry) => entry.type === 2 && /^workbook$|^book$/i.test(entry.name));
  if (!book) throw new ExcelFormatError("unknown");
  let stream;
  if (book.size >= cutoff || !root) {
    stream = readFatChain(bytes, fat, book.start, book.size, sectorSize);
  } else {
    const miniStream = readFatChain(bytes, fat, root.start, root.size, sectorSize);
    stream = new Uint8Array(book.size);
    let sec = book.start;
    let filled = 0;
    const seen = new Set();
    while (sec < 0xfffffff0 && filled < book.size) {
      if (seen.has(sec)) break;
      seen.add(sec);
      const off = sec * miniSize;
      const take = Math.min(miniSize, book.size - filled);
      if (off + take > miniStream.length) break;
      stream.set(miniStream.subarray(off, off + take), filled);
      filled += take;
      sec = miniFat[sec];
    }
  }
  return sheetsFromBiff(stream);
}

class BiffCursor {
  constructor(records, index, codepage) {
    this.records = records;
    this.index = index;
    this.pos = 0;
    this.current = records[index]?.data || new Uint8Array(0);
    this.codepage = codepage;
  }

  nextContinue() {
    this.index += 1;
    const record = this.records[this.index];
    if (!record || record.type !== 0x003c) throw new ExcelFormatError("bad-xls");
    this.current = record.data;
    this.pos = 0;
  }

  readBytes(count) {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      if (this.pos >= this.current.length) this.nextContinue();
      const take = Math.min(count - filled, this.current.length - this.pos);
      if (!take) throw new ExcelFormatError("bad-xls");
      out.set(this.current.subarray(this.pos, this.pos + take), filled);
      this.pos += take;
      filled += take;
    }
    return out;
  }

  readU8() {
    return this.readBytes(1)[0];
  }

  readU16() {
    const bytes = this.readBytes(2);
    return bytes[0] | (bytes[1] << 8);
  }

  readU32() {
    const bytes = this.readBytes(4);
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  }

  readChars(count, wide) {
    let text = "";
    let left = count;
    let isWide = wide;
    while (left > 0) {
      if (this.pos >= this.current.length) {
        this.nextContinue();
        isWide = (this.readU8() & 1) !== 0;
        continue;
      }
      const bytesPer = isWide ? 2 : 1;
      const avail = Math.floor((this.current.length - this.pos) / bytesPer);
      if (!avail) {
        this.nextContinue();
        isWide = (this.readU8() & 1) !== 0;
        continue;
      }
      const take = Math.min(left, avail);
      const raw = this.current.subarray(this.pos, this.pos + take * bytesPer);
      this.pos += take * bytesPer;
      text += isWide ? new TextDecoder("utf-16le").decode(raw) : decodeCompressed(raw, this.codepage);
      left -= take;
    }
    return text;
  }
}

function readUnicode(cursor) {
  const count = cursor.readU16();
  if (count > 20000) throw new ExcelFormatError("too-large");
  const flags = cursor.readU8();
  const rich = (flags & 0x8) !== 0;
  const ext = (flags & 0x4) !== 0;
  const runs = rich ? cursor.readU16() : 0;
  const extSize = ext ? cursor.readU32() : 0;
  const text = cursor.readChars(count, (flags & 0x1) !== 0);
  if (runs) cursor.readBytes(runs * 4);
  if (extSize) cursor.readBytes(extSize);
  return text;
}

function readShortName(data, offset, codepage) {
  const count = data[offset] || 0;
  const flags = data[offset + 1] || 0;
  const wide = (flags & 1) !== 0;
  const raw = data.subarray(offset + 2, offset + 2 + count * (wide ? 2 : 1));
  if (!count || raw.length < count * (wide ? 2 : 1)) return "";
  return wide ? new TextDecoder("utf-16le").decode(raw) : decodeCompressed(raw, codepage);
}

function decodeRk(rk) {
  const signed = rk | 0;
  let value;
  if ((signed & 2) !== 0) value = signed >> 2;
  else {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(4, rk & 0xfffffffc, true);
    value = view.getFloat64(0, true);
  }
  if ((rk & 1) !== 0) value /= 100;
  return value;
}

function numberText(value, xf, formats, date1904) {
  if (!Number.isFinite(value)) return "";
  const formatId = xf >= 0 ? formats.xf[xf] : undefined;
  if (isDateFormat(formats.custom.get(formatId), formatId)) return excelSerialToText(value, date1904);
  if (Math.abs(value - Math.round(value)) < 1e-8 && Math.abs(value) < 1e15) return String(Math.round(value));
  return String(value);
}

function readRecords(bytes) {
  const records = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && records.length < 200000) {
    const type = u16(bytes, offset);
    const len = u16(bytes, offset + 2);
    const data = bytes.subarray(offset + 4, offset + 4 + len);
    if (data.length < len) break;
    records.push({ type, data });
    offset += 4 + len;
  }
  return records;
}

function sheetsFromBiff(bytes) {
  const records = readRecords(bytes);
  let codepage = 1252;
  let date1904 = false;
  const formats = { custom: new Map(), xf: [] };
  const bounds = [];
  const strings = [];
  const sheets = [];
  let nameCursor = 0;
  let current = null;
  let pending = null;
  let sawBof = false;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const data = record.data;
    if (record.type === 0x0809) {
      if (!sawBof) {
        sawBof = true;
        if (u16(data, 0) !== 0x0600) throw new ExcelFormatError("oldxls");
      }
      const kind = u16(data, 2);
      if (kind === 0x0010) {
        while (nameCursor < bounds.length && bounds[nameCursor].dt !== 0) nameCursor += 1;
        const name = bounds[nameCursor]?.name || "";
        nameCursor += 1;
        current = { name, grid: new Map() };
        sheets.push(current);
        if (sheets.length > 20) break;
      } else current = null;
      continue;
    }
    if (record.type === 0x0042 && data.length >= 2) codepage = u16(data, 0);
    else if (record.type === 0x0022 && data.length >= 2) date1904 = u16(data, 0) === 1;
    else if (record.type === 0x041e && data.length >= 2) {
      const cursor = new BiffCursor(records, i, codepage);
      cursor.pos = 2;
      const id = u16(data, 0);
      try {
        formats.custom.set(id, readUnicode(cursor));
      } catch {
        /* a format string is optional for the built-in date ids */
      }
      i = cursor.index;
    } else if (record.type === 0x00e0 && data.length >= 4) formats.xf.push(u16(data, 2));
    else if (record.type === 0x0085) bounds.push({ name: readShortName(data, 6, codepage), dt: data[5] });
    else if (record.type === 0x00fc) {
      const cursor = new BiffCursor(records, i, codepage);
      cursor.readU32();
      const unique = cursor.readU32();
      const count = Math.min(unique, 20000);
      for (let n = 0; n < count; n += 1) strings.push(readUnicode(cursor));
      i = cursor.index;
    } else if (current && record.type === 0x00fd && data.length >= 10) {
      putCell(current.grid, u16(data, 0), u16(data, 2), strings[u32(data, 6)] || "");
    } else if (current && record.type === 0x0204) {
      const cursor = new BiffCursor(records, i, codepage);
      const row = cursor.readU16();
      const col = cursor.readU16();
      cursor.readU16();
      putCell(current.grid, row, col, readUnicode(cursor));
      i = cursor.index;
    } else if (current && record.type === 0x0203 && data.length >= 14) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      putCell(current.grid, u16(data, 0), u16(data, 2), numberText(view.getFloat64(6, true), u16(data, 4), formats, date1904));
    } else if (current && record.type === 0x027e && data.length >= 10) {
      putCell(current.grid, u16(data, 0), u16(data, 2), numberText(decodeRk(u32(data, 6)), u16(data, 4), formats, date1904));
    } else if (current && record.type === 0x00bd && data.length >= 10) {
      const row = u16(data, 0);
      const first = u16(data, 2);
      const groups = Math.floor((data.length - 6) / 6);
      for (let n = 0; n < groups; n += 1) {
        const xf = u16(data, 4 + n * 6);
        const rk = u32(data, 6 + n * 6);
        putCell(current.grid, row, first + n, numberText(decodeRk(rk), xf, formats, date1904));
      }
    } else if (current && record.type === 0x0006 && data.length >= 14) {
      const row = u16(data, 0);
      const col = u16(data, 2);
      if (u16(data, 6) === 0xffff && data[8] === 0) pending = { row, col };
      else if (u16(data, 6) !== 0xffff) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        putCell(current.grid, row, col, numberText(view.getFloat64(6, true), u16(data, 4), formats, date1904));
      }
    } else if (current && pending && record.type === 0x0207) {
      const cursor = new BiffCursor(records, i, codepage);
      putCell(current.grid, pending.row, pending.col, readUnicode(cursor));
      pending = null;
      i = cursor.index;
    }
  }
  if (!sawBof) throw new ExcelFormatError("bad-xls");
  return sheets.filter((sheet) => sheet.grid.size).map((sheet) => ({ name: sheet.name, rows: gridToRows(sheet.grid) }));
}
