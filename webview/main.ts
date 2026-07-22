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
let cardMode: CardMode = 'card';
let cardColors: string[] = [];
let keyboardEditing = false;
let clientRevision = 0;
let syncDelay = 180;
let timer: number | undefined;
let editor: EditorView | undefined;
let applyingHostUpdate = false;
let wikiFiles: string[] = [];
let lastPointerDiagnostic: Record<string, unknown> | undefined;
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
    if (item.task?.checked) {
      ranges.push(Decoration.line({
        attributes: { class: 'cm-loommark-task-done' },
      }).range(item.lineFrom));
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
  const style = [`--loommark-heading-card-color: ${headingLevelColor(outer.level)}`];

  if (cardMode === 'tint') {
    const layers = deepestFirst.map((section) => {
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return `linear-gradient(${headingBackgroundTint(section.level)}, ${headingBackgroundTint(section.level)}) ${inset}px 0 / calc(100% - ${inset * 2}px) 100% no-repeat`;
    });
    style.push(`margin-left: ${outerInset}px`, `margin-right: ${outerInset}px`, `background: ${layers.join(', ')}`);
  } else if (cardMode === 'accent') {
    const shadows = active.map((section) => {
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return `inset ${inset}px 0 0 0 ${headingLevelColor(section.level)}`;
    });
    style.push(`margin-left: ${outerInset}px`, `padding-left: ${contentPadding}px`, `box-shadow: ${shadows.join(', ')}`);
  } else {
    const tintLayers = deepestFirst.map((section) => {
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return `linear-gradient(${headingBackgroundTint(section.level)}, ${headingBackgroundTint(section.level)}) ${inset}px 0 / calc(100% - ${inset * 2}px) 100% no-repeat`;
    });
    const borderLayers = active.filter((section) => section.level !== outer.level).flatMap((section) => {
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      const color = headingLevelColor(section.level);
      return [
        `linear-gradient(${color}, ${color}) ${inset}px 0 / ${HEADING_CARD_BORDER_WIDTH}px 100% no-repeat`,
        `linear-gradient(${color}, ${color}) calc(100% - ${inset}px - ${HEADING_CARD_BORDER_WIDTH}px) 0 / ${HEADING_CARD_BORDER_WIDTH}px 100% no-repeat`,
      ];
    });
    style.push(
      `margin-left: ${outerInset}px`, `margin-right: ${outerInset}px`,
      `padding-left: ${contentPadding}px`, `padding-right: ${contentPadding}px`,
      `background: ${[...borderLayers, ...tintLayers].join(', ')}`,
    );
  }
  return {
    className: `cm-loommark-heading-card cm-loommark-heading-card-${cardMode}`,
    style: style.filter(Boolean).join('; '),
  };
}

// loommark.cardColors overrides the built-in six-hue palette when non-empty, cycling by level.
function headingLevelColor(level: number): string {
  if (cardColors.length > 0) return cardColors[(level - 1) % cardColors.length];
  return `var(--loommark-guide-${(level - 1) % 6})`;
}

