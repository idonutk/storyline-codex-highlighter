import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  App,
  MarkdownPostProcessorContext,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFolder
} from "obsidian";

type Category = "Characters" | "Locations" | "Items";

interface CodexGroup {
  name: string;
  terms: string[];
}

interface Settings {
  storylineFolder: string;
  charactersColor: string;
  locationsColor: string;
  itemsColor: string;
  customTermColors: Record<string, string>;
}

const DEFAULT_SETTINGS: Settings = {
  storylineFolder: "StoryLine",
  charactersColor: "#ffd166",
  locationsColor: "#80ed99",
  itemsColor: "#72ddf7",
  customTermColors: {}
};

// Candidate frontmatter/property names. Add StoryLine's exact field names here
// if its character sheets use different ones.
const ALIAS_FIELDS = [
  "aliases", "alias", "nickname", "nicknames",
  "aka", "other_names", "other names", "also_known_as"
];

export default class StoryLineCodexHighlighter extends Plugin {
  private readonly editorExtensions: Extension[] = [];
  private settingsTab: CodexHighlighterSettings | null = null;
  settings: Settings = DEFAULT_SETTINGS;
  terms: Record<Category, string[]> = {
    Characters: [],
    Locations: [],
    Items: []
  };
  groups: Record<Category, CodexGroup[]> = {
    Characters: [],
    Locations: [],
    Items: []
  };
  codexFolders: string[] = [];

  async onload() {
    await this.loadSettings();
    const style = document.body.style;
    const colorProperties = [
      "--storyline-characters",
      "--storyline-locations",
      "--storyline-items"
    ];
    const previousColors = colorProperties.map(property => [
      property,
      style.getPropertyValue(property)
    ] as const);
    this.register(() => {
      for (const [property, value] of previousColors) {
        if (value) style.setProperty(property, value);
        else style.removeProperty(property);
      }
    });
    this.applyColors();

    this.editorExtensions.push(
      createEditorHighlighter(this.terms, this.settings.customTermColors)
    );
    this.registerEditorExtension(this.editorExtensions);

    this.settingsTab = new CodexHighlighterSettings(this.app, this);
    this.addSettingTab(this.settingsTab);

    const ribbonButton = this.addRibbonIcon(
      "highlighter",
      "Open StoryLine Codex Highlighter settings",
      () => {
        const settingManager = (
          this.app as App & {
            setting: {
              open: () => void;
              openTabById: (id: string) => void;
            };
          }
        ).setting;
        settingManager.open();
        settingManager.openTabById(this.manifest.id);
      }
    );
    ribbonButton.addClass("storyline-codex-ribbon");
    ribbonButton.empty();
    const ribbonLabel = ribbonButton.createSpan({
      cls: "storyline-codex-ribbon-label"
    });
    for (const letter of "LCH") {
      ribbonLabel.createSpan({ cls: "storyline-codex-ribbon-letter", text: letter });
    }

    this.registerMarkdownPostProcessor((element, context) => {
      this.highlightReadingView(element, context);
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.rebuildTerms())
    );
    this.registerEvent(
      this.app.vault.on("create", () => this.rebuildTerms())
    );
    this.registerEvent(
      this.app.vault.on("delete", () => this.rebuildTerms())
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.rebuildTerms())
    );

