// PBC 页的纯函数：解析表格、找光标所在行、往格子里追加、转义、命名。
// 这里不依赖 Obsidian，方便单独测试。

export const ID_RE = /^([ABC]\d{2})\s+(.+)$/;
export const FEEDBACK_HEADER = "我的反馈";

export interface Row {
  id: string; // 编号，如 A04
  desc: string; // 编号后面的短描述
  feedback: string; // 「我的反馈」格原文（去首尾空白）
  empty: boolean; // 反馈是否算空
  line: number; // 在文件里的行号（0 起；只用来对光标，写入时不用）
  // 以下两个是内部用的：反馈列的位置、多出来的格数（她打了没转义的 | 时）
  col: number;
  extra: number;
}

export interface ParseResult {
  rows: Row[]; // 每个编号只留第一处
  duplicates: string[]; // 出现多次的编号
  loose: Row[]; // 没编号的行（第一格为空或不像编号），只在光标停在上面时才用；id 为空串，desc 是第一格原文
}

interface SplitLine {
  lead: string; // 行首空白
  segs: string[]; // 各格原文（含空格）
  trailPipe: boolean; // 行尾有没有 |
  trail: string; // 行尾空白（含 \r）
}

/** 把一行表格拆成各格原文。不是表格行（不以 | 开头）返回 null。 */
export function splitLine(line: string): SplitLine | null {
  const m = /^(\s*)\|/.exec(line);
  if (!m) return null;
  const lead = m[1];
  let rest = line.slice(m[0].length);
  const trail = /\s*$/.exec(rest)![0];
  rest = rest.slice(0, rest.length - trail.length);
  let trailPipe = false;
  if (rest.endsWith("|") && !rest.endsWith("\\|")) {
    trailPipe = true;
    rest = rest.slice(0, -1);
  }
  // 只按「前面不是反斜杠」的 | 切开
  const segs: string[] = [];
  let cur = "";
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "|" && rest[i - 1] !== "\\") {
      segs.push(cur);
      cur = "";
    } else cur += c;
  }
  segs.push(cur);
  return { lead, segs, trailPipe, trail };
}

function joinLine(s: SplitLine): string {
  return s.lead + "|" + s.segs.join("|") + (s.trailPipe ? "|" : "") + s.trail;
}

const isSeparator = (segs: string[]) => segs.every((s) => /^\s*:?-+:?\s*$/.test(s));

/** 反馈格是否算空：去掉 <br>、&nbsp; 和空白后什么都不剩 */
export function isEmptyFeedback(s: string): boolean {
  return s.replace(/<br\s*\/?>|&nbsp;/gi, "").trim() === "";
}

/** 解析整页：找出所有含「我的反馈」列的表里、以编号开头的行。 */
export function parseRows(text: string): ParseResult {
  const lines = text.split("\n");
  const rows: Row[] = [];
  const loose: Row[] = [];
  const seen = new Set<string>();
  const dup: string[] = [];
  let inFence = false;
  let header: SplitLine | null = null; // 当前表的表头；null 表示不在表里
  let col = -1;
  let nCols = 0;
  let afterHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      header = null;
      continue;
    }
    const sp = inFence ? null : splitLine(line);
    if (!sp) {
      header = null;
      continue;
    }
    if (!header) {
      // 表的第一行就是表头
      header = sp;
      col = sp.segs.findIndex((s) => s.trim() === FEEDBACK_HEADER);
      nCols = sp.segs.length;
      afterHeader = true;
      continue;
    }
    if (afterHeader) {
      afterHeader = false;
      if (isSeparator(sp.segs)) continue;
    }
    if (col < 0) continue; // 这张表没有「我的反馈」列
    const extra = Math.max(0, sp.segs.length - nCols);
    const feedback = sp.segs.slice(col, col + extra + 1).join("|").trim();
    const m = ID_RE.exec(sp.segs[0].trim());
    if (!m) {
      // 没编号的行（她自己加的）：不进列表，只记下来给「光标在这一行」用
      loose.push({ id: "", desc: sp.segs[0].trim(), feedback, empty: isEmptyFeedback(feedback), line: i, col, extra });
      continue;
    }
    if (seen.has(m[1])) {
      if (!dup.includes(m[1])) dup.push(m[1]);
      continue;
    }
    seen.add(m[1]);
    rows.push({ id: m[1], desc: m[2].trim(), feedback, empty: isEmptyFeedback(feedback), line: i, col, extra });
  }
  return { rows, duplicates: dup, loose };
}