// Border/rail lines stay close to full color so they read clearly; background fills use a very
// light tint instead — a background wash strong enough to read as a "color" behind body text
// makes the text itself harder to read, which is the opposite of what this feature is for.
function headingBackgroundTint(level: number): string {
  return `color-mix(in srgb, ${headingLevelColor(level)} 7%, transparent)`;
}

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
    const styleParts: string[] = [`--loommark-heading-card-color: ${headingLevelColor(outer.level)}`];

    if (cardMode === 'tint') {
      const images: string[] = [];
      const positions: string[] = [];
      const sizes: string[] = [];
      for (const section of deepestFirst) {
        const relativeInset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
        const tint = headingBackgroundTint(section.level);
        images.push(`linear-gradient(${tint}, ${tint})`);
        positions.push(`${relativeInset}px 0`);
        sizes.push(`calc(100% - ${relativeInset * 2}px) 100%`);
      }
      styleParts.push(
        `margin-left: ${outerInset}px`,
        `margin-right: ${outerInset}px`,
        `background-image: ${images.join(', ')}`,
        `background-position: ${positions.join(', ')}`,
        `background-size: ${sizes.join(', ')}`,
        'background-repeat: no-repeat',
      );
    } else if (cardMode === 'accent') {
      const shadows = sectionsForLine.map((section) => {
        const relativeInset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
        return `inset ${relativeInset}px 0 0 0 ${headingLevelColor(section.level)}`;
      });
      styleParts.push(
        `margin-left: ${outerInset}px`,
        `padding-left: ${contentPadding}px`,
        `box-shadow: ${shadows.join(', ')}`,
      );
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
        images.push(`linear-gradient(${tint}, ${tint})`);
        positions.push(`${relativeInset}px 0`);
        sizes.push(`calc(100% - ${relativeInset * 2}px) 100%`);
        if (section.level !== outer.level) {
          const color = headingLevelColor(section.level);
          const closesHere = line.to >= section.to;
          const opensHere = line.from === section.from;
          const bottomGap = closesHere ? 8 + (section.level - outer.level - 1) * 4 : 0;
          const cornerRadius = 6;
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
          if (line.from === section.from) {
            boundaryWidgets.push(Decoration.widget({
              widget: new CardBoundaryWidget('open', relativeInset, 0, color),
              side: -1,
            }).range(line.from));
          }
          if (closesHere) {
            boundaryWidgets.push(Decoration.widget({
              widget: new CardBoundaryWidget('close', relativeInset, bottomGap, color),
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
        const totalInset = outerInset + contentPadding + HEADING_CARD_BORDER_WIDTH;
        styleParts.push(
          `margin-left: ${totalInset}px`,
          `margin-right: ${totalInset}px`,
          // The backdrop is absolutely positioned from the code line's padding box, one code
          // border-width inside its visible edge. Include that 1px only in the backdrop reach;
          // the code panel itself already aligns with the toolbar and must not move again.
          `--loommark-card-code-gutter: ${contentPadding + HEADING_CARD_BORDER_WIDTH + CODE_BLOCK_BORDER_WIDTH}px`,
          `--loommark-card-code-backdrop-image: ${images.join(', ')}`,
          `--loommark-card-code-backdrop-position: ${positions.join(', ')}`,
          `--loommark-card-code-backdrop-size: ${sizes.join(', ')}`,
        );
      } else {
        styleParts.push(
          `margin-left: ${outerInset}px`,
          `margin-right: ${outerInset}px`,
          `padding-left: ${contentPadding}px`,
          `padding-right: ${contentPadding}px`,
          `background-image: ${images.join(', ')}`,
          `background-position: ${positions.join(', ')}`,
          `background-size: ${sizes.join(', ')}`,
          'background-repeat: no-repeat',
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
        autocompletion({ override: [wikiLinkCompletions] }),
        search({ top: true }),
        // Matches LIST_INDENT_WIDTH: CommonMark requires a nested ordered item's content to
        // reach its parent's content column (3-4+ characters), which 2 spaces never satisfies.
        indentUnit.of(' '.repeat(LIST_INDENT_WIDTH)),
        keymap.of([indentWithTab, ...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
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

function wikiFileDetail(target: string): string {
  // Extensionless targets follow the Obsidian-style Markdown convention used by
  // findWikiFiles; everything else keeps its extension, which becomes the detail label.
  const extension = /\.([^./]+)$/.exec(target)?.[1];
  return extension ? `${extension} file` : 'Markdown file';
}

function wikiLinkCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\[\[[^\]\n|]*/);
  if (!match) return null;
  return {
    from: match.from + 2,
    options: wikiFiles.map((target) => ({
      label: target,
      detail: wikiFileDetail(target),
      type: 'file',
      apply(view, _completion, from, to) {
        const suffix = view.state.doc.sliceString(to, to + 2) === ']]' ? '' : ']]';
        view.dispatch({
          changes: { from, to, insert: target + suffix },
          selection: { anchor: from + target.length },
        });
      },
    })),
    validFor: /^[^\]\n|]*$/,
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
    || cardColors.join(' ') !== config.cardColors.join(' ');
  tableMode = config.table;
  tableStyle = config.tableStyle;
  orderedListStyle = config.orderedListStyle;
  keyboardEditing = config.keyboardEditing;
  listGuidesEnabled = config.listGuides;
  cardMode = config.cardMode;
  cardColors = config.cardColors;
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
