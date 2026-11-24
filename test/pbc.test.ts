import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRows, findRowAtLine, appendToCell, sanitizeFileName, imageName, uniqueName,
  beijingStamp, embedFor, isImageFile, summarize,
  escapeCellText, composeCell, composeOther, appendToLooseLine, appendToOther, hasOtherSection, isPbcPagePath,
} from "../src/pbc";

// 全部是编造的样例
const PAGE = [
  "# PBC 清单",
  "",
  "## 要你回的问题",
  "",
  "| 问题 | 我的反馈 | 建议 |",
  "|---|---|---|",
  "| C01 退款是哪一单？ |  | 按建议办 |",
  "",
  "## 蓝鲸支付",
  "",
  "| 要什么 | 我的反馈 | 备注 |",
  "|---|---|---|",
  "| A02 账单 CSV |  |  |",
  "| B05 余额页截图 | ![[old.png\\|300]] |  |",
  "| A03 账单 Excel | 发邮箱 | 备注字 |",
  "| 她自己加的一行 | 随手写 | |",
  "",
  "其他文字 | 带竖线 | 不是表",
  "",
  "## 无反馈列",
  "",
  "| 名 | 值 |",
  "|---|---|",
  "| A09 不该被认出 | x |",
].join("\n");

test("解析：多张表、跳过无反馈列的表和表外文字", () => {
  const { rows, duplicates } = parseRows(PAGE);
  assert.deepEqual(rows.map((r) => r.id), ["C01", "A02", "B05", "A03"]);
  assert.deepEqual(duplicates, []);
  assert.equal(rows[0].desc, "退款是哪一单？");
  assert.equal(rows[0].empty, true);
  assert.equal(rows[2].empty, false);
  assert.equal(rows[3].feedback, "发邮箱");
});

test("光标所在行", () => {
  const { rows } = parseRows(PAGE);
  const lines = PAGE.split("\n");
  const ln = lines.findIndex((l) => l.startsWith("| B05"));
  assert.equal(findRowAtLine(rows, ln)?.id, "B05");
  assert.equal(findRowAtLine(rows, 0), undefined);
});

test("编号重复只取第一处并报告", () => {
  const t = "| 要什么 | 我的反馈 | 备注 |\n|---|---|---|\n| A01 一 |  |  |\n| A01 二 |  |  |";
  const r = parseRows(t);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].desc, "一");
  assert.deepEqual(r.duplicates, ["A01"]);
  const out = appendToCell(t, "A01", "X").text.split("\n");
  assert.ok(out[2].includes("X"));
  assert.ok(!out[3].includes("X"));
});

test("空格子：直接写入，其它格和其它行不动", () => {
  const { text, found } = appendToCell(PAGE, "A02", "![[a.png\\|300]]");
  assert.ok(found);
  const a = PAGE.split("\n"), b = text.split("\n");
  b.forEach((l, i) => {
    if (a[i].startsWith("| A02")) assert.equal(l, "| A02 账单 CSV | ![[a.png\\|300]] |  |");
    else assert.equal(l, a[i]);
  });
});

test("已有图片：用 <br> 接在后面，原字不动", () => {
  const { text } = appendToCell(PAGE, "B05", "![[n.png\\|300]]");
  assert.ok(text.includes("| B05 余额页截图 | ![[old.png\\|300]]<br>![[n.png\\|300]] |  |"));
});

test("已有文字和备注格：只改反馈格", () => {
  const { text } = appendToCell(PAGE, "A03", "![[f.xlsx]]");
  assert.ok(text.includes("| A03 账单 Excel | 发邮箱<br>![[f.xlsx]] | 备注字 |"));
});

test("已以 <br> 结尾或只有 <br>：不重复加", () => {
  const t = "| 要什么 | 我的反馈 | 备注 |\n|---|---|---|\n| A01 一 | 字<br> |  |\n| A02 二 | <br> |  |";
  const r1 = appendToCell(t, "A01", "X").text;
  assert.ok(r1.includes("| A01 一 | 字<br>X |  |"));
  const r2 = appendToCell(t, "A02", "Y").text;
  assert.ok(r2.includes("| A02 二 | <br>Y |  |"));
});

test("格子里有 \\| 和未转义 |：不破坏", () => {
  const t = "| 要什么 | 我的反馈 | 备注 |\n|---|---|---|\n| A01 一 | a\\|b | n |\n| A02 二 | x|y | n |";
  const r1 = appendToCell(t, "A01", "X").text;
  assert.ok(r1.includes("| A01 一 | a\\|b<br>X | n |"));
  const r2 = appendToCell(t, "A02", "Y").text;
  assert.ok(r2.includes("| A02 二 | x|y<br>Y | n |"));
  assert.equal(parseRows(t).rows[1].feedback, "x|y");
});

