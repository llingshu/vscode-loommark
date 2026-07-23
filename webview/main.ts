import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  autocompletion,
  completionStatus,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState, type Range, RangeSet, RangeValue, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  layer,
  type LayerMarker,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { tags } from '@lezer/highlight';
import { GFM } from '@lezer/markdown';
import './style.css';
import {
  codeRanges,
  containsPosition,
  detailedFencedCodeRanges,
  fencedCodeRanges,
  inlineCodeRanges,
  escapedCharRanges,
  headingRanges,
  headingSections,
  horizontalRuleRanges,
  imageRanges,
  isEscaped,
  linkDestinationRanges,
  LIST_INDENT_WIDTH,
  listGuideSegments,
  listItemRanges,
  mathRanges,
  orderedListLabels,
  quoteLineRanges,
  tableRanges,
  tagRanges,
} from './markdown-ranges';
import {
  BulletWidget,
  CardBoundaryWidget,
  CheckboxWidget,
  CodeToolbarWidget,
  HorizontalRuleWidget,
  ImageWidget,
  ListGuideWidget,
  MathWidget,
  OrderedLabelWidget,
  QuoteMarkerWidget,
  TableWidget,
  type BlockCardPresentation,
} from './widgets';
import type {
  CardMode,
  EditorConfiguration,
  HostToWebview,
  OrderedListStyle,
  TableMode,
  TableStyle,
  WebviewToHost,
} from '../src/protocol';

declare function acquireVsCodeApi<State>(): {
  postMessage(message: WebviewToHost): void;
  getState(): State | undefined;
  setState(state: State): void;
};

type SavedState = { text: string; documentRevision: number; outlineCollapsed?: boolean; cursor?: number };
type Heading = { label: string; level: number; offset: number };
type MdastNode = {
  type?: string;
  depth?: number;
  value?: string;
  children?: MdastNode[];
  position?: { start?: { offset?: number } };
};

const vscode = acquireVsCodeApi<SavedState>();
const root = required<HTMLElement>('#editor');
const status = required<HTMLElement>('#status');
const outline = required<HTMLElement>('#outline');
const outlineList = required<HTMLOListElement>('#outline-list');
const outlineEmpty = required<HTMLElement>('#outline-empty');
const outlineToggle = required<HTMLButtonElement>('#outline-toggle');
const outlineFab = required<HTMLButtonElement>('#outline-fab');
const savedState = vscode.getState();

let sourceText = savedState?.text ?? '';
let documentRevision = savedState?.documentRevision ?? 0;
let resourceBase = '';
let tableMode: TableMode = 'rich';
let tableStyle: TableStyle = 'grid';
let orderedListStyle: OrderedListStyle = 'cycle';
let listGuidesEnabled = true;
// Shipped default for loommark.cardBackgroundColors/cardBorderColors, matching package.json.
// An empty array (the user explicitly clearing it) means "no color" for that layer — see
// cardColorAt — so the shipped default must be non-empty to keep the out-of-the-box look.
const DEFAULT_CARD_COLORS = ['#7c3aed', '#2563eb', '#168a72', '#b46a08', '#be3455', '#087f8c'];

let cardMode: CardMode = 'card';
let cardBackgroundColors: string[] = DEFAULT_CARD_COLORS;
let cardBorderColors: string[] = DEFAULT_CARD_COLORS;
let cardBackgroundStrength = 0.06;
let cardBorderStrength = 0.52;
let backgroundDiagnostic: EditorConfiguration['background'] | undefined;
let cardImage: EditorConfiguration['cardImage'] = {
  enabled: false, imageUris: [], opacity: 0.72, blur: 4, saturation: 0.75,
  overlay: 0.18, status: 'disabled',
};
let cardImageRevision = 0;
let keyboardEditing = false;
let clientRevision = 0;
let syncDelay = 180;
let timer: number | undefined;
let editor: EditorView | undefined;
let applyingHostUpdate = false;
let wikiFiles: string[] = [];
let lastPointerDiagnostic: Record<string, unknown> | undefined;
let lastVisualHoverDiagnostic: Record<string, unknown> | undefined;
let lastLinkRequest: Record<string, unknown> | undefined;
let lastHostLinkResult: Record<string, unknown> | undefined;
let editorInitializationError: string | undefined;
let localGeneration = 0;
const pendingEdits = new Map<number, number>();
let outlineCollapsed = savedState?.outlineCollapsed ?? true;
let initialCursorRestored = false;

const headingDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildHeadingDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildHeadingDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const inlineDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildInlineDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildInlineDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], color: '#c678dd' },
  { tag: [tags.string, tags.special(tags.string)], color: '#98c379' },
  { tag: [tags.number, tags.bool, tags.null], color: '#d19a66' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#61afef' },
  { tag: [tags.typeName, tags.className], color: '#e5c07b' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#5c6370', fontStyle: 'italic' },
]);

const linkDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildLinkDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildLinkDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const tagDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildTagDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildTagDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const escapedCharDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildEscapedCharDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet) {
      this.decorations = buildEscapedCharDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const inlineCodeDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildInlineCodeDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildInlineCodeDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const fencedCodeDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildFencedCodeDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildFencedCodeDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const codeCursorAttributes = EditorView.editorAttributes.of((view) => ({
  class: isCursorInFencedCode(view) ? 'cm-loommark-code-cursor' : '',
}));

const codeToolbarField = StateField.define<DecorationSet>({
  create(state) {
    return buildCodeToolbarDecorations(state);
  },
  update(value, transaction) {
    if (transaction.docChanged
      || transaction.effects.some((effect) => effect.is(decorationsRefresh))) {
      return buildCodeToolbarDecorations(transaction.state);
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const decorationsRefresh = StateEffect.define<null>();

function selectionAwareField(build: (state: EditorState) => DecorationSet): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: build,
    update(value, transaction) {
      if (transaction.docChanged || transaction.selection
        || transaction.effects.some((effect) => effect.is(decorationsRefresh))) {
        return build(transaction.state);
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

const tableField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  for (const table of tableRanges(source)) {
    if (tableMode === 'source' && cursor >= table.from && cursor <= table.to) continue;
    ranges.push(Decoration.replace({
      widget: new TableWidget(
        table,
        source.slice(table.from, table.to),
        tableMode,
        blockCardPresentation(source, table.from),
      ),
      block: true,
    }).range(table.from, table.to));
  }
  return Decoration.set(ranges, true);
});

const imageField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  const destinations = linkDestinationRanges(source);
  const markSource = (image: { from: number; to: number; src: string }): void => {
    // Cursor-inside (source) state: no widget, but the raw text should still be easy to
    // spot (a highlighted background) and Ctrl/Cmd + click should still open the image,
    // so mark it with the same attribute the global click handler expects.
    ranges.push(Decoration.mark({
      attributes: { class: 'cm-loommark-image-source', 'data-loommark-href': image.src },
    }).range(image.from, image.to));
    const destination = destinations.find((range) => range.from >= image.from && range.to <= image.to);
    if (destination) {
      ranges.push(Decoration.mark({
        attributes: { class: 'cm-loommark-link' },
      }).range(destination.from, destination.to));
    }
  };
  for (const image of imageRanges(source)) {
    if (image.ownLine) {
      const line = state.doc.lineAt(image.from);
      if (cursor >= line.from && cursor <= line.to) {
        markSource(image);
        continue;
      }
      ranges.push(Decoration.replace({
        widget: new ImageWidget(image, resourceBase, true, blockCardPresentation(source, image.from)),
        block: true,
      }).range(line.from, line.to));
    } else {
      if (cursor >= image.from && cursor <= image.to) {
        markSource(image);
        continue;
      }
      ranges.push(Decoration.replace({
        widget: new ImageWidget(image, resourceBase, false),
      }).range(image.from, image.to));
    }
  }
  return Decoration.set(ranges, true);
});

const listField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  const items = listItemRanges(source);
    const orderedLabels = orderedListLabels(source, items, orderedListStyle);
    for (const item of items) {
    if (item.task?.checked && item.task.boxTo < item.lineTo) {
      // Do not lower opacity on the entire line: a line decoration also fades its Card tint,
      // background image, and rails. Mark only the task's visible text after the checkbox.
      ranges.push(Decoration.mark({ class: 'cm-loommark-task-done' })
        .range(item.task.boxTo, item.lineTo));
    }
    const cursorOnLine = cursor >= item.lineFrom && cursor <= item.lineTo;
    if (item.ordered) {
      // Unlike other markers, this label is a derived display value, not the literal source
      // text (that's the whole point of loommark.orderedListStyle) — revealing the raw number
      // when the cursor lands on the line would show a *different* number than what was just
      // displayed (e.g. "I." becoming "3."), which is confusing rather than informative. Always
      // show the rendered label; click it like the other rich widgets to edit the source.
      const label = orderedLabels.get(item.markerFrom);
      if (label) {
        const delimiter = source[item.markerTo - 1];
        ranges.push(Decoration.replace({ widget: new OrderedLabelWidget(label, delimiter, item.markerTo) })
          .range(item.markerFrom, item.markerTo));
      }
    } else if (!cursorOnLine) {
      ranges.push(Decoration.replace({ widget: new BulletWidget(item.level) })
        .range(item.markerFrom, item.markerTo));
    }
    if (item.task && !cursorOnLine) {
      ranges.push(Decoration.replace({ widget: new CheckboxWidget(item.task.checked, item.task.boxFrom) })
        .range(item.task.boxFrom, item.task.boxTo));
    }
  }
  return Decoration.set(ranges, true);
});

const listGuideField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  if (!listGuidesEnabled) return Decoration.set(ranges);
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  const items = listItemRanges(source);
  const segments = listGuideSegments(source, items);
  if (!segments.length) return Decoration.set(ranges);

  // Highlighted lines are the cursor's own line plus each ancestor *item's own line* (where
  // its bullet/number sits) — not every line a connector visually passes through. A sibling
  // branch under the same shallow ancestor sits inside that ancestor's segment too, but isn't
  // on the cursor's actual path, so it must not light up just because the level matches.
  const highlightedLines = new Set<number>([state.doc.lineAt(cursor).from]);
  for (const segment of segments) {
    if (cursor >= segment.from && cursor <= segment.to) highlightedLines.add(segment.itemLineFrom);
  }

  const itemByLineFrom = new Map(items.map((item) => [item.lineFrom, item] as const));
  // A line's rendered rails are exactly the ancestor levels of every segment that covers it;
  // an item's own segment (if any) starts on the line *after* it, so this never includes the
  // item's own level on its own line, only on lines belonging to its descendants/continuation.
  const lineLevels = new Map<number, Set<number>>();
  for (const segment of segments) {
    let position = segment.from;
    while (position <= segment.to) {
      const line = state.doc.lineAt(position);
      let levels = lineLevels.get(line.from);
      if (!levels) {
        levels = new Set();
        lineLevels.set(line.from, levels);
      }
      levels.add(segment.level);
      position = line.to + 1;
    }
  }

  for (const [lineFrom, levels] of lineLevels) {
    const line = state.doc.lineAt(lineFrom);
    const item = itemByLineFrom.get(lineFrom);
    const replaceTo = item
      ? item.markerFrom
      : line.from + (line.text.match(/^[ \t]*/)?.[0].length ?? 0);
    if (replaceTo <= line.from) continue;
    // Unlike marker-hiding decorations elsewhere, guides never reveal raw whitespace when the
    // cursor enters the line: there is no source syntax being hidden here to edit, only blank
    // space, so reverting away from the widget would just make the indent jump around and the
    // rails vanish right where the cursor is — the opposite of what a "where am I" guide is for.
    ranges.push(Decoration.replace({
      widget: new ListGuideWidget(Math.max(...levels) + 1, highlightedLines.has(lineFrom)),
    }).range(line.from, replaceTo));
  }
  return Decoration.set(ranges, true);
});

const HEADING_CARD_INSET_STEP = 10;
// Keep Card geometry on whole CSS pixels. Fractional borders land on different device-pixel
// boundaries after VS Code zoom/DPR scaling, making independently rendered CodeMirror lines
// appear horizontally offset even when their numeric positions are identical.
const HEADING_CARD_BORDER_WIDTH = 2;
const CODE_BLOCK_BORDER_WIDTH = 1;
// Extra room between the innermost border/rail and real content (text, or a nested code
// block's own border), on top of the geometric per-level inset — the whole point being that
// card content must never sit flush against the card's own edge.
const HEADING_CARD_CONTENT_PADDING = 12;

// Vertical clearance between a nested card's rounded bottom border and the bottom of its
// closing line; deeper levels closing on the same line stack extra clearance so each border
// stays individually visible. The outer level's border sits on the line's own bottom edge.
function cardClosingGap(level: number, outerLevel: number): number {
  return level === outerLevel ? 0 : 8 + (level - outerLevel - 1) * 4;
}

function blockCardPresentation(source: string, position: number): BlockCardPresentation {
  if (cardMode === 'off') return undefined;
  const active = headingSections(source, headingRanges(source))
    .filter((section) => position >= section.from && position <= section.to);
  if (!active.length) return undefined;
  const outer = active.reduce((a, b) => (a.level <= b.level ? a : b));
  const deepest = active.reduce((a, b) => (a.level >= b.level ? a : b));
  const outerInset = (outer.level - 1) * HEADING_CARD_INSET_STEP;
  const contentPadding = (deepest.level - outer.level) * HEADING_CARD_INSET_STEP
    + HEADING_CARD_CONTENT_PADDING;
  const deepestFirst = [...active].sort((a, b) => b.level - a.level);
  const style = [`--loommark-heading-card-color: ${headingBorderColor(outer.level) ?? 'transparent'}`];

  if (cardMode === 'tint') {
    const layers = deepestFirst.flatMap((section) => {
      const tint = headingBackgroundTint(section.level);
      if (!tint) return [];
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return [`linear-gradient(${tint}, ${tint}) ${inset}px 0 / calc(100% - ${inset * 2}px) 100% no-repeat`];
    });
    style.push(
      `margin-left: ${outerInset}px`, `margin-right: ${outerInset}px`,
      `padding-left: ${contentPadding}px`, `padding-right: ${contentPadding}px`,
      layers.length > 0 ? `background: ${layers.join(', ')}` : '',
    );
  } else if (cardMode === 'accent') {
    const shadows = active.flatMap((section) => {
      const color = headingBorderColor(section.level);
      if (!color) return [];
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return [`inset ${inset}px 0 0 0 ${color}`];
    });
    style.push(
      `margin-left: ${outerInset}px`, `padding-left: ${contentPadding}px`,
      shadows.length > 0 ? `box-shadow: ${shadows.join(', ')}` : '',
    );
  } else {
    const tintLayers = deepestFirst.flatMap((section) => {
      const tint = headingBackgroundTint(section.level);
      if (!tint) return [];
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return [`linear-gradient(${tint}, ${tint}) ${inset}px 0 / calc(100% - ${inset * 2}px) 100% no-repeat`];
    });
    const borderLayers = active.filter((section) => section.level !== outer.level).flatMap((section) => {
      const color = headingBorderColor(section.level);
      if (!color) return [];
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return [
        `linear-gradient(${color}, ${color}) ${inset}px 0 / ${HEADING_CARD_BORDER_WIDTH}px 100% no-repeat`,
        `linear-gradient(${color}, ${color}) calc(100% - ${inset}px - ${HEADING_CARD_BORDER_WIDTH}px) 0 / ${HEADING_CARD_BORDER_WIDTH}px 100% no-repeat`,
      ];
    });
    const allLayers = [...borderLayers, ...tintLayers];
    style.push(
      `margin-left: ${outerInset}px`, `margin-right: ${outerInset}px`,
      `padding-left: ${contentPadding}px`, `padding-right: ${contentPadding}px`,
      allLayers.length > 0 ? `background: ${allLayers.join(', ')}` : '',
    );
  }
  return {
    className: `cm-loommark-heading-card cm-loommark-heading-card-${cardMode}`,
    style: style.filter(Boolean).join('; '),
  };
}