    await this.rebuildTerms();
  }

  async loadSettings() {
    const saved = await this.loadData();
    const savedSettings = { ...saved };
    delete savedSettings.codexFolder;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...savedSettings,
      customTermColors: {
        ...DEFAULT_SETTINGS.customTermColors,
        ...(saved?.customTermColors ?? {})
      }
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyColors();
    await this.rebuildTerms();
  }

  applyColors() {
    document.body.style.setProperty(
      "--storyline-characters",
      this.settings.charactersColor
    );
    document.body.style.setProperty(
      "--storyline-locations",
      this.settings.locationsColor
    );
    document.body.style.setProperty(
      "--storyline-items",
      this.settings.itemsColor
    );
  }

  async rebuildTerms() {
    const next: Record<Category, Set<string>> = {
      Characters: new Set(),
      Locations: new Set(),
      Items: new Set()
    };
    const nextGroups: Record<Category, CodexGroup[]> = {
      Characters: [],
      Locations: [],
      Items: []
    };

    this.codexFolders = this.findCodexFolders();

    for (const file of this.app.vault.getMarkdownFiles()) {
      const path = file.path;
      const category = this.categoryFromPath(path, this.codexFolders);
      if (!category) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter;
      const name =
        collectValues(frontmatter?.name)[0] ??
        collectValues(frontmatter?.title)[0] ??
        file.basename;
      const aliases = new Set<string>();

      if (frontmatter) {
        for (const [key, value] of Object.entries(frontmatter)) {
          const normalizedKey = key.toLowerCase().replace(/[-\s]/g, "_");
          const isCandidate =
            ["name", "title", ...ALIAS_FIELDS].includes(key.toLowerCase()) ||
            /alias|nickname|nicknames|also_known|other_name|^aka$/.test(normalizedKey);

          if (!isCandidate) continue;
          for (const term of collectValues(value)) {
            if (normalizeTerm(term) !== normalizeTerm(name)) aliases.add(term);
          }
        }
      }

      const groupTerms = [name, ...aliases];
      nextGroups[category].push({ name, terms: groupTerms });
      for (const term of groupTerms) next[category].add(term);
    }

    this.groups = nextGroups;
    this.terms = {
      Characters: [...next.Characters],
      Locations: [...next.Locations],
      Items: [...next.Items]
    };

    this.editorExtensions.splice(
      0,
      this.editorExtensions.length,
      createEditorHighlighter(this.terms, this.settings.customTermColors)
    );
    this.app.workspace.updateOptions();
    this.settingsTab?.renderCodexFolderLocations();
    this.settingsTab?.renderTermsSummary();
  }

  findCodexFolders(): string[] {
    const storylineRoot = this.settings.storylineFolder
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();
    if (!storylineRoot) return [];

    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter(folder => {
        const path = folder.path.toLowerCase();
        return (
          folder.name.toLowerCase() === "codex" &&
          path.startsWith(storylineRoot + "/")
        );
      })
      .map(folder => folder.path)
      .sort((left, right) => left.localeCompare(right));
  }

  categoryFromPath(path: string, codexFolders: string[]): Category | null {
    const normalizedPath = path.toLowerCase();
    const codexFolder = codexFolders.find(folder =>
      normalizedPath.startsWith(folder.toLowerCase() + "/")
    );
    if (!codexFolder) return null;

    const categoryFolder = path.slice(codexFolder.length + 1).split("/")[0]?.toLowerCase();
    if (categoryFolder?.includes("character")) return "Characters";
    if (categoryFolder?.includes("location")) return "Locations";
    if (categoryFolder?.includes("item")) return "Items";

    return null;
  }

  highlightReadingView(
    container: HTMLElement,
    _context: MarkdownPostProcessorContext
  ) {
    const terms: { word: string; category: Category }[] = [
      ...this.terms.Characters.map(word => ({ word, category: "Characters" as const })),
      ...this.terms.Locations.map(word => ({ word, category: "Locations" as const })),
      ...this.terms.Items.map(word => ({ word, category: "Items" as const }))
    ].filter(item => item.word.length > 0);

    if (!terms.length) return;

    // Longest terms first, so a full name is matched before a shorter part.
    terms.sort((a, b) => b.word.length - a.word.length);

    const regex = createTermRegex(terms.map(item => item.word));

    const categoryForMatch = new Map(
      terms.map(item => [item.word.toLocaleLowerCase(), item.category])
    );

    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: node => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          if (
            parent.closest(
              "code, pre, a, mark.storyline-codex-highlight, script, style"
            )
          ) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    for (const textNode of textNodes) {
      const text = textNode.nodeValue ?? "";
      regex.lastIndex = 0;

      const matches = [...text.matchAll(regex)];
      if (!matches.length) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;

      for (const match of matches) {
        const word = match[0];
        const start = match.index ?? 0;

        if (start > cursor) {
          fragment.appendText(text.slice(cursor, start));
        }

        const baseWord = stripPossessive(word);
        const category = categoryForMatch.get(normalizeTerm(baseWord));
        const mark = document.createElement("mark");
        mark.className = `storyline-codex-highlight storyline-codex-${category?.toLowerCase() ?? "unknown"}`;
        const customColor = this.settings.customTermColors[normalizeTerm(baseWord)];
        if (customColor) mark.style.color = customColor;
        mark.textContent = word;
        fragment.appendChild(mark);

        cursor = start + word.length;
      }

      if (cursor < text.length) fragment.appendText(text.slice(cursor));
      textNode.replaceWith(fragment);
    }
  }
}

