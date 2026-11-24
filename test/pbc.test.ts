import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRows, findRowAtLine, appendToCell, sanitizeFileName, imageName, uniqueName,
  beijingStamp, embedFor, isImageFile, summarize,
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