// loommark.cardBackgroundColors/cardBorderColors cycle by level, independently, so background
// fill and border/rail color can be customized (or disabled) separately. An empty array means
// "no color" for that layer — the layer is not drawn at all — rather than falling back to any
// default; the shipped setting default is DEFAULT_CARD_COLORS, not [], so out of the box both
// still render normally.
function cardColorAt(colors: string[], level: number): string | null {
  if (colors.length === 0) return null;
  return colors[(level - 1) % colors.length];
}

function headingBorderColor(level: number): string | null {
  const base = cardColorAt(cardBorderColors, level);
  if (base === null) return null;
  const percentage = Math.round(cardBorderStrength * 1000) / 10;
  return `color-mix(in oklab, ${base} ${percentage}%, var(--vscode-editor-foreground))`;
}

// Border/rail lines stay close to full color so they read clearly; background fills use a very
// light tint instead — a background wash strong enough to read as a "color" behind body text
// makes the text itself harder to read, which is the opposite of what this feature is for.
function headingBackgroundTint(level: number): string | null {
  const base = cardColorAt(cardBackgroundColors, level);
  if (base === null) return null;
  const percentage = Math.round(cardBackgroundStrength * 1000) / 10;
  return `color-mix(in srgb, ${base} ${percentage}%, var(--loommark-card-surface-base))`;
}

