import { App, MarkdownView, Notice, Modal, Plugin, PluginSettingTab, Setting, SuggestModal, TFile, normalizePath } from "obsidian";
import {
  parseRows, findRowAtLine, appendToCell, appendToLooseLine, appendToOther, composeCell, composeOther, hasOtherSection, isPbcPagePath, sanitizeFileName, imageName, uniqueName,
  beijingStamp, embedFor, isImageFile, summarize,
  isUsedRow, splitPieces, joinPieces, removePiece, unescapeCellText, escapeCellText, replaceCell, Piece, Row,
} from "./pbc";

interface Settings {
  pbcFolder: string;
  attachFolder: string;
}
const DEFAULTS: Settings = { pbcFolder: "财务/PBC", attachFolder: "财务/PBC/附件" };

const ACCEPT = "image/*,.xlsx,.xls,.csv,.zip,.pdf";

/**
 * 要交到哪：编号行 / 「其他想说的」小节 / 没编号的行（光标停在上面时）
 * feedback：打开窗口那一刻「我的反馈」格的原文（改原来的时用来核对期间有没有被别处改过）
 * used：这一行已经用上了（备注 ✅），不让改
 */
type Target =
  | { kind: "row"; id: string; title: string; feedback: string; used: boolean }
  | { kind: "other"; id: ""; title: string }
  | { kind: "loose"; id: ""; title: string; raw: string; feedback: string; used: boolean }; // raw：打开窗口那一刻这一行的原文，写回时靠它定位

/** 编号行 → Target */
const rowTarget = (r: Row): Target => ({ kind: "row", id: r.id, title: r.id + " " + r.desc, feedback: r.feedback, used: isUsedRow(r) });