test("连续追加两次", () => {
  let t = appendToCell(PAGE, "A02", "![[1.png\\|300]]").text;
  t = appendToCell(t, "A02", "![[2.png\\|300]]").text;
  assert.ok(t.includes("| A02 账单 CSV | ![[1.png\\|300]]<br>![[2.png\\|300]] |  |"));
});

test("找不到编号：原样返回", () => {
  const r = appendToCell(PAGE, "A99", "X");
  assert.equal(r.found, false);
  assert.equal(r.text, PAGE);
});

test("CRLF 换行也能用", () => {
  const t = PAGE.replace(/\n/g, "\r\n");
  const r = appendToCell(t, "A02", "X");
  assert.ok(r.text.includes("| A02 账单 CSV | X |  |\r\n"));
});

test("文件名转义与命名", () => {
  assert.equal(sanitizeFileName("a|b]c[d#e^f.xlsx"), "a-b-c-d-e-f.xlsx");
  assert.equal(sanitizeFileName("蓝鲸 11月账单.csv"), "蓝鲸 11月账单.csv");
  assert.equal(imageName("A04", "20261124-231500", 2, "IMG_1.HEIC"), "A04-20261124-231500-2.HEIC");
  assert.equal(imageName("A04", "s", 1, "无扩展名"), "A04-s-1.jpg");
  assert.equal(embedFor("a.png", true), "![[a.png\\|300]]");
  assert.equal(embedFor("账单.xlsx", false), "![[账单.xlsx]]");
});

test("重名加后缀（中文名）", () => {
  const have = new Set(["账单.csv", "账单 (2).csv"]);
  assert.equal(uniqueName("账单.csv", (n) => have.has(n)), "账单 (3).csv");
  assert.equal(uniqueName("新.csv", (n) => have.has(n)), "新.csv");
});

test("北京时间：与设备时区无关", () => {
  // UTC 2026-11-24 16:05:09 = 北京 2026-11-25 00:05:09
  assert.equal(beijingStamp(Date.UTC(2026, 10, 24, 16, 5, 9)), "20261125-000509");
});

test("图片判断与汇报文字", () => {
  assert.ok(isImageFile("x.HEIC", ""));
  assert.ok(isImageFile("noext", "image/jpeg"));
  assert.ok(!isImageFile("a.xlsx", "application/vnd.ms-excel"));
  assert.equal(summarize(2, 1), "2 张图片、1 个文件");
  assert.equal(summarize(0, 3), "3 个文件");
});


// ---------- 0.2.0：写字、其他想说的、无编号行、页面判定 ----------

test("文字转义：换行变 <br>，| 变 \\|，其余原样", () => {
  assert.equal(escapeCellText("第一行\n第二行"), "第一行<br>第二行");
  assert.equal(escapeCellText("第一行\r\n第二行"), "第一行<br>第二行");
  assert.equal(escapeCellText("a|b"), "a\\|b");
  assert.equal(escapeCellText("*原样* [x] #y"), "*原样* [x] #y");
});

test("文字 + 嵌入一起写：文字在前，一个空格隔开", () => {
  const c = composeCell("发你邮箱了\n请查收", ["![[A02-1.png\\|300]]", "![[账单.csv]]"]);
  assert.equal(c, "发你邮箱了<br>请查收 ![[A02-1.png\\|300]] ![[账单.csv]]");
  const { text } = appendToCell(PAGE, "B05", c);
  assert.ok(text.includes("| B05 余额页截图 | ![[old.png\\|300]]<br>发你邮箱了<br>请查收 ![[A02-1.png\\|300]] ![[账单.csv]] |  |"));
});

test("只写文字 / 只写嵌入", () => {
  const { text } = appendToCell(PAGE, "A02", composeCell("a|b", []));
  assert.ok(text.includes("| A02 账单 CSV | a\\|b |  |"));
  assert.equal(composeCell("", ["![[x.csv]]"]), "![[x.csv]]");
  // 格子里有字时原字不动
  assert.ok(appendToCell(PAGE, "A03", "补一句").text.includes("| A03 账单 Excel | 发邮箱<br>补一句 | 备注字 |"));
});

const OTHER_MID = ["# 页", "", "## 其他想说的（有什么都写这）", "", "旧的一段", "", "## 后面的小节", "内容"].join("\n");
const OTHER_END = ["# 页", "", "## 其他想说的", "", "旧的一段", ""].join("\n");