function cardImageIndex(seed: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

class CardImageMarker implements LayerMarker {
  constructor(
    private readonly uri: string,
    private readonly surface: string,
    private readonly left: number,
    private readonly top: number,
    private readonly width: number,
    private readonly height: number,
  ) {}

  eq(other: CardImageMarker): boolean {
    return this.uri === other.uri && this.surface === other.surface && this.left === other.left && this.top === other.top
      && this.width === other.width && this.height === other.height;
  }

  draw(): HTMLElement {
    const marker = document.createElement('div');
    marker.className = 'cm-loommark-card-image';
    marker.style.left = `${this.left}px`;
    marker.style.top = `${this.top}px`;
    marker.style.width = `${this.width}px`;
    marker.style.height = `${this.height}px`;
    marker.style.background = this.surface;
    marker.style.setProperty('--loommark-card-image-opacity', String(cardImage.opacity));
    marker.style.setProperty('--loommark-card-image-blur', `${cardImage.blur}px`);
    marker.style.setProperty('--loommark-card-image-saturation', String(cardImage.saturation));
    marker.style.setProperty('--loommark-card-image-overlay', String(cardImage.overlay));
    const image = document.createElement('span');
    image.className = 'cm-loommark-card-image-media';
    image.style.backgroundImage = `url(${JSON.stringify(this.uri)})`;
    const overlay = document.createElement('span');
    overlay.className = 'cm-loommark-card-image-overlay';
    marker.append(image, overlay);
    return marker;
  }
}

let drawnCardImageRevision = -1;
const cardImageLayer = layer({
  above: false,
  class: 'cm-loommark-card-image-layer',
  update(update) {
    const changed = drawnCardImageRevision !== cardImageRevision;
    drawnCardImageRevision = cardImageRevision;
    return changed || update.docChanged || update.viewportChanged || update.geometryChanged;
  },
  markers(view): readonly LayerMarker[] {
    // tint has no real border or CardBoundaryWidget closing gap to stay clear of, so its markers
    // use a simpler geometry below; accent's rails are too thin a sliver for imagery to read.
    if (!cardImage.enabled || !cardImage.imageUris.length
      || (cardMode !== 'card' && cardMode !== 'tint')) return [];
    const bordered = cardMode === 'card';
    const source = view.state.doc.toString();
    // Outer sections must draw first. A deeper Card is a new visual surface, not a translucent
    // window onto its ancestor, so its marker must sit above the ancestor marker everywhere the
    // two ranges overlap.
    const sections = headingSections(source, headingRanges(source))
      .sort((left, right) => left.level - right.level || left.from - right.from);
    const scrollRect = view.scrollDOM.getBoundingClientRect();
    const baseLeft = scrollRect.left - view.scrollDOM.scrollLeft * view.scaleX;
    const baseTop = scrollRect.top - view.scrollDOM.scrollTop * view.scaleY;
    const contentStyle = getComputedStyle(view.contentDOM);
    const contentLeft = view.contentDOM.getBoundingClientRect().left - baseLeft
      + Number.parseFloat(contentStyle.paddingLeft);
    const contentWidth = view.contentDOM.clientWidth
      - Number.parseFloat(contentStyle.paddingLeft)
      - Number.parseFloat(contentStyle.paddingRight);
    const documentTop = view.documentTop - baseTop;
    // -first/-last card lines carry real CSS margins, which CodeMirror's height map cannot see
    // (it measures border boxes only), so lineBlockAt positions drift by the accumulated
    // margins above them. Whenever a section edge is mounted in the rendered viewport, measure
    // its actual line element instead; the BlockInfo estimate is only a fallback for edges that
    // are offscreen, where the drift cannot be seen.
    const measuredLineRect = (position: number): DOMRect | null => {
      if (position < view.viewport.from || position > view.viewport.to) return null;
      const { node } = view.domAtPos(position);
      let element = node instanceof HTMLElement ? node : node.parentElement;
      while (element && element !== view.contentDOM && !element.classList.contains('cm-line')) {
        element = element.parentElement;
      }
      return element && element !== view.contentDOM ? element.getBoundingClientRect() : null;
    };
    const markers: CardImageMarker[] = [];
    for (const section of sections) {
      if (section.to < view.viewport.from || section.from > view.viewport.to) continue;
      // The shallowest section enclosing this one decides both the horizontal margin shift its
      // lines get and this section's closing-gap clearance — the same "outer" the line
      // decorations compute per line, constant across one section's span.
      const outerSection = sections.reduce(
        (outer, other) => (other.from <= section.from && other.to >= section.to
          && other.level < outer.level ? other : outer),
        section,
      );
      const outerLevel = outerSection.level;
      // A nested section's closing gap is positioned from its line's padding box; when that
      // line is also the outer card's last line, the line additionally carries the outer's real
      // bottom border, sitting between padding box and border box. Only 'card' reserves either
      // a gap or a border in the first place — 'tint' bands run flush to each line's own edges.
      const closeLine = view.state.doc.lineAt(section.to);
      const closeBorder = bordered && section !== outerSection
        && view.state.doc.lineAt(outerSection.to).from === closeLine.from
        ? HEADING_CARD_BORDER_WIDTH : 0;
      // Stay inside every drawn edge: the outer card's real 2px border, plus a nested level's
      // own 2px gradient rail, so the image never shows outside a border line or rounded corner.
      const inset = (outerLevel - 1) * HEADING_CARD_INSET_STEP
        + (section.level - outerLevel) * HEADING_CARD_INSET_STEP
        + (bordered ? HEADING_CARD_BORDER_WIDTH + (section.level === outerLevel ? 0 : HEADING_CARD_BORDER_WIDTH) : 0);
      const openRect = measuredLineRect(section.from);
      const closeRect = measuredLineRect(section.to);
      const top = (openRect
        ? openRect.top - baseTop
        : documentTop + view.lineBlockAt(section.from).top)
        + (bordered ? HEADING_CARD_BORDER_WIDTH : 0);
      const bottom = (closeRect
        ? closeRect.bottom - baseTop
        : documentTop + view.lineBlockAt(section.to).bottom)
        - (bordered ? cardClosingGap(section.level, outerLevel) + HEADING_CARD_BORDER_WIDTH + closeBorder : 0);
      const headingLine = view.state.doc.lineAt(section.from).text;
      const uri = cardImage.imageUris[
        cardImageIndex(`${resourceBase}\0${section.level}\0${headingLine}`, cardImage.imageUris.length)
      ];
      const surfaceAccent = cardColorAt(cardBackgroundColors, section.level);
      markers.push(new CardImageMarker(
        uri,
        surfaceAccent
          ? `color-mix(in srgb, ${surfaceAccent} 8%, var(--vscode-editor-background))`
          : 'var(--vscode-editor-background)',
        contentLeft + inset,
        top,
        Math.max(0, contentWidth - inset * 2),
        Math.max(0, bottom - top),
      ));
    }
    return markers;
  },
});

// One StateField, not a selectionAwareField: which lines are inside which heading's card
// depends only on document structure, never on where the cursor is.
function buildHeadingCardDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  if (cardMode === 'off') return Decoration.set(ranges);
  const source = state.doc.toString();
  const headings = headingRanges(source);
  if (!headings.length) return Decoration.set(ranges);
  const sections = headingSections(source, headings);
  const fencedCodeLineStarts = new Set<number>();
  for (const block of detailedFencedCodeRanges(source)) {
    for (let lineNumber = block.contentStartLine; lineNumber <= block.contentEndLine; lineNumber++) {
      fencedCodeLineStarts.add(state.doc.line(lineNumber).from);
    }
  }

  // A line can be inside several nested sections at once (an H3 body line is also inside its
  // H2 and H1 ancestors' sections). Group by line first so each line is styled exactly once.
  const lineSections = new Map<number, typeof sections>();
  for (const section of sections) {
    let position = section.from;
    while (position <= section.to) {
      const line = state.doc.lineAt(position);
      let list = lineSections.get(line.from);
      if (!list) {
        list = [];
        lineSections.set(line.from, list);
      }
      list.push(section);
      position = line.to + 1;
    }
  }

  for (const [lineFrom, sectionsForLine] of lineSections) {
    const line = state.doc.lineAt(lineFrom);
    // The shallowest heading active on this line gets the real, rounded card border (card mode
    // only); a single DOM element only has one border-radius, so deeper levels nested on the
    // same line fall back to a plain (unrounded) inset line — see docs/EDITOR_TECHNOLOGY.md.
    const outer = sectionsForLine.reduce((a, b) => (a.level <= b.level ? a : b));
    const deepest = sectionsForLine.reduce((a, b) => (a.level >= b.level ? a : b));
    const outerInset = (outer.level - 1) * HEADING_CARD_INSET_STEP;
    const isOuterFirst = line.from === outer.from;
    const isOuterLast = line.to >= outer.to;
    const contentPadding = (deepest.level - outer.level) * HEADING_CARD_INSET_STEP
      + HEADING_CARD_CONTENT_PADDING;
    // Deepest first: CSS paints the first-listed background layer on top, so the narrowest
    // (innermost) band needs to come first to sit visually above the wider ancestor bands.
    const deepestFirst = [...sectionsForLine].sort((a, b) => b.level - a.level);

    const classes = ['cm-loommark-heading-card', `cm-loommark-heading-card-${cardMode}`];
    if (sectionsForLine.some((section) => section.level !== outer.level && line.from === section.from)) {
      classes.push('cm-loommark-heading-card-nested-first');
    }
    if (sectionsForLine.some((section) => section.level !== outer.level && line.to >= section.to)) {
      classes.push('cm-loommark-heading-card-nested-last');
    }
    const styleParts: string[] = [`--loommark-heading-card-color: ${headingBorderColor(outer.level) ?? 'transparent'}`];

    if (cardMode === 'tint') {
      const images: string[] = [];
      const positions: string[] = [];
      const sizes: string[] = [];
      for (const section of deepestFirst) {
        const tint = headingBackgroundTint(section.level);
        if (!tint) continue;
        const relativeInset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
        images.push(`linear-gradient(${tint}, ${tint})`);
        positions.push(`${relativeInset}px 0`);
        sizes.push(`calc(100% - ${relativeInset * 2}px) 100%`);
      }
      if (fencedCodeLineStarts.has(line.from)) {
        // Code lines lay out their own 58px line-number gutter with padding, so content inset
        // must come from margins that move the whole code panel; the backdrop pseudo-element
        // then continues the tint bands across the vacated side strips.
        classes.push('cm-loommark-card-contained-code');
        styleParts.push(
          `margin-left: ${outerInset + contentPadding}px`,
          `margin-right: ${outerInset + contentPadding}px`,
          `--loommark-card-code-gutter-left: ${contentPadding + CODE_BLOCK_BORDER_WIDTH}px`,
          `--loommark-card-code-gutter-right: ${contentPadding + CODE_BLOCK_BORDER_WIDTH}px`,
          images.length > 0 ? `--loommark-card-code-backdrop-image: ${images.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-size: ${sizes.join(', ')}` : '',
        );
      } else {
        styleParts.push(
          `margin-left: ${outerInset}px`,
          `margin-right: ${outerInset}px`,
          `padding-left: ${contentPadding}px`,
          `padding-right: ${contentPadding}px`,
          images.length > 0 ? `background-image: ${images.join(', ')}` : '',
          images.length > 0 ? `background-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `background-size: ${sizes.join(', ')}` : '',
          images.length > 0 ? 'background-repeat: no-repeat' : '',
        );
      }
    } else if (cardMode === 'accent') {
      if (fencedCodeLineStarts.has(line.from)) {
        // Same containment as tint, but the backdrop repaints the accent bars: the stacked
        // inset box-shadows resolve to one solid stripe per nested level, deepest rightmost.
        classes.push('cm-loommark-card-contained-code');
        const images: string[] = [];
        const positions: string[] = [];
        const sizes: string[] = [];
        for (const section of sectionsForLine) {
          if (section.level === outer.level) continue;
          const color = headingBorderColor(section.level);
          if (!color) continue;
          images.push(`linear-gradient(${color}, ${color})`);
          positions.push(`${(section.level - outer.level - 1) * HEADING_CARD_INSET_STEP}px 0`);
          sizes.push(`${HEADING_CARD_INSET_STEP}px 100%`);
        }
        styleParts.push(
          `margin-left: ${outerInset + contentPadding}px`,
          `--loommark-card-code-gutter-left: ${contentPadding + CODE_BLOCK_BORDER_WIDTH}px`,
          '--loommark-card-code-gutter-right: 0px',
          images.length > 0 ? `--loommark-card-code-backdrop-image: ${images.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-size: ${sizes.join(', ')}` : '',
        );
      } else {
        const shadows: string[] = [];
        for (const section of sectionsForLine) {
          const color = headingBorderColor(section.level);
          if (!color) continue;
          const relativeInset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
          shadows.push(`inset ${relativeInset}px 0 0 0 ${color}`);
        }
        styleParts.push(
          `margin-left: ${outerInset}px`,
          `padding-left: ${contentPadding}px`,
          shadows.length > 0 ? `box-shadow: ${shadows.join(', ')}` : '',
        );
      }
    } else {
      const images: string[] = [];
      const positions: string[] = [];
      const sizes: string[] = [];
      const borderImages: string[] = [];
      const borderPositions: string[] = [];
      const borderSizes: string[] = [];
      let closingBottomGap = 0;
      const boundaryWidgets: Range<Decoration>[] = [];
      for (const section of deepestFirst) {
        const relativeInset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
        const tint = headingBackgroundTint(section.level);
        // A nested level only gets its own rounded corner-trim/rail treatment when it actually
        // has a border color configured; with none, its tint (if any) is just a plain band, the
        // same as the outer level's own fill.
        const color = section.level !== outer.level ? headingBorderColor(section.level) : null;
        const hasBorder = color !== null;
        const opensHere = line.from === section.from;
        const closesHere = line.to >= section.to;
        const bottomGap = hasBorder && closesHere ? cardClosingGap(section.level, outer.level) : 0;
        const cornerRadius = 6;
        const topTrim = hasBorder && opensHere ? cornerRadius : 0;
        const bottomTrim = hasBorder && closesHere ? bottomGap + cornerRadius : 0;
        // Nested fills occupy the border's inner box rather than extending under an
        // independently antialiased rail. Sharing these inner-edge coordinates prevents a
        // one-device-pixel tint fringe from appearing beyond the right border at some zooms.
        const fillInset = relativeInset + (hasBorder ? HEADING_CARD_BORDER_WIDTH : 0);
        if (tint) {
          images.push(`linear-gradient(${tint}, ${tint})`);
          positions.push(`${fillInset}px ${topTrim}px`);
          sizes.push(
            `calc(100% - ${fillInset * 2}px) calc(100% - ${topTrim + bottomTrim}px)`,
          );
        }
        if (hasBorder) {
          closingBottomGap = Math.max(closingBottomGap, bottomGap);
          borderImages.push(`linear-gradient(${color}, ${color})`, `linear-gradient(${color}, ${color})`);
          borderPositions.push(
            `${relativeInset}px ${opensHere ? cornerRadius : 0}px`,
            `calc(100% - ${relativeInset}px - ${HEADING_CARD_BORDER_WIDTH}px) ${opensHere ? cornerRadius : 0}px`,
          );
          borderSizes.push(
            `${HEADING_CARD_BORDER_WIDTH}px calc(100% - ${opensHere ? cornerRadius : 0}px - ${closesHere ? bottomGap + cornerRadius : 0}px)`,
            `${HEADING_CARD_BORDER_WIDTH}px calc(100% - ${opensHere ? cornerRadius : 0}px - ${closesHere ? bottomGap + cornerRadius : 0}px)`,
          );
          if (opensHere) {
            boundaryWidgets.push(Decoration.widget({
              widget: new CardBoundaryWidget('open', relativeInset, 0, color, tint ?? 'transparent'),
              side: -1,
            }).range(line.from));
          }
          if (closesHere) {
            boundaryWidgets.push(Decoration.widget({
              widget: new CardBoundaryWidget('close', relativeInset, bottomGap, color, tint ?? 'transparent'),
              side: 1,
            }).range(line.to));
          }
        }
      }
      ranges.push(...boundaryWidgets);
      images.unshift(...borderImages);
      positions.unshift(...borderPositions);
      sizes.unshift(...borderSizes);
      if (isOuterFirst) classes.push('cm-loommark-heading-card-first');
      if (isOuterLast) classes.push('cm-loommark-heading-card-last');
      if (closingBottomGap > 0) styleParts.push(`padding-bottom: ${closingBottomGap}px`);
      if (fencedCodeLineStarts.has(line.from)) {
        // CodeMirror renders fenced-code content as normal .cm-line elements, unlike the
        // separate toolbar widget. Move the actual code surface into the card's content box,
        // then let a behind-the-line pseudo-element repaint the card layers across the vacated
        // gutters. This preserves the code block's own background, borders, gutter and radius.
        classes.push('cm-loommark-card-contained-code');
        // The toolbar sits in the shell's content box, which starts at margin + 2px card border
        // + content padding. Code lines have no shell, so their border box must be given that
        // same span directly for the toolbar and the code panel to share both edges exactly.
        const totalInset = outerInset + contentPadding + HEADING_CARD_BORDER_WIDTH;
        styleParts.push(
          `margin-left: ${totalInset}px`,
          `margin-right: ${totalInset}px`,
          // Absolutely positioned children use the code line's padding box as their origin,
          // which is one code-border pixel inside its border box. Reaching back to the normal
          // card rail therefore costs the content padding plus both border widths.
          `--loommark-card-code-gutter-left: ${contentPadding + HEADING_CARD_BORDER_WIDTH + CODE_BLOCK_BORDER_WIDTH}px`,
          `--loommark-card-code-gutter-right: ${contentPadding + HEADING_CARD_BORDER_WIDTH + CODE_BLOCK_BORDER_WIDTH}px`,
          images.length > 0 ? `--loommark-card-code-backdrop-image: ${images.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-size: ${sizes.join(', ')}` : '',
        );
      } else {
        styleParts.push(
          `margin-left: ${outerInset}px`,
          `margin-right: ${outerInset}px`,
          `padding-left: ${contentPadding}px`,
          `padding-right: ${contentPadding}px`,
          images.length > 0 ? `background-image: ${images.join(', ')}` : '',
          images.length > 0 ? `background-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `background-size: ${sizes.join(', ')}` : '',
          images.length > 0 ? 'background-repeat: no-repeat' : '',
        );
      }
    }

    ranges.push(Decoration.line({
      attributes: { class: classes.join(' '), style: styleParts.filter(Boolean).join('; ') },
    }).range(line.from));
  }
  return Decoration.set(ranges, true);
}

const headingCardField = StateField.define<DecorationSet>({
  create: buildHeadingCardDecorations,
  update(value, transaction) {
    if (transaction.docChanged || transaction.effects.some((effect) => effect.is(decorationsRefresh))) {
      return buildHeadingCardDecorations(transaction.state);
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const mathField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  for (const math of mathRanges(source)) {
    const startLine = state.doc.lineAt(math.from);
    const endLine = state.doc.lineAt(math.to);
    const multiLine = startLine.number !== endLine.number;
    const ownLine = multiLine
      || source.slice(startLine.from, endLine.to).trim() === source.slice(math.from, math.to);
    if (math.display && ownLine) {
      if (cursor >= startLine.from && cursor <= endLine.to) continue;
      ranges.push(Decoration.replace({
        widget: new MathWidget(math, true, blockCardPresentation(source, math.from)),
        block: true,
      }).range(startLine.from, endLine.to));
    } else {
      if (cursor >= math.from && cursor <= math.to) continue;
      ranges.push(Decoration.replace({
        widget: new MathWidget(math, false),
      }).range(math.from, math.to));
    }
  }
  return Decoration.set(ranges, true);
});

const quoteField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  for (const quote of quoteLineRanges(source)) {
    const line = state.doc.lineAt(quote.lineFrom);
    ranges.push(Decoration.line({
      attributes: { class: `cm-loommark-quote cm-loommark-quote-depth-${Math.min(quote.depth, 3)}` },
    }).range(line.from));
    if (!(cursor >= line.from && cursor <= line.to)) {
      ranges.push(Decoration.replace({
        widget: new QuoteMarkerWidget(quote.depth),
      }).range(quote.markerFrom, quote.markerTo));
    }
  }
  for (const rule of horizontalRuleRanges(source)) {
    const line = state.doc.lineAt(rule.from);
    if (cursor >= line.from && cursor <= line.to) continue;
    ranges.push(Decoration.replace({ widget: new HorizontalRuleWidget() }).range(rule.from, rule.to));
  }
  return Decoration.set(ranges, true);
});

// Marks rendered images, tables, and math as atomic so keyboard cursor motion skips over them
// instead of stepping in to reveal source. The set mirrors whatever those fields currently render,
// so a range stops being atomic exactly when its widget yields to source (e.g. after a click).
// Enabling keyboard editing empties the set, letting the cursor enter and edit with the keyboard.
class AtomicMarker extends RangeValue {}
const atomicMarker = new AtomicMarker();

function buildAtomicRanges(state: EditorState): RangeSet<AtomicMarker> {
  if (keyboardEditing) return RangeSet.empty;
  const ranges: Range<AtomicMarker>[] = [];
  for (const field of [tableField, imageField, mathField]) {
    for (const iter = state.field(field).iter(); iter.value; iter.next()) {
      // Only ranges actually replaced by a widget should block cursor motion. These
      // fields also emit plain Decoration.mark entries (e.g. the click-to-open attribute
      // on an image shown as source, cursor already inside); marking those atomic too
      // creates a range that is simultaneously "selected here" and "cursor can't enter",
      // which a direct selection assignment (like the search panel's Next button) can
      // land on, confusing CodeMirror's own selection handling.
      if (!iter.value.spec.widget) continue;
      ranges.push(atomicMarker.range(iter.from, iter.to));
    }
  }
  return RangeSet.of(ranges, true);
}

const atomicRangesField = StateField.define<RangeSet<AtomicMarker>>({
  create: buildAtomicRanges,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection
      || transaction.effects.some((effect) => effect.is(decorationsRefresh))) {
      return buildAtomicRanges(transaction.state);
    }
    return value.map(transaction.changes);
  },
});