/** 修改窗口交回来的结果：每一块要么保留（文字可能改过）、要么删掉、要么（图片）换成新选的 */
interface EditResult {
  pieces: Piece[]; // 打开时拆出来的原样
  texts: Map<number, string>; // 改过的话：块序号 → 输入框里的新字（未转义）
  removed: Set<number>; // 要删掉的块
  replaced: Map<number, File>; // 要换的图：块序号 → 新选的图片
}

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
    const open = (t: Target) =>
      new PostModal(this.app, t, (words, files) => void this.save(file, t, words, files), () =>
        new EditModal(this.app, t, this.resourceFor(file), (res) => void this.saveEdit(file, t, res)).open(),
      ).open();

    // 光标就在某一行上：跳过选行，直接弹写字窗口
    const cur = findRowAtLine(rows, cursorLine);
    if (cur) {
      open(rowTarget(cur));
      return;
    }
    // 没编号的行：只有光标停在上面才能交
    const lo = findRowAtLine(loose, cursorLine);
    if (lo) {
      const raw = text.split("\n")[lo.line];
      open({ kind: "loose", id: "", title: "补充" + (lo.desc ? " " + lo.desc : ""), raw, feedback: lo.feedback, used: isUsedRow(lo) });
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
      .map((r) => ({ ...rowTarget(r), done: !r.empty }) as Target & { done: boolean });
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

  /** 给修改窗口用：文件名 → 能显示的图片地址（找不到就 null） */
  private resourceFor(page: TFile) {
    return (name: string): string | null => {
      const f = this.app.metadataCache.getFirstLinkpathDest(name, page.path);
      return f ? this.app.vault.getResourcePath(f) : null;
    };
  }

  /**
   * 换掉或删掉的旧文件放进 Obsidian 回收站（库里的 .trash 文件夹，能找回）。
   * 只动附件文件夹里的；本页或别的页还引用着就不动。返回有没有放进回收站。
   */
  private async trashIfUnused(page: TFile, name: string, folder: string): Promise<boolean> {
    const f = this.app.metadataCache.getFirstLinkpathDest(name, page.path);
    if (!f || !f.path.startsWith(folder + "/")) return false;
    if ((await this.app.vault.read(page)).includes(name)) return false;
    const links = this.app.metadataCache.resolvedLinks;
    for (const src in links) if (src !== page.path && links[src][f.path]) return false;
    await this.app.vault.trash(f, false);
    return true;
  }

  /** 改原来的：先存新图，再整格换掉（核对期间没被别处改过），最后把旧图放进回收站 */
  private async saveEdit(page: TFile, target: Target, res: EditResult) {
    if (target.kind === "other") return;
    const folder = normalizePath(this.settings.attachFolder || DEFAULTS.attachFolder);
    const created: TFile[] = []; // 这次新存的图：没保存成功时收回
    const dropBack = async () => {
      for (const f of created) await this.app.vault.trash(f, false).catch(() => undefined);
    };
    try {
      let pieces = res.pieces.map((p) => ({ ...p }));
      const oldNames: string[] = []; // 被换掉或删掉的文件，保存成功后放进回收站
      let nText = 0, nSwap = 0, nDel = 0;
      // 1. 新图先存进附件文件夹，名字和平常交的一样（编号-北京时间-序号）
      if (res.replaced.size) {
        await this.ensureFolder(folder);
        const stamp = beijingStamp(Date.now());
        const nameId = target.kind === "row" ? target.id : "补充";
        const exists = (n: string) => this.app.vault.getAbstractFileByPath(folder + "/" + n) !== null;
        let seq = 0;
        for (const [i, f] of res.replaced) {
          const name = uniqueName(imageName(nameId, stamp, ++seq, f.name), exists);
          created.push(await this.app.vault.createBinary(folder + "/" + name, await f.arrayBuffer()));
          pieces[i].raw = embedFor(name, true, true);
          if (res.pieces[i].name) oldNames.push(res.pieces[i].name!);
          nSwap++;
        }
      }
      // 2. 改过的话：清空就当删掉
      const removed = new Set(res.removed);
      for (const [i, t] of res.texts) {
        if (t.trim() === "") removed.add(i);
        else { pieces[i].raw = escapeCellText(t.trim()); nText++; }
      }
      // 3. 删掉的块，从后往前删，序号不乱
      for (const i of [...removed].sort((a, b) => b - a)) {
        if (res.pieces[i].name && !res.replaced.has(i)) oldNames.push(res.pieces[i].name!);
        pieces = removePiece(pieces, i);
        nDel++;
      }
      const next = joinPieces(pieces);
      // 4. 原子改文件：按编号 / 原文定位，期间被改过、刚被标成已用上、找不到，都不写
      const where = target.kind === "row" ? { id: target.id } : { raw: target.raw };
      let status = "missing";
      await this.app.vault.process(page, (data) => {
        const r = replaceCell(data, where, target.feedback, next);
        status = r.status;
        return r.text;
      });
      if (status !== "ok") {
        await dropBack();
        const why =
          status === "changed" ? "这一行在你修改期间被别处改过（可能是别的设备同步过来的），"
          : status === "used" ? "这一行刚被标成「已用上」，不能再改了，"
          : "页面里找不到这一行了（可能被删或被改过），";
        new Notice(why + "这次没保存。请重新打开这一页再改。", 15000);
        return;
      }
      // 5. 旧文件放进回收站
      let trashed = 0;
      for (const n of oldNames) {
        try { if (await this.trashIfUnused(page, n, folder)) trashed++; }
        catch (e) { console.error("pbc-attach: 放进回收站失败", n, e); }
      }
      const did = [nText ? "改了 " + nText + " 段话" : "", nSwap ? "换了 " + nSwap + " 张图" : "", nDel ? "删了 " + nDel + " 项" : ""].filter(Boolean);
      const label = target.kind === "row" ? target.id : "补充";
      new Notice("已改好 " + label + "：" + did.join("、") + (trashed ? "。旧的 " + trashed + " 个文件放进了 Obsidian 回收站" : ""));
    } catch (e) {
      await dropBack();
      console.error("pbc-attach", e);
      new Notice("修改没成功：" + (e instanceof Error ? e.message : "出了点问题") + "。格子没动，请再试一次。");
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
    if (r.done) el.createEl("small", { text: "used" in r && r.used ? "已用上，可以再加，不能改" : "已交过，可以再加或改原来的" });
  }
  onChooseSuggestion(r: Target) {
    this.onPick(r);
  }
}

/** 写字窗口：一个输入框 + 「选截图 / 文件」+「只交这句话」+「取消」 */
class PostModal extends Modal {
  private input: HTMLInputElement | null = null;
  constructor(app: App, private target: Target, private onSubmit: (words: string, files: File[]) => void, private onEdit?: () => void) {
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

    // 这一行交过东西：没用上的可以「改原来的」；已用上的只提示一句
    const t = this.target;
    const editable = t.kind !== "other" && splitPieces(t.feedback).some((p) => p.kind !== "picked");
    if (editable && t.used) {
      const hint = contentEl.createEl("p", { text: "这一行已经用上了，不能改原来的；要补充就在上面写，再交一次。" });
      hint.style.cssText = "font-size:var(--font-ui-small);color:var(--text-muted);margin:0 0 12px;";
    }

    const bar = contentEl.createDiv();
    bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";
    if (editable && !t.used && this.onEdit) {
      const fix = bar.createEl("button", { text: "改原来的" });
      fix.style.marginRight = "auto"; // 放在最左边，和「交」的按钮分开
      fix.addEventListener("click", () => {
        this.close();
        this.onEdit!();
      });
    }
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

/**
 * 改原来的：把这一格拆成一块一块列出来。
 * 话 → 输入框直接改（清空 = 删掉）；截图 → 换一张 / 删掉；还没取走的文件 → 删掉；已取走的 → 只能看。
 */
class EditModal extends Modal {
  private inputs: HTMLInputElement[] = [];
  private urls: string[] = []; // 新选图片的预览地址，关窗时释放
  constructor(app: App, private target: Target, private resource: (name: string) => string | null, private onSave: (r: EditResult) => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const t = this.target;
    if (t.kind === "other") return;
    this.setTitle("改：" + t.title);
    const pieces = splitPieces(t.feedback);
    const res: EditResult = { pieces, texts: new Map(), removed: new Set(), replaced: new Map() };

    const tip = contentEl.createEl("p", { text: "话直接改，清空就是删掉这段；截图可以换一张或删掉。换下来的旧图会放进 Obsidian 回收站。" });
    tip.style.cssText = "font-size:var(--font-ui-small);color:var(--text-muted);margin:0 0 12px;";

    pieces.forEach((p, i) => {
      const box = contentEl.createDiv();
      box.style.cssText = "border:1px solid var(--background-modifier-border);border-radius:8px;padding:8px;margin-bottom:8px;";

      if (p.kind === "text") {
        const orig = unescapeCellText(p.raw);
        const ta = box.createEl("textarea", { attr: { rows: String(Math.min(6, orig.split("\n").length + 1)) } });
        ta.value = orig;
        ta.style.cssText = "width:100%;";
        ta.addEventListener("input", () => {
          if (ta.value === orig) res.texts.delete(i);
          else res.texts.set(i, ta.value);
        });
        return;
      }
      if (p.kind === "picked") {
        box.createDiv({ text: unescapeCellText(p.raw) });
        box.createEl("small", { text: "文件已经交给系统了，这里改不了；要换就再交一份新的。" });
        box.style.opacity = "0.6";
        return;
      }

      // 图片 / 还没取走的文件
      const isImg = p.kind === "image";
      let input: HTMLInputElement | null = null;
      if (isImg) {
        // 和交资料一样：input 提前建好、离屏，点按钮时同步 click()（iOS 才肯弹选择框）
        input = contentEl.createEl("input", { attr: { type: "file", accept: "image/*" } });
        input.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;";
        this.inputs.push(input);
      }
      const draw = () => {
        box.empty();
        const removed = res.removed.has(i);
        const newFile = res.replaced.get(i);
        if (isImg) {
          let src = this.resource(p.name!);
          if (newFile) {
            src = URL.createObjectURL(newFile);
            this.urls.push(src);
          }
          if (src) {
            const img = box.createEl("img", { attr: { src } });
            img.style.cssText = "max-width:100%;max-height:180px;display:block;margin-bottom:6px;border-radius:4px;" + (removed ? "opacity:0.3;" : "");
          } else box.createDiv({ text: "（这张图在库里没找到：" + p.name + "）" });
        } else {
          box.createDiv({ text: "📄 " + p.name }).style.opacity = removed ? "0.4" : "1";
        }
        const state = removed ? "保存后删掉" : newFile ? "保存后换成这张新图" : "";
        if (state) box.createEl("small", { text: state }).style.cssText = "display:block;color:var(--text-accent);margin-bottom:6px;";

        const bar = box.createDiv();
        bar.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
        if (isImg && !removed) {
          const swap = bar.createEl("button", { text: newFile ? "再换一张" : "换一张" });
          swap.addEventListener("click", () => {
            input!.value = "";
            input!.click(); // 同步 click，中间不能有 await
          });
          if (newFile) {
            const undo = bar.createEl("button", { text: "不换了" });
            undo.addEventListener("click", () => { res.replaced.delete(i); draw(); });
          }
        }
        const del = bar.createEl("button", { text: removed ? "不删了" : "删掉" });
        if (!removed) del.addClass("mod-warning");
        del.addEventListener("click", () => {
          if (removed) res.removed.delete(i);
          else { res.removed.add(i); res.replaced.delete(i); }
          draw();
        });
      };
      input?.addEventListener("change", () => {
        const f = input!.files?.[0];
        if (!f) return; // 取消了选择框：什么都不变
        res.replaced.set(i, f);
        draw();
      });
      draw();
    });

    const bar = contentEl.createDiv();
    bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px;";
    bar.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const save = bar.createEl("button", { text: "保存", cls: "mod-cta" });
    save.addEventListener("click", () => {
      if (!res.texts.size && !res.removed.size && !res.replaced.size) {
        new Notice("没有改动。");
        return;
      }
      this.close();
      this.onSave(res);
    });
  }
  onClose() {
    this.inputs.forEach((x) => x.remove());
    this.inputs = [];
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
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