function createEditorHighlighter(
  terms: Record<Category, string[]>,
  customTermColors: Record<string, string>
): Extension {
  const entries = (Object.keys(terms) as Category[])
    .flatMap(category => terms[category].map(word => ({ word, category })))
    .filter(entry => entry.word.length > 0)
    .sort((a, b) => b.word.length - a.word.length);
  const regex = createTermRegex(entries.map(entry => entry.word));
  const categoryForMatch = new Map<string, Category>(
    entries.map(entry => [normalizeTerm(entry.word), entry.category])
  );

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const ranges: Range<Decoration>[] = [];

        for (const visibleRange of view.visibleRanges) {
          const text = view.state.doc.sliceString(
            visibleRange.from,
            visibleRange.to
          );
          regex.lastIndex = 0;

          let match: RegExpExecArray | null;
          while ((match = regex.exec(text)) !== null) {
            const word = match[0];
            const start = visibleRange.from + (match.index ?? 0);
            const baseWord = stripPossessive(word);
            const category = categoryForMatch.get(normalizeTerm(baseWord));
            if (!category) continue;
            const customColor = customTermColors[normalizeTerm(baseWord)];

            ranges.push(
              Decoration.mark({
                class: `storyline-codex-highlight storyline-codex-${category.toLowerCase()}`,
                attributes: customColor ? { style: `color: ${customColor}` } : undefined
              }).range(start, start + word.length)
            );
          }
        }

        return Decoration.set(ranges, true);
      }
    },
    { decorations: plugin => plugin.decorations }
  );
}

function collectValues(value: unknown): string[] {
  const values = new Set<string>();
  addValues(values, value);
  return [...values];
}

function normalizeTerm(term: string): string {
  return term.toLocaleLowerCase();
}