const keyboardAtomicRanges = [
  atomicRangesField,
  EditorView.atomicRanges.of((view) => view.state.field(atomicRangesField)),
];

function buildCodeToolbarDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const source = state.doc.toString();
  for (const block of detailedFencedCodeRanges(source)) {
    const position = state.doc.line(block.contentStartLine).from;
    ranges.push(Decoration.widget({
      widget: new CodeToolbarWidget(block, blockCardPresentation(source, block.openFrom)),
      block: true,
      side: -1,
    }).range(position));
  }
  return Decoration.set(ranges, true);
}

function buildHeadingDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber++) {
    const line = view.state.doc.line(lineNumber);
    const match = line.text.match(/^( {0,3})(#{1,6})(\s+)/);
    if (!match) continue;
    const level = match[2].length;
    const active = cursor >= line.from && cursor <= line.to;
    ranges.push(Decoration.line({
      attributes: { class: `cm-loommark-heading cm-loommark-h${level}${active ? ' cm-loommark-heading-active' : ''}` },
    }).range(line.from));
    if (!active) {
      const markerEnd = line.from + match[1].length + match[2].length + match[3].length;
      ranges.push(Decoration.replace({}).range(line.from, markerEnd));
    }
  }
  return Decoration.set(ranges, true);
}

function buildInlineDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  const excluded = [
    ...codeRanges(source),
    ...linkDestinationRanges(source),
    ...tagRanges(source),
  ];
  // Content group matches a single non-space char alone, or a non-space char followed by
  // anything lazily ending in a non-space char — unlike `(?=\S)(.+?\S)`, this also matches
  // single-character content (`**a**`), which needs at least two characters to satisfy.
  const patterns = [
    /\*\*(\S(?:.*?\S)?)\*\*/g,
    /__(\S(?:.*?\S)?)__/g,
    /~~(\S(?:.*?\S)?)~~/g,
    /(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)/g,
    /(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (containsPosition(excluded, from) || isEscaped(source, from)) continue;
      const markerLength = match[0].startsWith('**') || match[0].startsWith('__')
        || match[0].startsWith('~~') ? 2 : 1;
      // A backslash-escaped closing marker (`**bold\**`) is not a real delimiter either;
      // leave the whole span as plain text instead of treating it as emphasis.
      if (isEscaped(source, to - markerLength)) continue;
      addHiddenSyntax(ranges, cursor, from, from + markerLength);
      addHiddenSyntax(ranges, cursor, to - markerLength, to);
    }
  }
  return Decoration.set(ranges, true);
}

function buildLinkDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  const excluded = codeRanges(source);
  const wikiRanges: Array<{ from: number; to: number }> = [];
  const wikiPattern = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;

  for (const match of source.matchAll(wikiPattern)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (containsPosition(excluded, from) || isEscaped(source, from)) continue;
    wikiRanges.push({ from, to });
    const target = match[1].trim();
    const pipe = match[0].indexOf('|');
    const labelFrom = pipe < 0 ? from + 2 : from + pipe + 1;
    const labelTo = to - 2;
    addHiddenSyntax(ranges, cursor, from, labelFrom);
    addHiddenSyntax(ranges, cursor, labelTo, to);
    ranges.push(Decoration.mark({
      attributes: {
        class: 'cm-loommark-link cm-loommark-wiki-link',
        'data-loommark-href': target,
        'data-loommark-wiki': 'true',
      },
    }).range(labelFrom, labelTo));
  }

  const linkPattern = /\[([^\]\n]+)\]\((?:<([^<>\n]*)>|([^\s)]+))(?:\s+["'][^"'\n]*["'])?\)/g;
  for (const match of source.matchAll(linkPattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (from > 0 && source[from - 1] === '!') continue;
      if (containsPosition(excluded, from) || isEscaped(source, from)) continue;
      if (wikiRanges.some((range) => from < range.to && to > range.from)) continue;
      const labelFrom = from + 1;
      const labelTo = labelFrom + match[1].length;
      addHiddenSyntax(ranges, cursor, from, labelFrom);
      addHiddenSyntax(ranges, cursor, labelTo, to);
      ranges.push(Decoration.mark({
        attributes: { class: 'cm-loommark-link', 'data-loommark-href': match[2] ?? match[3] },
      }).range(labelFrom, labelTo));
  }
  return Decoration.set(ranges, true);
}

function buildTagDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const source = view.state.doc.toString();
  for (const tag of tagRanges(source)) {
    ranges.push(Decoration.mark({
      attributes: { class: 'cm-loommark-tag' },
    }).range(tag.from, tag.to));
  }
  return Decoration.set(ranges, true);
}

function buildEscapedCharDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  for (const escape of escapedCharRanges(source)) {
    // Hide only the backslash; the escaped character stays visible as plain text.
    addHiddenSyntax(ranges, cursor, escape.from, escape.from + 1);
  }
  return Decoration.set(ranges, true);
}

function buildInlineCodeDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  for (const range of inlineCodeRanges(source, fencedCodeRanges(source))) {
    const markerLength = range.markerLength;
    addHiddenSyntax(ranges, cursor, range.from, range.from + markerLength);
    addHiddenSyntax(ranges, cursor, range.to - markerLength, range.to);
    ranges.push(Decoration.mark({
      attributes: { class: 'cm-loommark-inline-code' },
    }).range(range.from + markerLength, range.to - markerLength));
  }
  return Decoration.set(ranges, true);
}

function buildFencedCodeDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  for (const block of detailedFencedCodeRanges(view.state.doc.toString())) {
    const fenceActive = view.hasFocus && (
      cursor >= block.openFrom && cursor <= block.openTo
      || block.closeFrom !== undefined && block.closeTo !== undefined
        && cursor >= block.closeFrom && cursor <= block.closeTo
    );
    for (let lineNumber = block.contentStartLine; lineNumber <= block.contentEndLine; lineNumber++) {
      const line = view.state.doc.line(lineNumber);
      ranges.push(Decoration.line({
        attributes: {
          class: `cm-loommark-code-block-line${lineNumber === block.contentStartLine ? ' cm-loommark-code-block-first' : ''}${lineNumber === block.contentEndLine ? ' cm-loommark-code-block-last' : ''}`,
          'data-line-number': String(lineNumber - block.contentStartLine + 1),
        },
      }).range(line.from));
    }
    if (!fenceActive) {
      ranges.push(Decoration.replace({}).range(block.openFrom, block.openTo));
      if (block.closeFrom !== undefined && block.closeTo !== undefined) {
        ranges.push(Decoration.replace({}).range(block.closeFrom, block.closeTo));
      }
    }
  }
  return Decoration.set(ranges, true);
}

function isCursorInFencedCode(view: EditorView): boolean {
  const cursor = view.state.selection.main.head;
  return detailedFencedCodeRanges(view.state.doc.toString()).some((block) => {
    const contentFrom = view.state.doc.line(block.contentStartLine).from;
    const contentTo = view.state.doc.line(block.contentEndLine).to;
    return cursor >= contentFrom && cursor <= contentTo;
  });
}

function addHiddenSyntax(
  ranges: Range<Decoration>[],
  cursor: number,
  from: number,
  to: number,
): void {
  if (from < to && !(cursor >= from && cursor <= to)) {
    ranges.push(Decoration.replace({}).range(from, to));
  }
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing editor element: ${selector}`);
  return element;
}

function saveState(): void {
  vscode.setState({
    text: sourceText,
    documentRevision,
    outlineCollapsed,
    cursor: editor?.state.selection.main.head,
  });
}

function scheduleSync(): void {
  window.clearTimeout(timer);
  if (applyingHostUpdate) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    clientRevision++;
    pendingEdits.set(clientRevision, localGeneration);
    vscode.postMessage({
      type: 'edit',
      text: sourceText,
      baseRevision: documentRevision,
      clientRevision,
    });
    status.textContent = 'Syncing...';
  }, syncDelay);
}

// Complete only unambiguous block delimiters typed on an otherwise empty line. This is a local
// insertion at the cursor, not a Markdown serialization pass, so surrounding source remains exact.
// The cursor stays after the opening fence so a language name can still be entered normally.
const completeBlockDelimiters = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || text.length !== 1) return false;
  const line = view.state.doc.lineAt(from);
  if (view.state.doc.sliceString(from, line.to).trim() !== '') return false;
  const before = view.state.doc.sliceString(line.from, from);
  const indent = before.match(/^ {0,3}/)?.[0] ?? '';

  let insertion: string | undefined;
  if (text === '`' && before === `${indent}\`\``) {
    insertion = `\`\n\n${indent}\`\`\``;
  } else if (text === '~' && before === `${indent}~~`) {
    insertion = `~\n\n${indent}~~~`;
  } else if (text === '$' && before === `${indent}$`) {
    insertion = `$\n\n${indent}$$`;
  }
  if (!insertion) return false;

  view.dispatch({
    changes: { from, to, insert: insertion },
    selection: { anchor: from + 1 },
    userEvent: 'input.type',
  });
  return true;
});

