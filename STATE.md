# STATE

更新：2026-11-24（北京时间）

## 已定
- 命令「PBC：交资料」+ 左侧 paperclip 图标；isDesktopOnly: false。
- 只认 PBC 文件夹顶层的 PBC-*.md；设置项：PBC 文件夹、附件文件夹。
- 光标在编号行就直接用；否则弹列表（空的在前）。
- 图片命名 编号-北京时间-序号.原扩展名；其他文件保留原名，重名加「 (2)」。
- 写回只追加到「我的反馈」格，原字不动；按编号定位。
- 测试用 node:test + esbuild 打包，无额外依赖；main.js 不入库，release 由 GitHub Actions 建。

## 待定
- 真机验证：iOS 点列表选行后能否弹出文件选择框（见下）。
- HEIC 图片：iOS 选择框是否转成 jpg 不确定；目前不转换，原样保存，名字保留原扩展名。
- minAppVersion 暂定 1.4.0，未在旧版本验证。

## 下一步
1. architect 验收后推送到 GitHub（morgantina721-arch/pbc-attach），打 tag 0.1.0 触发 release。
2. 用 BRAT 在 iPhone / iPad / Mac 装上，真机验证：光标在行内、列表选行两条路径，多选相册，从「文件」选 xlsx。
3. 若列表选行后 iOS 不弹选择框：改成列表里每行旁边直接放「选文件」按钮（让 input 在那次点击里触发）。