/** 光标所在行是不是某个编号行 */
export function findRowAtLine(rows: Row[], line: number): Row | undefined {
  return rows.find((r) => r.line === line);
}

/**
 * 往编号为 id 的那一行「我的反馈」格追加内容。
 * 按编号重新定位，不用行号；只改这一格，原字一字不改。
 * 找不到返回 found=false，文本原样返回。
 */
export function appendToCell(text: string, id: string, addition: string): { text: string; found: boolean } {
  const row = parseRows(text).rows.find((r) => r.id === id);
  if (!row) return { text, found: false };
  return { text: appendAtRow(text, row, addition), found: true };
}

/**
 * 往没编号的行追加。没有编号可定位，所以用「打开窗口那一刻这一行的原文」去找：
 * 这一行原文在整个文件里必须恰好出现一次，且仍是表里没编号的行，否则不写（found=false）。
 */
export function appendToLooseLine(text: string, rawLine: string, addition: string): { text: string; found: boolean } {
  const lines = text.split("\n");
  const hits = lines.filter((l) => l === rawLine).length;
  if (hits !== 1) return { text, found: false };
  const row = parseRows(text).loose.find((r) => lines[r.line] === rawLine);
  if (!row) return { text, found: false };
  return { text: appendAtRow(text, row, addition), found: true };
}

/** 把 addition 接到某一行的「我的反馈」格末尾（只动这一格） */
function appendAtRow(text: string, row: Row, addition: string): string {
  const lines = text.split("\n");
  const sp = splitLine(lines[row.line])!;
  while (sp.segs.length <= row.col) sp.segs.push(""); // 格数不够时补空格
  const old = sp.segs.slice(row.col, row.col + row.extra + 1).join("|");
  const t = old.trim();
  // 空格子或已以 <br> 结尾：直接接；否则先加 <br>
  const sep = t === "" || isEmptyFeedback(t) || /<br\s*\/?>$/i.test(t) ? "" : "<br>";
  const cell = " " + t + sep + addition + " ";
  sp.segs.splice(row.col, row.extra + 1, cell);
  lines[row.line] = joinLine(sp);
  return lines.join("\n");
}

// ---------- 写字 ----------

/** 格子里的文字转义：换行 → <br>；| → \|；其余原样 */
export function escapeCellText(s: string): string {
  return s.replace(/\r\n|\r|\n/g, "<br>").replace(/\|/g, "\\|");
}

/** 写进表格格子的内容：文字在前，嵌入在后，中间一个空格 */
export function composeCell(text: string, embeds: string[]): string {
  const t = escapeCellText(text.trim());
  const e = embeds.join(" ");
  return t && e ? t + " " + e : t + e;
}

/** 写进「其他想说的」的一段：不在表格里，换行直接保留，| 不转义 */
export function composeOther(text: string, embeds: string[]): string {
  const t = text.trim().replace(/\r\n|\r/g, "\n");
  const e = embeds.join(" ");
  return t && e ? t + " " + e : t + e;
}

export const OTHER_HEADING_RE = /^##[ \t]+其他想说的/;