function enterCompletedBlock(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return false;
  const code = line.text.match(/^( {0,3})(```|~~~)[^\n]*$/);
  const math = line.text.match(/^( {0,3})(\$\$)\s*$/);
  const match = code ?? math;
  if (!match) return false;
  const expectedClose = `${match[1]}${match[2]}`;
  const after = view.state.doc.sliceString(selection.head, selection.head + expectedClose.length + 2);
  if (after !== `\n\n${expectedClose}`) return false;
  view.dispatch({ selection: { anchor: selection.head + 1 }, scrollIntoView: true });
  return true;
}

function createEditor(text: string): void {
  editor?.destroy();
  root.replaceChildren();
  editorInitializationError = undefined;
  try {
    editor = new EditorView({
      parent: root,
      state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        markdown({ extensions: [GFM], codeLanguages: languages }),
        autocompletion({ override: [fileLinkCompletions] }),
        search({ top: true }),
        completeBlockDelimiters,
        // Matches LIST_INDENT_WIDTH: CommonMark requires a nested ordered item's content to
        // reach its parent's content column (3-4+ characters), which 2 spaces never satisfies.
        indentUnit.of(' '.repeat(LIST_INDENT_WIDTH)),
        keymap.of([
          { key: 'Enter', run: enterCompletedBlock },
          indentWithTab,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        cardImageLayer,
        headingDecorations,
        headingCardField,
        inlineDecorations,
        inlineCodeDecorations,
        fencedCodeDecorations,
        codeToolbarField,
        tableField,
        imageField,
        listField,
        listGuideField,
        quoteField,
        mathField,
        keyboardAtomicRanges,
        codeCursorAttributes,
        linkDecorations,
        tagDecorations,
        escapedCharDecorations,
        syntaxHighlighting(markdownHighlightStyle),
        EditorView.updateListener.of((update) => {
          if (applyingHostUpdate) return;
          if (update.docChanged) {
            sourceText = update.state.doc.toString();
            localGeneration++;
            scheduleSync();
            refreshOutline();
          }
          if (update.docChanged || update.selectionSet) saveState();
        }),
      ],
      }),
    });
    if (!initialCursorRestored && savedState?.cursor !== undefined) {
      editor.dispatch({
        selection: { anchor: Math.min(savedState.cursor, text.length) },
        scrollIntoView: true,
      });
    }
    initialCursorRestored = true;
  } catch (error: unknown) {
    editor = undefined;
    editorInitializationError = error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error);
    root.replaceChildren();
    const failure = document.createElement('pre');
    failure.className = 'loommark-editor-error';
    failure.textContent = `LoomMark editor failed to initialize.\n\n${editorInitializationError}`;
    root.append(failure);
  }
  refreshOutline();
}

root.addEventListener('mousedown', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-loommark-href]');
  lastPointerDiagnostic = {
    type: event.type,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    button: event.button,
    target: (event.target as HTMLElement).outerHTML?.slice(0, 500),
    matchedLink: link?.outerHTML.slice(0, 500),
  };
  if (!event.ctrlKey && !event.metaKey) return;
  if (!link) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  lastLinkRequest = {
    href: link.dataset.loommarkHref ?? '',
    wiki: link.dataset.loommarkWiki === 'true',
  };
  vscode.postMessage({
    type: 'openLink',
    href: link.dataset.loommarkHref ?? '',
    wiki: link.dataset.loommarkWiki === 'true',
  });
}, true);

root.addEventListener('mousemove', (event) => {
  const target = event.target as HTMLElement;
  const visual = target.closest<HTMLElement>(
    '.cm-loommark-card-image, .cm-loommark-math, .cm-loommark-heading-card, .cm-loommark-block-card-shell',
  );
  if (!visual) return;
  const rect = visual.getBoundingClientRect();
  const style = getComputedStyle(visual);
  lastVisualHoverDiagnostic = {
    target: target.outerHTML?.slice(0, 400),
    visual: visual.outerHTML.slice(0, 600),
    className: visual.className,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    background: style.background,
    backgroundImage: style.backgroundImage,
    opacity: style.opacity,
    zIndex: style.zIndex,
  };
});

function wikiFileDetail(target: string): string {
  // Extensionless targets follow the Obsidian-style Markdown convention used by
  // findWikiFiles; everything else keeps its extension, which becomes the detail label.
  const extension = /\.([^./]+)$/.exec(target)?.[1];
  return extension ? `${extension} file` : 'Markdown file';
}

function fileLinkCompletions(context: CompletionContext): CompletionResult | null {
  const wikiMatch = context.matchBefore(/\[\[[^\]\n|]*/);
  const markdownMatch = context.matchBefore(/\[[^\]\n]*\]\([^\s)\n]*/);
  const match = wikiMatch ?? markdownMatch;
  if (!match) return null;
  const wiki = Boolean(wikiMatch);
  const targetStart = wiki ? match.from + 2 : match.from + match.text.lastIndexOf('(') + 1;
  return {
    from: targetStart,
    options: wikiFiles.map((target) => ({
      label: target,
      detail: wikiFileDetail(target),
      type: 'file',
      apply(view, _completion, from, to) {
        const closing = wiki ? ']]' : ')';
        const suffix = view.state.doc.sliceString(to, to + closing.length) === closing ? '' : closing;
        view.dispatch({
          changes: { from, to, insert: target + suffix },
          selection: { anchor: from + target.length },
        });
      },
    })),
    validFor: wiki ? /^[^\]\n|]*$/ : /^[^\s)\n]*$/,
  };
}

function applyHostText(text: string): void {
  if (!editor) {
    sourceText = text;
    createEditor(text);
    return;
  }
  if (text === editor.state.doc.toString()) return;
  applyingHostUpdate = true;
  const selection = editor.state.selection;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
    selection: {
      anchor: Math.min(selection.main.anchor, text.length),
      head: Math.min(selection.main.head, text.length),
    },
  });
  sourceText = text;
  applyingHostUpdate = false;
  refreshOutline();
}

function headingsFromSource(source: string): Heading[] {
  const tree = fromMarkdown(source) as MdastNode;
  const headings: Heading[] = [];
  const text = (node: MdastNode): string => node.value ?? (node.children ?? []).map(text).join('');
  for (const node of tree.children ?? []) {
    if (node.type !== 'heading') continue;
    headings.push({
      label: text(node).trim() || `Untitled H${node.depth ?? 1}`,
      level: node.depth ?? 1,
      offset: node.position?.start?.offset ?? 0,
    });
  }
  return headings;
}

function revealHeading(heading: Heading): void {
  if (!editor) return;
  editor.dispatch({ selection: { anchor: heading.offset }, scrollIntoView: true });
  editor.focus();
}

function refreshOutline(): void {
  const headings = headingsFromSource(sourceText);
  outlineList.replaceChildren();
  headings.forEach((heading) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-item';
    button.style.setProperty('--outline-level', String(heading.level - 1));
    button.textContent = heading.label;
    button.addEventListener('click', () => revealHeading(heading));
    item.append(button);
    outlineList.append(item);
  });
  outlineEmpty.hidden = headings.length > 0;
}

function setOutlineCollapsed(collapsed: boolean): void {
  outlineCollapsed = collapsed;
  document.body.classList.toggle('outline-collapsed', collapsed);
  outline.setAttribute('aria-hidden', String(collapsed));
  outlineToggle.ariaExpanded = String(!collapsed);
  outlineFab.ariaExpanded = String(!collapsed);
  saveState();
}

function applyConfiguration(config: EditorConfiguration): void {
  syncDelay = config.syncDelay;
  document.body.dataset.loommarkTheme = config.theme;
  const background = config.background;
  backgroundDiagnostic = background;
  const hasBackground = background.enabled && Boolean(background.imageUri);
  document.body.classList.toggle('loommark-has-background', hasBackground);
  document.body.style.setProperty(
    '--loommark-background-image',
    hasBackground ? `url(${JSON.stringify(background.imageUri)})` : 'none',
  );
  document.body.style.setProperty('--loommark-background-opacity', String(background.opacity));
  document.body.style.setProperty('--loommark-background-blur', `${background.blur}px`);
  document.body.style.setProperty('--loommark-background-saturation', String(background.saturation));
  document.body.style.setProperty('--loommark-background-overlay', String(background.overlay));
  const nextCardImage = config.cardImage;
  document.body.classList.toggle(
    'loommark-has-card-images',
    nextCardImage.enabled && nextCardImage.status === 'loaded' && nextCardImage.imageUris.length > 0,
  );
  document.body.classList.toggle(
    'editor-outline-disabled',
    config.outline === 'explorer' || config.outline === 'off',
  );
  document.body.classList.toggle('loommark-table-ruled', config.tableStyle === 'ruled');
  const needsRefresh = tableMode !== config.table
    || tableStyle !== config.tableStyle
    || orderedListStyle !== config.orderedListStyle
    || keyboardEditing !== config.keyboardEditing
    || listGuidesEnabled !== config.listGuides
    || cardMode !== config.cardMode
    || cardBackgroundStrength !== config.cardBackgroundStrength
    || cardBorderStrength !== config.cardBorderStrength
    || JSON.stringify(cardImage) !== JSON.stringify(nextCardImage)
    || cardBackgroundColors.join(' ') !== config.cardBackgroundColors.join(' ')
    || cardBorderColors.join(' ') !== config.cardBorderColors.join(' ');
  tableMode = config.table;
  tableStyle = config.tableStyle;
  orderedListStyle = config.orderedListStyle;
  keyboardEditing = config.keyboardEditing;
  listGuidesEnabled = config.listGuides;
  cardMode = config.cardMode;
  cardBackgroundColors = config.cardBackgroundColors;
  cardBorderColors = config.cardBorderColors;
  cardBackgroundStrength = config.cardBackgroundStrength;
  cardBorderStrength = config.cardBorderStrength;
  cardImage = nextCardImage;
  if (needsRefresh) cardImageRevision++;
  if (needsRefresh) editor?.dispatch({ effects: decorationsRefresh.of(null) });
}

outlineToggle.addEventListener('click', () => {
  setOutlineCollapsed(true);
  outlineFab.focus();
});
outlineFab.addEventListener('click', () => {
  setOutlineCollapsed(false);
  outlineToggle.focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !outlineCollapsed) setOutlineCollapsed(true);
});
setOutlineCollapsed(outlineCollapsed);

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  if (message.type === 'init') {
    sourceText = message.text;
    documentRevision = message.revision;
    resourceBase = message.resourceBase;
    wikiFiles = message.wikiFiles;
    applyConfiguration(message);
    createEditor(message.text);
    status.textContent = '';
    saveState();
  } else if (message.type === 'configuration') {
    applyConfiguration(message);
  } else if (message.type === 'ack') {
    documentRevision = message.documentRevision;
    const sentGeneration = pendingEdits.get(message.clientRevision);
    pendingEdits.delete(message.clientRevision);
    if (sentGeneration === localGeneration && message.text !== sourceText) {
      applyHostText(message.text);
    }
    status.textContent = '';
    saveState();
  } else if (message.type === 'documentChanged') {
    if (timer !== undefined || pendingEdits.size > 0) return;
    window.clearTimeout(timer);
    timer = undefined;
    documentRevision = message.documentRevision;
    applyHostText(message.text);
    status.textContent = '';
    saveState();
  } else if (message.type === 'revealHeading') {
    const heading = headingsFromSource(sourceText)[message.ordinal];
    if (heading) revealHeading(heading);
  } else if (message.type === 'wikiFilesChanged') {
    wikiFiles = message.wikiFiles;
  } else if (message.type === 'linkOpenResult') {
    lastHostLinkResult = { ...message, receivedAt: new Date().toISOString() };
  } else if (message.type === 'requestDiagnostics') {
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).map((line) => ({
      text: line.textContent,
      html: line.innerHTML,
    }));
    const report = JSON.stringify({
      documentRevision,
      localGeneration,
      pendingEdits: pendingEdits.size,
      background: backgroundDiagnostic,
      backgroundBodyClass: document.body.className,
      backgroundImageStyle: document.body.style.getPropertyValue('--loommark-background-image'),
      cardImage: {
        ...cardImage,
        imageUris: cardImage.imageUris.slice(0, 10),
        renderedCards: document.querySelectorAll('.cm-loommark-card-image').length,
      },
      wikiFileCount: wikiFiles.length,
      wikiFiles: wikiFiles.slice(0, 50),
      completionStatus: editor ? completionStatus(editor.state) : null,
      fencedCodeRanges: detailedFencedCodeRanges(sourceText),
      editorClasses: editor?.dom.className,
      codeLines: Array.from(document.querySelectorAll<HTMLElement>('.cm-loommark-code-block-line'))
        .map((line) => ({
          text: line.textContent,
          className: line.className,
          background: getComputedStyle(line).backgroundColor,
          color: getComputedStyle(line).color,
        })),
      codeGeometry: Array.from(document.querySelectorAll<HTMLElement>('.cm-loommark-code-toolbar'))
        .map((toolbar) => {
          const code = toolbar.parentElement?.nextElementSibling?.classList.contains('cm-line')
            ? toolbar.parentElement.nextElementSibling as HTMLElement
            : undefined;
          const toolbarRect = toolbar.getBoundingClientRect();
          const codeRect = code?.getBoundingClientRect();
          return {
            toolbar: { left: toolbarRect.left, right: toolbarRect.right, width: toolbarRect.width },
            code: codeRect && { left: codeRect.left, right: codeRect.right, width: codeRect.width },
          };
        }),
      visualLayers: Array.from(document.querySelectorAll<HTMLElement>(
        '.cm-loommark-card-image, .cm-loommark-math.is-block, .cm-loommark-heading-card',
      )).map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          className: element.className,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          background: style.background,
          backgroundImage: style.backgroundImage,
          opacity: style.opacity,
          zIndex: style.zIndex,
        };
      }),
      cursorStyles: Array.from(document.querySelectorAll<HTMLElement>('.cm-cursor')).map((cursor) => ({
        className: cursor.className,
        borderLeftColor: getComputedStyle(cursor).borderLeftColor,
        borderLeftWidth: getComputedStyle(cursor).borderLeftWidth,
      })),
      activeElement: document.activeElement?.className || document.activeElement?.tagName,
      sourceMatches: {
        wiki: Array.from(sourceText.matchAll(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g))
          .map((match) => match[0]),
        markdown: Array.from(sourceText.matchAll(/\[([^\]\n]+)\]\(([^\s)]+)(?:\s+["'][^"'\n]*["'])?\)/g))
          .map((match) => match[0]),
      },
      linkElements: Array.from(document.querySelectorAll<HTMLElement>('[data-loommark-href]'))
        .map((element) => ({
          text: element.textContent,
          href: element.dataset.loommarkHref,
          wiki: element.dataset.loommarkWiki,
          html: element.outerHTML,
        })),
      lastPointerDiagnostic,
      lastVisualHoverDiagnostic,
      lastLinkRequest,
      lastHostLinkResult,
      editorLoaded: Boolean(editor),
      editorInitializationError,
      editorText: editor?.state.doc.toString(),
      classes: Array.from(document.querySelectorAll<HTMLElement>('[class*="loommark"]'))
        .map((element) => element.className),
      lines,
    }, null, 2);
    vscode.postMessage({ type: 'diagnostics', report });
  }
});

// When the VS Code window (or this webview's tab) regains focus, VS Code focuses the webview
// container itself but has no way to know which inner element should get it back — Chromium
// then leaves document.activeElement on <body>, and a browser never draws a caret in a
// non-focused editable region, so the cursor simply doesn't render until something is clicked.
// Restore it automatically, but only when nothing else (an outline button, a table cell) has
// already legitimately reclaimed focus. Both events are registered since it is not guaranteed
// which one a given VS Code webview host actually dispatches on tab/window reactivation.
function restoreEditorFocusIfIdle(): void {
  const active = document.activeElement;
  if (editor && (!active || active === document.body)) editor.focus();
}
window.addEventListener('focus', restoreEditorFocusIfIdle);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') restoreEditorFocusIfIdle();
});

window.addEventListener('beforeunload', () => {
  window.clearTimeout(timer);
  editor?.destroy();
});
vscode.postMessage({ type: 'ready' });
