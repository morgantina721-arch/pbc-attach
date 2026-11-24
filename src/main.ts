import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, SuggestModal, TFile, normalizePath } from "obsidian";
import {
  Row, parseRows, findRowAtLine, appendToCell, sanitizeFileName, imageName, uniqueName,
  beijingStamp, embedFor, isImageFile, summarize,
} from "./pbc";

interface Settings {
  pbcFolder: string;
  attachFolder: string;
}
const DEFAULTS: Settings = { pbcFolder: "财务/PBC", attachFolder: "财务/PBC/附件" };

const ACCEPT = "image/*,.xlsx,.xls,.csv,.zip,.pdf";

export default class PbcAttachPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  private input: HTMLInputElement | null = null;

  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };
    this.addCommand({ id: "attach", name: "交资料", callback: () => this.run() });
    this.addRibbonIcon("paperclip", "PBC：交资料", () => this.run());
    this.addSettingTab(new PbcSettingTab(this.app, this));
  }

  onunload() {
    this.input?.remove();
  }

  /** 是不是 PBC 页：只认 PBC 文件夹顶层的 PBC-*.md */
  private isPbcPage(file: TFile): boolean {
    const folder = normalizePath(this.settings.pbcFolder || DEFAULTS.pbcFolder);
    return file.parent?.path === folder && /^PBC-.*\.md$/.test(file.name);
  }

  private run() {
    // 注意：从这里到弹出选择框之间不能有 await，否则 iOS 不认这次点击
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    if (!view || !file || !this.isPbcPage(file)) {
      new Notice("当前不是 PBC 清单页。请先打开「" + this.settings.pbcFolder + "」里的 PBC-日期 页面，再点一次。");
      return;
    }
    const { rows, duplicates } = parseRows(view.editor.getValue());
    if (duplicates.length) {
      new Notice("编号 " + duplicates.join("、") + " 在页面里出现了多次，只用第一处。");
    }
    if (rows.length === 0) {
      new Notice("这一页里没找到带编号（A01、B02、C03 这种）的行。");
      return;
    }
    const cur = findRowAtLine(rows, view.editor.getCursor().line);
    if (cur) {
      this.pickFiles(file, cur);
      return;
    }
    // 空的排前面，已有内容的排后面（sort 是稳定的，各自保持页面顺序）
    const sorted = [...rows].sort((a, b) => Number(b.empty) - Number(a.empty));
    new RowModal(this.app, sorted, (row) => this.pickFiles(file, row)).open();
  }

  /** 调起系统选择框。必须在用户点击的同一调用栈里 click。 */
  private pickFiles(page: TFile, row: Row) {
    this.input?.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ACCEPT;
    // 不用 display:none：有些 iOS 版本对隐藏到 display:none 的 input 不弹选择框
    input.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;";
    document.body.appendChild(input);
    this.input = input;
    const done = () => {
      input.remove();
      if (this.input === input) this.input = null;
    };
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      done();
      if (files.length) void this.save(page, row.id, files);
    });
    input.addEventListener("cancel", done);
    input.click();
  }

  private async ensureFolder(path: string) {
    let cur = "";
    for (const part of normalizePath(path).split("/")) {
      cur = cur ? cur + "/" + part : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          // 可能同步刚好建好了，再查一次
          if (!this.app.vault.getAbstractFileByPath(cur)) throw new Error("建不了文件夹 " + cur);
        }
      }
    }
  }

  private async save(page: TFile, id: string, files: File[]) {
    try {
      const folder = normalizePath(this.settings.attachFolder || DEFAULTS.attachFolder);
      await this.ensureFolder(folder);
      const stamp = beijingStamp(Date.now()); // 北京时间，不看设备时区
      const exists = (n: string) =>
        this.app.vault.getAbstractFileByPath(folder + "/" + n) !== null;
      const embeds: string[] = [];
      const savedPaths: string[] = [];
      let images = 0, others = 0, failed = 0;
      for (const f of files) {
        try {
          const isImg = isImageFile(f.name, f.type);
          // 图片按编号+北京时间+序号命名；其他文件保留原名（后端靠文件名认来源）
          const wanted = isImg
            ? imageName(id, stamp, images + 1, f.name)
            : sanitizeFileName(f.name);
          const name = uniqueName(wanted, exists);
          await this.app.vault.createBinary(folder + "/" + name, await f.arrayBuffer());
          savedPaths.push(folder + "/" + name);
          embeds.push(embedFor(name, isImg));
          if (isImg) images++; else others++;
        } catch (e) {
          console.error("pbc-attach: 保存失败", f.name, e);
          failed++;
        }
      }
      if (embeds.length === 0) {
        new Notice("文件没有保存成功，请再试一次。");
        return;
      }
      // 原子改文件：按编号重新找行，不用行号
      let found = false;
      await this.app.vault.process(page, (data) => {
        const r = appendToCell(data, id, embeds.join(" "));
        found = r.found;
        return r.text;
      });
      const tail = failed ? "（另有 " + failed + " 个没保存成功）" : "";
      if (found) {
        new Notice("已交到 " + id + "：" + summarize(images, others) + tail);
      } else {
        new Notice("文件已存到「" + folder + "」，但页面里找不到 " + id + " 这一行（可能被删了），所以没有写进格子。" + tail, 10000);
      }
    } catch (e) {
      console.error("pbc-attach", e);
      new Notice("交资料没成功：" + (e instanceof Error ? e.message : "出了点问题") + "。请再试一次。");
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/** 没有光标行时，列出所有编号行让她选 */
class RowModal extends SuggestModal<Row> {
  constructor(app: App, private rows: Row[], private onPick: (r: Row) => void) {
    super(app);
    this.setPlaceholder("选要交到哪一行（可输入编号或文字筛选）");
  }
  getSuggestions(q: string): Row[] {
    const s = q.trim().toLowerCase();
    return this.rows.filter((r) => (r.id + " " + r.desc).toLowerCase().includes(s));
  }
  renderSuggestion(r: Row, el: HTMLElement) {
    el.createDiv({ text: r.id + " " + r.desc });
    if (!r.empty) el.createEl("small", { text: "已交过，可以再加" });
  }
  onChooseSuggestion(r: Row) {
    this.onPick(r); // 同步调用，保持在点击的调用栈里
  }
}

class PbcSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PbcAttachPlugin) {
    super(app, plugin);
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("PBC 文件夹")
      .setDesc("只认这个文件夹顶层、文件名 PBC-*.md 的页面")
      .addText((t) =>
        t.setValue(this.plugin.settings.pbcFolder).onChange(async (v) => {
          this.plugin.settings.pbcFolder = v.trim() || DEFAULTS.pbcFolder;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("附件文件夹")
      .setDesc("交的截图和文件存在这里，不存在会自动建")
      .addText((t) =>
        t.setValue(this.plugin.settings.attachFolder).onChange(async (v) => {
          this.plugin.settings.attachFolder = v.trim() || DEFAULTS.attachFolder;
          await this.plugin.saveSettings();
        }),
      );
  }
}