/** 找「## 其他想说的…」小节：返回标题行号和小节结束行号（下一个 # / ## 标题或文件末尾，不含）；没有返回 null */
export function findOtherSection(lines: string[]): { start: number; end: number } | null {
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (start < 0) {
      if (OTHER_HEADING_RE.test(lines[i])) start = i;
    } else if (/^#{1,2}[ \t]/.test(lines[i])) {
      return { start, end: i };
    }
  }
  return start < 0 ? null : { start, end: lines.length };
}

export function hasOtherSection(text: string): boolean {
  return findOtherSection(text.split("\n")) !== null;
}

/** 在「其他想说的」小节末尾追加一个新段落（和上面内容空一行）。没有这个小节返回 found=false。 */
export function appendToOther(text: string, paragraph: string): { text: string; found: boolean } {
  const lines = text.split("\n");
  const sec = findOtherSection(lines);
  if (!sec) return { text, found: false };
  const cr = text.includes("\r\n") ? "\r" : "";
  // 小节里最后一个非空行（至少是标题本身）
  let last = sec.start;
  for (let i = sec.end - 1; i > sec.start; i--) {
    if (lines[i].trim() !== "") { last = i; break; }
  }
  const ins = ["" + cr, ...paragraph.split("\n").map((l) => l + cr)];
  // 紧挨着下一个标题时，段落后面也补一个空行
  if (last + 1 >= sec.end && sec.end < lines.length) ins.push("" + cr);
  lines.splice(last + 1, 0, ...ins);
  return { text: lines.join("\n"), found: true };
}

/** 是不是正在用的 PBC 页：PBC 文件夹顶层、PBC-*.md、不是 -细节.md（子文件夹如 归档/细节 里的都不算） */
export function isPbcPagePath(folder: string, parentPath: string | undefined, name: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  return (
    parentPath !== undefined &&
    norm(parentPath) === norm(folder) &&
    /^PBC-.*\.md$/.test(name) &&
    !name.endsWith("-细节.md")
  );
}

// ---------- 文件名 ----------

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "svg", "tif", "tiff"];

/** 文件名里会破坏表格或链接的字符，一律换成 - */
export function sanitizeFileName(name: string): string {
  const s = name.replace(/[|\[\]#^\\/:*?"<>\r\n\t]/g, "-").trim();
  return s === "" ? "file" : s;
}

/** 拆成 [主名, 扩展名(含点)] */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

export function isImageFile(name: string, mime: string): boolean {
  if (mime.startsWith("image/")) return true;
  return IMAGE_EXTS.includes(splitExt(name)[1].slice(1).toLowerCase());
}

/** 北京时间 YYYYMMDD-HHmmss（北京没有夏令时，直接加 8 小时，不用设备时区） */
export function beijingStamp(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** 图片命名：<编号>-<时间>-<序号>.<原扩展名> */
export function imageName(id: string, stamp: string, seq: number, original: string): string {
  const ext = splitExt(sanitizeFileName(original))[1] || ".jpg";
  return `${id}-${stamp}-${seq}${ext}`;
}

/** 重名时加「 (2)」这类后缀；exists 由调用方提供 */
export function uniqueName(name: string, exists: (n: string) => boolean): string {
  if (!exists(name)) return name;
  const [base, ext] = splitExt(name);
  for (let i = 2; ; i++) {
    const n = `${base} (${i})${ext}`;
    if (!exists(n)) return n;
  }
}

/** 写进格子的嵌入：图片限宽 300（表格里 | 要转义成 \|） */
export function embedFor(name: string, image: boolean, inTable = true): string {
  // 不在表格里（「其他想说的」）时不转义：![[名|300]]
  return image ? `![[${name}${inTable ? "\\|" : "|"}300]]` : `![[${name}]]`;
}

/** 汇报用：「2 张图片、1 个文件」 */
export function summarize(images: number, others: number): string {
  const parts: string[] = [];
  if (images) parts.push(`${images} 张图片`);
  if (others) parts.push(`${others} 个文件`);
  return parts.join("、");
}