function stripPossessive(term: string): string {
  return term.replace(/['’]s$/iu, "");
}

function createTermRegex(terms: string[]): RegExp {
  const alternatives = terms.map(escapeRegex).join("|") || "(?!)";
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives})(?:['’]s)?(?![\\p{L}\\p{N}_])`,
    "giu"
  );
}

function addValues(target: Set<string>, value: unknown) {
  if (value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) addValues(target, item);
    return;
  }

  if (typeof value === "string" || typeof value === "number") {
    // Supports YAML lists and comma-separated single fields.
    for (const part of String(value).split(/[\r\n,]+/)) {
      const cleaned = part.trim();
      if (cleaned) target.add(cleaned);
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class CodexHighlighterSettings extends PluginSettingTab {
  plugin: StoryLineCodexHighlighter;
  private termsSummary: HTMLElement | null = null;
  private codexFolderLocations: HTMLElement | null = null;
  private customColor = "#ff4d6d";

  constructor(app: App, plugin: StoryLineCodexHighlighter) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("StoryLine folder")
      .setDesc("Vault-relative StoryLine folder containing your projects.")
      .addText(text =>
        text
          .setPlaceholder("StoryLine")
          .setValue(this.plugin.settings.storylineFolder)
          .onChange(async value => {
            this.plugin.settings.storylineFolder = value.trim() || "StoryLine";
            await this.plugin.saveSettings();
          })
      );

    this.codexFolderLocations = containerEl.createDiv({
      cls: "storyline-codex-folder-locations"
    });
    this.renderCodexFolderLocations();

    containerEl.createEl("h3", {
      cls: "storyline-codex-section-label",
      text: "Category colors"
    });
    this.addColorSetting(containerEl, "Characters color", "charactersColor");
    this.addColorSetting(containerEl, "Locations color", "locationsColor");
    this.addColorSetting(containerEl, "Items color", "itemsColor");

    this.termsSummary = containerEl.createDiv({
      cls: "storyline-codex-settings-summary"
    });
    this.renderTermsSummary();

    new Setting(containerEl)
      .setName("Refresh Codex terms")
      .setDesc("Re-scan the Codex notes.")
      .addButton(button =>
        button.setButtonText("Refresh").onClick(async () => {
          await this.plugin.rebuildTerms();
          new Notice("Codex terms refreshed.");
        })
      );
  }

  renderCodexFolderLocations() {
    if (!this.codexFolderLocations) return;

    this.codexFolderLocations.empty();
    if (this.plugin.codexFolders.length === 0) {
      this.codexFolderLocations.createEl("p", {
        cls: "storyline-codex-folder-error",
        text: `No Codex folders found under "${this.plugin.settings.storylineFolder}".`
      });
      return;
    }

    this.codexFolderLocations.createEl("p", {
      cls: "storyline-codex-folder-heading",
      text: `Found ${this.plugin.codexFolders.length} Codex folder${this.plugin.codexFolders.length === 1 ? "" : "s"}:`
    });
    const list = this.codexFolderLocations.createEl("ul", {
      cls: "storyline-codex-folder-list"
    });
    for (const path of this.plugin.codexFolders) {
      const item = list.createEl("li");
      item.createSpan({ cls: "storyline-codex-folder-check", text: "✓" });
      item.createSpan({ text: path });
    }
  }

  renderTermsSummary() {
    if (!this.termsSummary) return;

    this.termsSummary.empty();
    const customColors = this.renderCustomColorControls(this.termsSummary);
    const foundItems = customColors.createDiv({
      cls: "storyline-codex-found-items"
    });
    foundItems.createEl("h3", { text: "Found Codex items" });

    for (const category of ["Characters", "Locations", "Items"] as const) {
      const groups = [...this.plugin.groups[category]].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      const section = foundItems.createDiv({
        cls: "storyline-codex-settings-category"
      });
      section.createEl("h4", { text: `${category} (${groups.length})` });

      if (groups.length === 0) {
        section.createEl("p", {
          cls: "storyline-codex-settings-empty",
          text: "No items found in this category."
        });
        continue;
      }

      for (const group of groups) {
        const groupEl = section.createDiv({ cls: "storyline-codex-name-group" });
        this.createDraggableTerm(groupEl, group.name, "storyline-codex-name");

        const aliases = group.terms.filter(
          term => normalizeTerm(term) !== normalizeTerm(group.name)
        );
        if (aliases.length > 0) {
          const aliasList = groupEl.createDiv({ cls: "storyline-codex-aliases" });
          const aliasIndicator = aliasList.createSpan({
            cls: "storyline-codex-alias-label",
            text: "⤷"
          });
          aliasIndicator.setAttr("aria-label", "Aliases");
          for (const alias of aliases) {
            this.createDraggableTerm(
              aliasList,
              alias,
              "storyline-codex-alias"
            );
          }
        }
      }
    }
  }

  private renderCustomColorControls(container: HTMLElement): HTMLElement {
    const section = container.createDiv({
      cls: "storyline-codex-custom-colors"
    });
    section.createEl("h4", { text: "Custom color overrides" });

    new Setting(section)
      .setName("Override color")
      .addColorPicker(picker =>
        picker
          .setValue(this.customColor)
          .onChange(value => (this.customColor = value))
      );

    const dropZone = section.createDiv({
      cls: "storyline-codex-color-drop-target"
    });
    dropZone.setAttr("tabindex", "0");
    dropZone.setAttr("aria-label", "Drop a name or alias to assign this color");
    dropZone.style.setProperty("--storyline-custom-drop-color", this.customColor);
    dropZone.createSpan({ text: "Drop a name or alias" });
    dropZone.addEventListener("dragover", event => {
      event.preventDefault();
      dropZone.addClass("is-dragging-over");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.removeClass("is-dragging-over");
    });
    dropZone.addEventListener("drop", event => {
      event.preventDefault();
      dropZone.removeClass("is-dragging-over");
      const term = event.dataTransfer?.getData("text/plain")?.trim();
      if (!term) return;

      const exists = Object.values(this.plugin.terms).some(categoryTerms =>
        categoryTerms.some(item => normalizeTerm(item) === normalizeTerm(term))
      );
      if (!exists) return;

      this.plugin.settings.customTermColors[normalizeTerm(term)] = this.customColor;
      void this.plugin.saveSettings();
      new Notice(`Custom color assigned to ${term}.`);
    });

    const overrides = Object.entries(this.plugin.settings.customTermColors).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    if (overrides.length === 0) {
      section.createEl("p", {
        cls: "storyline-codex-settings-empty",
        text: "No custom colors assigned."
      });
      return section;
    }

    const assignmentList = section.createDiv({
      cls: "storyline-codex-custom-color-list"
    });
    for (const [normalizedTerm, color] of overrides) {
      const row = assignmentList.createDiv({
        cls: "storyline-codex-custom-color-row"
      });
      const swatch = row.createSpan({ cls: "storyline-codex-color-swatch" });
      swatch.style.backgroundColor = color;
      swatch.setAttr("aria-label", color);
      row.createSpan({ text: this.findTermLabel(normalizedTerm) });
      row.createEl("button", { text: "Remove" }).addEventListener(
        "click",
        async () => {
          delete this.plugin.settings.customTermColors[normalizedTerm];
          await this.plugin.saveSettings();
        }
      );
    }
    return section;
  }

  private createDraggableTerm(
    container: HTMLElement,
    term: string,
    className: string
  ) {
    const element = container.createSpan({ cls: className, text: term });
    element.setAttr("draggable", "true");
    element.addEventListener("dragstart", event => {
      event.dataTransfer?.setData("text/plain", term);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
    });
    return element;
  }

  private findTermLabel(normalizedTerm: string): string {
    for (const category of Object.values(this.plugin.groups)) {
      for (const group of category) {
        const match = group.terms.find(
          term => normalizeTerm(term) === normalizedTerm
        );
        if (match) return match;
      }
    }
    return normalizedTerm;
  }

  addColorSetting(
    containerEl: HTMLElement,
    label: string,
    key: "charactersColor" | "locationsColor" | "itemsColor"
  ) {
    new Setting(containerEl)
      .setName(label)
      .addColorPicker(picker =>
        picker
          .setValue(this.plugin.settings[key])
          .onChange(async value => {
            this.plugin.settings[key] = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
