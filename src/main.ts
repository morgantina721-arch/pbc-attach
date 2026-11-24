import { App, MarkdownView, Notice, Modal, Plugin, PluginSettingTab, Setting, SuggestModal, TFile, normalizePath } from "obsidian";
import {
  parseRows, findRowAtLine, appendToCell, appendToLooseLine, appendToOther, composeCell, composeOther, hasOtherSection, isPbcPagePath, sanitizeFileName, imageName, uniqueName,
  beijingStamp, embedFor, isImageFile, summarize,
} from "./pbc";

interface Settings {
  pbcFolder: string;
  attachFolder: string;
}
const DEFAULTS: Settings = { pbcFolder: "财务/PBC", attachFolder: "财务/PBC/附件" };

const ACCEPT = "image/*,.xlsx,.xls,.csv,.zip,.pdf";

/** 要交到哪：编号行 / 「其他想说的」小节 / 没编号的行（光标停在上面时） */
type Target =
  | { kind: "row"; id: string; title: string }
  | { kind: "other"; id: ""; title: string }
  | { kind: "loose"; id: ""; title: string; raw: string }; // raw：打开窗口那一刻这一行的原文，写回时靠它定位

export default class PbcAttachPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };

  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };
    this.addCommand({ id: "attach", name: "交资料", callback: () => this.run() });
    this.addRibbonIcon("paperclip", "PBC：交资料", () => this.run());
    this.addSettingTab(new PbcSettingTab(this.app, this));
  }

  /** 是不是正在用的 PBC 页（规则见 isPbcPagePath） */
  private isPbcPage(file: TFile): boolean {
    const folder = normalizePath(this.settings.pbcFolder || DEFAULTS.pbcFolder);
    return isPbcPagePath(folder, file.parent?.path, file.name);
  }

  private run() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    if (!view || !file || !this.isPbcPage(file)) {
      new Notice("这页不用交东西，请打开 " + (this.settings.pbcFolder || DEFAULTS.pbcFolder) + " 里正在用的那一页");
      return;
    }
    const text = view.editor.getValue();
    const { rows, duplicates, loose } = parseRows(text);
    const other = hasOtherSection(text);
    const cursorLine = view.editor.getCursor().line;
    const open = (t: Target) => new PostModal(this.app, t, (words, files) => void this.save(file, t, words, files)).open();

    // 光标就在某一行上：跳过选行，直接弹写字窗口
    const cur = findRowAtLine(rows, cursorLine);
    if (cur) {
      open({ kind: "row", id: cur.id, title: cur.id + " " + cur.desc });
      return;
    }
    // 没编号的行：只有光标停在上面才能交
    const lo = findRowAtLine(loose, cursorLine);
    if (lo) {
      const raw = text.split("\n")[lo.line];
      open({ kind: "loose", id: "", title: "补充" + (lo.desc ? " " + lo.desc : ""), raw });
      return;
    }
    if (duplicates.length) {
      new Notice("编号 " + duplicates.join("、") + " 在页面里出现了多次，只用第一处。");
    }
    if (rows.length === 0 && !other) {
      new Notice("这一页里没找到带编号（A01、B02、C03 这种）的行。");
      return;
    }
    // 空的排前面，已有内容的排后面（sort 是稳定的，各自保持页面顺序）；「其他想说的」放最下面
    const items: Target[] = [...rows]
      .sort((a, b) => Number(b.empty) - Number(a.empty))
      .map((r) => ({ kind: "row", id: r.id, title: r.id + " " + r.desc, done: !r.empty }) as Target & { done: boolean });
    if (other) items.push({ kind: "other", id: "", title: "其他想说的（随手写）" });
    new RowModal(this.app, items, open).open();
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

  /** 把「文字 + 文件」一次写进目标。files 为空就是只交文字。 */
  private async save(page: TFile, target: Target, words: string, files: File[]) {
    try {
      const folder = normalizePath(this.settings.attachFolder || DEFAULTS.attachFolder);
      const inTable = target.kind !== "other";
      // 图片命名用的「编号」：编号行用编号，没编号的行用「补充」，其他想说的用「其他」
      const nameId = target.kind === "row" ? target.id : target.kind === "loose" ? "补充" : "其他";
      const embeds: string[] = [];
      let images = 0, others = 0, failed = 0;
      if (files.length) {
        await this.ensureFolder(folder);
        const stamp = beijingStamp(Date.now()); // 北京时间，不看设备时区
        const exists = (n: string) => this.app.vault.getAbstractFileByPath(folder + "/" + n) !== null;
        for (const f of files) {
          try {
            const isImg = isImageFile(f.name, f.type);
            // 图片按编号+北京时间+序号命名；其他文件保留原名（后端靠文件名认来源）
            const wanted = isImg ? imageName(nameId, stamp, images + 1, f.name) : sanitizeFileName(f.name);
            const name = uniqueName(wanted, exists);
            await this.app.vault.createBinary(folder + "/" + name, await f.arrayBuffer());
            embeds.push(embedFor(name, isImg, inTable));
            if (isImg) images++; else others++;
          } catch (e) {
            console.error("pbc-attach: 保存失败", f.name, e);
            failed++;
          }
        }
        if (embeds.length === 0 && !words.trim()) {
          new Notice("文件没有保存成功，请再试一次。");
          return;
        }
      }
      // 原子改文件：按编号 / 原文重新找位置，不用行号
      let found = false;
      await this.app.vault.process(page, (data) => {
        const r =
          target.kind === "row" ? appendToCell(data, target.id, composeCell(words, embeds))
          : target.kind === "loose" ? appendToLooseLine(data, target.raw, composeCell(words, embeds))
          : appendToOther(data, composeOther(words, embeds));
        found = r.found;
        return r.text;
      });
      const tail = failed ? "（另有 " + failed + " 个没保存成功）" : "";
      if (found) {
        const parts = [words.trim() ? "文字" : "", summarize(images, others)].filter(Boolean);
        new Notice("已交到 " + (target.kind === "row" ? target.id : target.kind === "loose" ? "补充" : "其他想说的") + "：" + parts.join("、") + tail);
        return;
      }
      // 没写进去：说清楚文件在哪，文字也贴出来，免得丢
      const kept = embeds.length ? "文件已存到「" + folder + "」。" : "";
      const why = target.kind === "loose" ? "这一行刚被改过，没写进去，" : target.kind === "other" ? "页面里找不到「其他想说的」小节，没写进去，" : "页面里找不到 " + target.id + " 这一行（可能被删了），没写进去，";
      const said = words.trim() ? "你写的字：" + words.trim().slice(0, 200) : "";
      new Notice(why + (kept || "") + said + tail, 15000);
    } catch (e) {
      console.error("pbc-attach", e);
      new Notice("交资料没成功：" + (e instanceof Error ? e.message : "出了点问题") + "。请再试一次。");
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/** 没有光标行时，列出所有编号行（和「其他想说的」）让她选 */
class RowModal extends SuggestModal<Target & { done?: boolean }> {
  constructor(app: App, private items: (Target & { done?: boolean })[], private onPick: (t: Target) => void) {
    super(app);
    this.setPlaceholder("选要交到哪一行（可输入编号或文字筛选）");
  }
  getSuggestions(q: string) {
    const s = q.trim().toLowerCase();
    return this.items.filter((r) => r.title.toLowerCase().includes(s));
  }
  renderSuggestion(r: Target & { done?: boolean }, el: HTMLElement) {
    el.createDiv({ text: r.title });
    if (r.done) el.createEl("small", { text: "已交过，可以再加" });
  }
  onChooseSuggestion(r: Target) {
    this.onPick(r);
  }
}

/** 写字窗口：一个输入框 + 「选截图 / 文件」+「只交这句话」+「取消」 */
class PostModal extends Modal {
  private input: HTMLInputElement | null = null;
  constructor(app: App, private target: Target, private onSubmit: (words: string, files: File[]) => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("交到：" + this.target.title);
    const ta = contentEl.createEl("textarea", { attr: { placeholder: "想说的话（可以不填）", rows: "5" } });
    ta.style.cssText = "width:100%;margin-bottom:12px;";

    // 文件选择 input 提前建好，点按钮时只做一件事：同步 click()。
    // 这中间不能有 await，否则 iOS 不认这次点击、不弹选择框。
    // 不用 display:none：有些 iOS 版本对 display:none 的 input 不弹选择框，沿用离屏写法。
    const input = contentEl.createEl("input", { attr: { type: "file", multiple: "", accept: ACCEPT } });
    input.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;";
    this.input = input;
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return; // 没选：窗口保持打开，文字还在
      const words = ta.value;
      this.close();
      this.onSubmit(words, files);
    });
    // 选择框被取消：什么都不做，窗口和文字都保留

    const bar = contentEl.createDiv();
    bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";
    const cancel = bar.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const textOnly = bar.createEl("button", { text: "只交这句话" });
    textOnly.disabled = true; // 输入为空时不可点
    ta.addEventListener("input", () => { textOnly.disabled = ta.value.trim() === ""; });
    textOnly.addEventListener("click", () => {
      const words = ta.value;
      if (words.trim() === "") return;
      this.close();
      this.onSubmit(words, []);
    });
    const pick = bar.createEl("button", { text: "选截图 / 文件", cls: "mod-cta" });
    pick.addEventListener("click", () => {
      input.value = ""; // 清空，选同一个文件也会触发 change
      input.click(); // 同一调用栈里同步 click
    });
  }
  onClose() {
    this.input?.remove();
    this.input = null;
    this.contentEl.empty();
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
      .setDesc("只认这个文件夹顶层、文件名 PBC-*.md（不含 -细节.md）的页面；子文件夹里的不算")
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