test("其他想说的：小节在中间，标题带括号", () => {
  assert.ok(hasOtherSection(OTHER_MID));
  const r = appendToOther(OTHER_MID, composeOther("你好\n第二行|不转义", ["![[其他-1.png|300]]"]));
  assert.ok(r.found);
  assert.equal(r.text, ["# 页", "", "## 其他想说的（有什么都写这）", "", "旧的一段", "", "你好", "第二行|不转义 ![[其他-1.png|300]]", "", "## 后面的小节", "内容"].join("\n"));
});

test("其他想说的：小节在末尾（有无结尾换行）", () => {
  const r = appendToOther(OTHER_END, "新的");
  assert.equal(r.text, ["# 页", "", "## 其他想说的", "", "旧的一段", "", "新的", ""].join("\n"));
  const r2 = appendToOther("## 其他想说的", "新的");
  assert.equal(r2.text, "## 其他想说的\n\n新的");
  // 紧挨着下一个标题时补空行
  const r3 = appendToOther("## 其他想说的\n## 下一节", "新的");
  assert.equal(r3.text, "## 其他想说的\n\n新的\n\n## 下一节");
});

test("其他想说的：没有这个小节就不写", () => {
  assert.equal(hasOtherSection(PAGE), false);
  const r = appendToOther(PAGE, "x");
  assert.equal(r.found, false);
  assert.equal(r.text, PAGE);
  // 代码块里的假标题不算
  assert.equal(hasOtherSection("```\n## 其他想说的\n```"), false);
});

test("无编号行：解析出来但不进编号列表", () => {
  const p = parseRows(PAGE);
  assert.equal(p.rows.some((r) => r.desc.includes("她自己加")), false);
  assert.deepEqual(p.loose.map((r) => r.desc), ["她自己加的一行"]);
  const ln = PAGE.split("\n").findIndex((l) => l.startsWith("| 她自己"));
  assert.equal(findRowAtLine(p.loose, ln)?.line, ln);
});

test("无编号行：原文恰好出现一次才写", () => {
  const raw = "| 她自己加的一行 | 随手写 | |";
  const r = appendToLooseLine(PAGE, raw, composeCell("补一句", ["![[补充-1.png\\|300]]"]));
  assert.ok(r.found);
  assert.ok(r.text.includes("| 她自己加的一行 | 随手写<br>补一句 ![[补充-1.png\\|300]] | |"));
  // 第一格为空的行
  const t = "| 要什么 | 我的反馈 | 备注 |\n|---|---|---|\n|  |  | 空行 |";
  assert.ok(appendToLooseLine(t, "|  |  | 空行 |", "X").text.includes("|  | X | 空行 |"));
});

test("无编号行：不唯一、已被改过都不写", () => {
  const dupe = PAGE + "\n\n| 要什么 | 我的反馈 |\n|---|---|\n| 她自己加的一行 | 随手写 | |";
  const r1 = appendToLooseLine(dupe, "| 她自己加的一行 | 随手写 | |", "X");
  assert.equal(r1.found, false);
  assert.equal(r1.text, dupe);
  const r2 = appendToLooseLine(PAGE, "| 她自己加的一行 | 改过了 | |", "X");
  assert.equal(r2.found, false);
  assert.equal(r2.text, PAGE);
  // 有编号的行不能当无编号行写
  assert.equal(appendToLooseLine(PAGE, "| A02 账单 CSV |  |  |", "X").found, false);
});

test("页面判定：顶层 PBC-*、-细节、归档子文件夹、别的文件夹", () => {
  const f = "财务/PBC";
  assert.ok(isPbcPagePath(f, "财务/PBC", "PBC-2026-11-23.md"));
  assert.ok(isPbcPagePath(f, "财务/PBC", "PBC-补账-2026上半年.md"));
  assert.ok(!isPbcPagePath(f, "财务/PBC", "PBC-2026-11-23-细节.md"));
  assert.ok(!isPbcPagePath(f, "财务/PBC/归档", "PBC-2026-11-01.md"));
  assert.ok(!isPbcPagePath(f, "财务/PBC/细节", "PBC-2026-11-01.md"));
  assert.ok(!isPbcPagePath(f, "笔记", "PBC-2026-11-01.md"));
  assert.ok(!isPbcPagePath(f, "财务/PBC", "说明.md"));
  assert.ok(!isPbcPagePath(f, "财务/PBC", "PBC-2026-11-23.txt"));
  assert.ok(!isPbcPagePath(f, undefined, "PBC-a.md"));
});
