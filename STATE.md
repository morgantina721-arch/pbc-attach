# STATE

更新：2026-11-25 20:15（北京时间）

## 已定
- 命令「PBC：交资料」+ 左侧 paperclip 图标；isDesktopOnly: false。
- 只认 PBC 文件夹顶层的 PBC-*.md（不含 -细节.md）；设置项：PBC 文件夹、附件文件夹。
- 光标在编号行就直接用；否则弹列表（空的在前）。
- 图片命名 编号-北京时间-序号.原扩展名；其他文件保留原名，重名加「 (2)」。
- 写回只追加到「我的反馈」格，原字不动；按编号定位。
- 测试用 node:test + esbuild 打包，无额外依赖；main.js 不入库，release 由 GitHub Actions 建。

## 0.2.0 已做（Tina 2026-11-24 约 23:15 同意）
- 选定目标后弹写字窗口：输入框 + 「选截图 / 文件」+「只交这句话」+「取消」；文字在前、嵌入在后；换行 -> <br>，| -> \|。
- 光标在编号行：跳过选行直接弹窗；选择框取消窗口保留。
- 页面判定放宽：PBC 文件夹顶层 PBC-*.md、不含 -细节.md；子文件夹和别处都不算。
- 「## 其他想说的」小节：列表最下面多一项，末尾追加新段落（不转义 |，图片 ![[名|300]]）。
- 没编号的行：只有光标停在上面才能交，按打开窗口时的原文定位，必须恰好出现一次；图片命名用「补充」。
- 测试 25 个全过；npm run build 过。尚未推送、未打 tag，待 architect 验收。

## 0.3.0 已做（用户 2026-11-25 约 20:05 同意：旧图放回收站 A；「其他想说的」先不做；已用上的行不会再动）
- 「改原来的」：写字窗口里，交过东西、没用上的行（编号行和无编号行）多一个按钮；修改窗口按块列出：话可改（清空=删）、截图换一张 / 删掉、没取走的文件可删、已取走的只读。
- 保存：先存新图（命名同平常），再 replaceCell 整格换掉；核对打开时的原文，被别处改过 / 刚变成 ✅ / 找不到都不写，新图收回。旧文件 vault.trash(file, false) 放进库里 .trash，只动附件文件夹里、别处没引用的。
- 备注以 ✅ 开头算已用上：没有按钮，只提示「再交一次」；选行列表标「已用上，可以再加，不能改」。
- 纯函数：splitPieces / joinPieces / removePiece / unescapeCellText / replaceCell / isUsedRow；Row 加 note。测试 31 个全过；npm run build 过。
- 记账程序不用改：pbc-pickup 不碰图片；被删的没取走文件已进 .trash（pickup 不看点开头的文件夹，附件夹孤儿也不会再有它）。

## 待定
- 真机验证：iOS 在写字窗口里点「选截图 / 文件」能否弹出选择框（input 在窗口打开时已建好，点击里只同步 click）。
- HEIC 图片：iOS 选择框是否转成 jpg 不确定；目前不转换，原样保存，名字保留原扩展名。
- minAppVersion 暂定 1.4.0，未在旧版本验证。

## 下一步
0. 0.3.0 真机验证：A 行改一段话、换一张图、删一张图后看格子和回收站；已用上的行没有按钮；两台设备同时改时提示没保存。
1. architect 验收后推送，打 tag 0.2.0 触发 release。
2. 用 BRAT 在 iPhone / iPad / Mac 装上，真机验证：光标在行内、列表选行、其他想说的、无编号行；多选相册；从「文件」选 xlsx；选择框取消后文字还在。
3. 若 iOS 窗口里按钮不弹选择框：改成让 input 覆盖在按钮上（label 包 input），直接点 input 本身。

## 发布方式（2026-11-24 约 23:30 北京时间）
GitHub Actions 上 npm ci 反复崩（npm 自身报错 "Exit handler never called"），去掉了自动发布。改成本机发布：
改 manifest.json / package.json / versions.json 的版本号 → npm test && npm run build → 提交 → git tag <版本> && git push github <版本> → gh release create <版本> main.js manifest.json --title <版本>
