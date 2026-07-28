import {
  annotationRanges,
  resolveAnnotationTarget,
  type AnnotationRange,
  type SourceRange,
} from '@llingshu/loommark-core';
import {
  EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view';

// Toggles whether annotation markers render at all. The underlying annotation source stays
// hidden either way — this only controls the "always shown" markers themselves.
export const toggleAnnotationsVisible = StateEffect.define<void>();

// A pure "recompute the decorations" signal, for state this StateField's own build function reads
// but that doesn't live in the document text or in annotationsVisibleField — right now just
// collapsedAnnotations (a plain module-level Set, not CodeMirror state of its own, the same way
// TableWidget's pendingTableFocus isn't either).
const refreshAnnotations = StateEffect.define<void>();

const annotationsVisibleField = StateField.define<boolean>({
  create: () => true,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(toggleAnnotationsVisible)) return !value;
    }
    return value;
  },
});

// Same palette loommark.cardBackgroundColors/cardBorderColors ship with, reused here so an
// annotation's color and a heading Card's accent read as the same visual language rather than two
// unrelated color systems. Assigned by each annotation's position among all annotations in the
// document (see colorForAnnotation) — stable as long as nothing *before* it is added or removed,
// same caveat editor.ts's own per-level card colors have.
const COLOR_PALETTE = ['#7c3aed', '#2563eb', '#168a72', '#b46a08', '#be3455', '#087f8c'];

function colorForAnnotation(allAnnotations: AnnotationRange[], annotation: AnnotationRange): string {
  const index = allAnnotations.indexOf(annotation);
  return COLOR_PALETTE[(index < 0 ? 0 : index) % COLOR_PALETTE.length];
}

// Persisted across widget rebuilds (which happen on every edit — see annotationField below) by
// keying on the annotation's own source offset, the same "identify a not-yet-recomputed thing by
// where it used to be" approach TableWidget's pendingTableFocus already relies on elsewhere in
// this kernel. Not robust to an edit shifting offsets *before* the annotation in question — an
// acceptable, clearly-scoped limitation for a first pass, not a hidden one.
const collapsedAnnotations = new Set<number>();
let pendingFocusAnnotationFrom: number | undefined;

// Completely hides an annotation block's own source — its delimiter lines and content alike —
// the same way a table/image/math widget replaces its source with a widget, just with nothing to
// show: every *other* scanner in the document already treats this range as nonexistent (see
// loommark-core's annotationRanges/isListInterrupted/listGuideSegments), and the rendered view
// needs to agree.
class HiddenWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.style.display = 'none';
    return element;
  }

  get estimatedHeight(): number {
    return 0;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const BAR_WIDTH = 3;
const BAR_GAP = 1;

// One thin color stripe per annotation attached from this side, stacked outward from the text
// (closest to the text = first/oldest annotation) — the same multi-layer background-image/
// position/size list technique buildHeadingCardDecorations already uses for nested Card accents,
// reused here instead of inventing a second one.
function stripeLayers(colors: string[], side: 'left' | 'right'): { images: string[]; positions: string[]; sizes: string[] } {
  const images: string[] = [];
  const positions: string[] = [];
  const sizes: string[] = [];
  colors.forEach((color, index) => {
    const offset = index * (BAR_WIDTH + BAR_GAP);
    images.push(`linear-gradient(${color}, ${color})`);
    positions.push(side === 'left' ? `${offset}px 0` : `calc(100% - ${offset + BAR_WIDTH}px) 0`);
    sizes.push(`${BAR_WIDTH}px 100%`);
  });
  return { images, positions, sizes };
}

// Colors every line of a target's span (its own line, or every line of a whole table/code/math/
// compound-list-item block) with a thin accent stripe per attached annotation — the color-matched
// "highlight" half of the Word/PDF-annotator pattern this is modeled on, standing in for a real
// text highlight (simpler to get right across every target shape: a single line, a multi-line
// block, a list item's own shift+enter continuation — see loommark-core's resolveAnnotationTarget/
// listItemCompoundRange) than literally highlighting a run of inline text would be.
function addTargetStripeDecorations(
  ranges: Range<Decoration>[],
  state: EditorState,
  target: SourceRange,
  leftColors: string[],
  rightColors: string[],
): void {
  if (!leftColors.length && !rightColors.length) return;
  const left = stripeLayers(leftColors, 'left');
  const right = stripeLayers(rightColors, 'right');
  const images = [...left.images, ...right.images];
  const positions = [...left.positions, ...right.positions];
  const sizes = [...left.sizes, ...right.sizes];
  const style = [
    `background-image: ${images.join(', ')}`,
    `background-position: ${positions.join(', ')}`,
    `background-size: ${sizes.join(', ')}`,
    'background-repeat: no-repeat',
  ].join('; ');

  const startLine = state.doc.lineAt(target.from).number;
  const endLine = state.doc.lineAt(target.to).number;
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const line = state.doc.line(lineNumber);
    ranges.push(Decoration.line({
      attributes: { class: 'cm-loommark-annotation-target', style },
    }).range(line.from));
  }
}

// Below this many pixels of margin (the gap between the editor's centered text column and the
// workspace container around it) on the widget's side, there isn't room to lay the card out
// permanently — it falls back to an icon revealed on hover instead. Comfortably fits the card's
// own width (see .annotation-card in annotation.css) plus the gap CSS places around it.
const PIN_THRESHOLD_PX = 232;

// `collapsed` is captured once, when this is built in buildAnnotationDecorations — not read live
// from collapsedAnnotations at comparison time. eq() below needs to tell "was this annotation
// collapsed when the *previous* widget was constructed" apart from "is it collapsed *now*"; since
// collapsedAnnotations is one shared Set, querying it live at eq() time would just compare the
// same current value against itself and always report no change, which is exactly the bug this
// snapshot avoids.
type ColoredAnnotation = { annotation: AnnotationRange; color: string; collapsed: boolean };

// The workspace container (createLoomMarkEditor's own `.loommark-workspace`, position:relative,
// overflow-y:auto — view.dom's grandparent) is the one element wide enough, and un-indented
// enough, to anchor a card flush against the true left/right edge regardless of how deeply the
// target line itself is nested inside a heading Card (which indents via margin-left) or how far
// into the editing area it sits. Anchoring there also means the card scrolls naturally with the
// document: position:absolute inside a scrolling positioned ancestor tracks that ancestor's
// content, it isn't pinned to the viewport.
function findWorkspaceElement(view: EditorView): HTMLElement | undefined {
  return view.dom.parentElement?.parentElement ?? undefined;
}

// Gap kept between two stacked cards on the same side, and the thickness of a displacement
// connector line — both purely cosmetic, no CSS counterpart to stay in sync with.
const CARD_STACK_GAP = 8;
// These two must stay in sync with .annotation-card's width and .annotation-card-left/-right's
// edge offset in annotation.css: the connector's vertical "rail" is computed analytically here
// (rather than measured) so measureCardLayout can run entirely inside CodeMirror's read phase
// without needing a card's real rendered rect just to find its near edge.
const CARD_WIDTH = 230;
const CARD_EDGE_GAP = 6;

type ConnectorGeometry = {
  hLeft: number; hTop: number; hWidth: number;
  vLeft: number; vTop: number; vHeight: number;
  color: string;
};

type CardLayoutResult = {
  card: HTMLElement;
  connectorH: HTMLElement;
  connectorV: HTMLElement;
  offscreen: boolean;
  top: number;
  connector: ConnectorGeometry | undefined;
};

// Reads every currently-live annotation group's natural position (view.coordsAtPos at its target)
// and, for cards pinned open, packs them top-to-bottom without overlap — the same margin-comment
// stacking Word/Google Docs use: sorted by natural (document) order, each card pushed down only as
// far as clearing the previous one requires, never pulled earlier than its own natural position.
// Every card gets an elbow connector (a horizontal reach from the target's own on-screen position —
// which does track heading indentation, deliberately, since that's genuinely where the annotated
// text is — to a vertical "rail" running along the card's near edge, then to wherever the card
// actually ended up) linking it back to its line, matching a hand-drawn reference the user provided
// showing every marker connected to its card this way, not only ones displaced by stacking.
// applyCardLayout still only shows a connector while its own card is actually visible (see
// .annotation-group:has(...) in annotation.css) — a permanently-drawn line to a hidden hover-only
// card would look broken.
// Reads from each group's own data-* attributes rather than closing over one widget instance, so a
// single listener (registered once in annotationExtension) can lay out every card regardless of
// which widget last rebuilt it.
function measureCardLayout(view: EditorView): CardLayoutResult[] {
  const workspaceElement = findWorkspaceElement(view);
  if (!workspaceElement) return [];
  const workspaceRect = workspaceElement.getBoundingClientRect();
  const scrollLeft = workspaceElement.scrollLeft;
  const scrollTop = workspaceElement.scrollTop;

  type RawEntry = {
    card: HTMLElement; connectorH: HTMLElement; connectorV: HTMLElement;
    side: 'left' | 'right'; color: string; naturalTop: number | null; markerX: number | null; height: number;
  };

  const groups = Array.from(workspaceElement.querySelectorAll<HTMLElement>(':scope > .annotation-group'));
  const raw: RawEntry[] = groups.map((group) => {
    const card = group.querySelector<HTMLElement>('.annotation-card')!;
    const connectorH = group.querySelector<HTMLElement>('.annotation-connector-h')!;
    const connectorV = group.querySelector<HTMLElement>('.annotation-connector-v')!;
    const side: 'left' | 'right' = group.dataset.side === 'right' ? 'right' : 'left';
    const color = group.dataset.color || COLOR_PALETTE[0];
    const targetFrom = Number(group.dataset.targetFrom);
    const coords = Number.isFinite(targetFrom) ? view.coordsAtPos(targetFrom) : null;
    const naturalTop = coords ? coords.top - workspaceRect.top + scrollTop : null;
    const markerX = coords ? (side === 'left' ? coords.left : coords.right) - workspaceRect.left + scrollLeft : null;
    // Only cards actually pinned open occupy stacking space; an on-hover-only popup is transient
    // and doesn't need collision avoidance against a card that might not even be showing right now.
    const height = card.classList.contains('is-pinned') ? card.getBoundingClientRect().height : 0;
    return { card, connectorH, connectorV, side, color, naturalTop, markerX, height };
  });

  const packedTop = new Map<RawEntry, number>();
  for (const side of ['left', 'right'] as const) {
    const onSide = raw
      .filter((entry) => entry.side === side && entry.naturalTop !== null && entry.card.classList.contains('is-pinned'))
      .sort((a, b) => a.naturalTop! - b.naturalTop!);
    let cursor = -Infinity;
    for (const entry of onSide) {
      const top = Math.max(entry.naturalTop!, cursor);
      packedTop.set(entry, top);
      cursor = top + entry.height + CARD_STACK_GAP;
    }
  }

  return raw.map((entry) => {
    const { card, connectorH, connectorV, side, color, naturalTop, markerX } = entry;
    // A card not part of the packed (pinned) stacking above just uses its own natural position —
    // covers the hover-only fallback, which doesn't get displaced by neighbors at all.
    const top = packedTop.get(entry) ?? naturalTop;
    if (top === null) return { card, connectorH, connectorV, offscreen: true, top: 0, connector: undefined };

    let connector: ConnectorGeometry | undefined;
    if (naturalTop !== null && markerX !== null) {
      const railX = side === 'left' ? CARD_EDGE_GAP + CARD_WIDTH : workspaceRect.width - CARD_EDGE_GAP - CARD_WIDTH;
      connector = {
        hLeft: Math.min(markerX, railX),
        hTop: naturalTop,
        hWidth: Math.abs(railX - markerX),
        vLeft: railX,
        vTop: Math.min(naturalTop, top),
        vHeight: Math.abs(top - naturalTop),
        color,
      };
    }
    return { card, connectorH, connectorV, offscreen: false, top, connector };
  });
}

function applyCardLayout(results: CardLayoutResult[]): void {
  for (const { card, connectorH, connectorV, offscreen, top, connector } of results) {
    card.classList.toggle('is-offscreen', offscreen);
    if (offscreen) {
      connectorH.classList.remove('is-visible');
      connectorV.classList.remove('is-visible');
      continue;
    }
    card.style.top = `${top}px`;

    connectorH.classList.toggle('is-visible', !!connector);
    connectorV.classList.toggle('is-visible', !!connector);
    if (!connector) continue;
    connectorH.style.left = `${connector.hLeft}px`;
    connectorH.style.top = `${connector.hTop}px`;
    connectorH.style.width = `${connector.hWidth}px`;
    connectorH.style.setProperty('--annotation-connector-color', connector.color);
    connectorV.style.left = `${connector.vLeft}px`;
    connectorV.style.top = `${connector.vTop}px`;
    connectorV.style.height = `${connector.vHeight}px`;
    connectorV.style.setProperty('--annotation-connector-color', connector.color);
  }
}

// requestMeasure's own key coalesces same-key requests queued within a frame down to one, so
// several widgets each calling this in the same toDOM pass (e.g. a left and a right group both
// rebuilding on the same edit) run one shared layout pass instead of one redundant pass per widget.
const annotationLayoutMeasureKey = {};

// Split into measure (read) + apply (write) and run through view.requestMeasure rather than
// reading view.coordsAtPos directly: called synchronously from inside toDOM, coordsAtPos throws
// ("Reading the editor layout isn't allowed during an update") since toDOM itself runs mid-update,
// before this very update's own layout has settled. requestMeasure defers the read to the point
// CodeMirror considers it safe, and the write to right after — the same phased read/write batching
// CodeMirror's own built-in panels and tooltips rely on for this exact situation.
function repositionAnnotationCards(view: EditorView): void {
  view.requestMeasure({ key: annotationLayoutMeasureKey, read: measureCardLayout, write: applyCardLayout });
}

// The margin indicator: an icon when space is tight, the note card itself (always visible, no
// hover needed) when there's room — re-measured live via ResizeObserver, since the available
// margin changes with the window/editor width, not just once at render time. Each note is
// directly editable (a <textarea>, not contentEditable — content can be genuinely multi-line, and
// getting a clean, unambiguous string with real "\n"s back out of a multi-line contentEditable
// region is inconsistent across browsers in a way a textarea's own .value never is), collapsible,
// and deletable; edits commit on blur, matching how table cells already commit in this editor, so
// the whole widget isn't torn down and rebuilt (losing focus) on every keystroke.
class AnnotationMarginWidget extends WidgetType {
  private resizeObserver: ResizeObserver | undefined;
  private group: HTMLElement | undefined;

  constructor(
    private readonly side: 'left' | 'right',
    private readonly items: ColoredAnnotation[],
    // The exact source offset this group's stripe/card is attached to (group.range.from for the
    // left side, group.range.to for the right — see buildAnnotationDecorations) — carried along so
    // toDOM can record it on the card for repositionAnnotationCards to read back later, and so eq()
    // notices when an upstream edit shifts it (annotation.from already has this same
    // shifts-under-upstream-edits characteristic; targetPos just extends the same comparison to
    // the position the card itself is anchored to).
    private readonly targetPos: number,
  ) {
    super();
  }

  eq(other: AnnotationMarginWidget): boolean {
    return this.side === other.side
      && this.targetPos === other.targetPos
      && this.items.length === other.items.length
      && this.items.every(({ annotation, color, collapsed }, index) => (
        annotation.from === other.items[index].annotation.from
        && annotation.text === other.items[index].annotation.text
        && color === other.items[index].color
        // collapsed is a snapshot taken when each widget was built (see buildAnnotationDecorations),
        // not a live read of the shared collapsedAnnotations Set here — comparing a live read
        // against itself would trivially always match, since both sides would be querying the
        // exact same current Set state at the same key, never detecting that it just changed.
        && collapsed === other.items[index].collapsed
      ));
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = `annotation-marker annotation-marker-${this.side}`;
    wrapper.style.setProperty('--annotation-accent', this.items[0]?.color ?? COLOR_PALETTE[0]);

    // A small solid pill in the annotation's own color, not a directional arrow glyph — matching a
    // hand-drawn reference the user provided where the marker at the text edge is a colored block
    // that a connector line runs from, not an icon that has to be legible at font size.
    const icon = document.createElement('span');
    icon.className = 'annotation-icon';
    icon.setAttribute('aria-hidden', 'true');

    // The card (and its two connector-line elements) are deliberately NOT appended under wrapper:
    // wrapper stays inline at the target's own (possibly heading-indented) text position, but the
    // card itself is appended straight onto the workspace container so its position is independent
    // of that indentation entirely — see findWorkspaceElement/repositionAnnotationCards above.
    // group itself is `display: contents` (see annotation.css) purely so all three still resolve
    // their position:absolute containing block through to .loommark-workspace, while still being
    // removable as one unit in destroy().
    const group = document.createElement('div');
    group.className = 'annotation-group';
    group.dataset.targetFrom = String(this.targetPos);
    group.dataset.side = this.side;
    const color = this.items[0]?.color ?? COLOR_PALETTE[0];
    group.dataset.color = color;

    const card = document.createElement('div');
    card.className = `annotation-card annotation-card-${this.side}`;
    card.setAttribute('aria-label', `${this.items.length} annotation(s)`);

    const connectorH = document.createElement('div');
    connectorH.className = 'annotation-connector-h';
    const connectorV = document.createElement('div');
    connectorV.className = 'annotation-connector-v';

    const list = document.createElement('div');
    list.className = 'annotation-card-list';
    for (const { annotation, color, collapsed } of this.items) list.append(this.renderItem(view, annotation, color, collapsed));
    card.append(list);

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'annotation-card-add';
    addButton.textContent = '+ Add note';
    addButton.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const last = this.items[this.items.length - 1].annotation;
      const marker = this.side === 'left' ? '<<<' : '>>>';
      const insertAt = last.to + 1;
      const insertText = `${marker}\n\n${marker}\n`;
      pendingFocusAnnotationFrom = insertAt;
      view.dispatch({ changes: { from: insertAt, insert: insertText } });
    });
    card.append(addButton);

    // The icon and the (now-detached) card no longer share a DOM ancestor, so ":hover" can't
    // bridge them with a plain CSS descendant selector; open/close state is tracked on the card
    // directly instead, and mouseleave gets a short grace delay so the mouse can travel across the
    // gap between the inline icon and the edge-pinned card without the card closing mid-transit.
    let closeTimer: number | undefined;
    const openCard = () => {
      window.clearTimeout(closeTimer);
      card.classList.add('is-open');
    };
    const scheduleClose = () => {
      closeTimer = window.setTimeout(() => card.classList.remove('is-open'), 150);
    };
    icon.addEventListener('mouseenter', openCard);
    icon.addEventListener('mouseleave', scheduleClose);
    card.addEventListener('mouseenter', openCard);
    card.addEventListener('mouseleave', scheduleClose);

    wrapper.append(icon);
    group.append(card, connectorH, connectorV);
    const workspaceElement = findWorkspaceElement(view);
    (workspaceElement ?? wrapper).append(group);
    this.group = group;

    // The gap that matters is between the text column (createLoomMarkEditor's own
    // .loommark-editor-root, centered and width-capped — view.dom's parent) and the workspace
    // container around it (view.dom's grandparent, which fills the available width) — not
    // between view.dom and view.scrollDOM, which are always the same size: CodeMirror's own DOM
    // has no margin of its own, it simply fills whatever width .loommark-editor-root already
    // constrained it to.
    const updatePinned = () => {
      const textColumn = view.dom.parentElement;
      const workspace = textColumn?.parentElement;
      if (!textColumn || !workspace) {
        wrapper.classList.remove('is-pinned');
        card.classList.remove('is-pinned');
        return;
      }
      const columnRect = textColumn.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const margin = this.side === 'left'
        ? columnRect.left - workspaceRect.left
        : workspaceRect.right - columnRect.right;
      const pinned = margin >= PIN_THRESHOLD_PX;
      wrapper.classList.toggle('is-pinned', pinned);
      card.classList.toggle('is-pinned', pinned);
    };
    updatePinned();
    repositionAnnotationCards(view);
    this.resizeObserver = new ResizeObserver(() => {
      updatePinned();
      repositionAnnotationCards(view);
    });
    this.resizeObserver.observe(view.scrollDOM);
    if (workspaceElement) this.resizeObserver.observe(workspaceElement);

    if (pendingFocusAnnotationFrom !== undefined) {
      const focusFrom = pendingFocusAnnotationFrom;
      const textarea = list.querySelector<HTMLTextAreaElement>(`[data-annotation-from="${focusFrom}"] .annotation-item-text`);
      if (textarea) {
        pendingFocusAnnotationFrom = undefined;
        window.setTimeout(() => textarea.focus(), 0);
      }
    }

    return wrapper;
  }

  private renderItem(view: EditorView, annotation: AnnotationRange, color: string, collapsed: boolean): HTMLElement {
    const item = document.createElement('div');
    item.className = 'annotation-item';
    item.dataset.annotationFrom = String(annotation.from);
    item.style.setProperty('--annotation-item-color', color);
    item.classList.toggle('is-collapsed', collapsed);

    const header = document.createElement('div');
    header.className = 'annotation-item-header';

    const swatch = document.createElement('span');
    swatch.className = 'annotation-item-swatch';
    swatch.setAttribute('aria-hidden', 'true');

    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'annotation-item-collapse';
    collapseButton.textContent = collapsed ? '▸' : '▾';
    collapseButton.setAttribute('aria-label', collapsed ? 'Expand this annotation' : 'Collapse this annotation');
    collapseButton.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (collapsedAnnotations.has(annotation.from)) collapsedAnnotations.delete(annotation.from);
      else collapsedAnnotations.add(annotation.from);
      view.dispatch({ effects: refreshAnnotations.of() });
    });

    const preview = document.createElement('span');
    preview.className = 'annotation-item-preview';
    preview.textContent = annotation.text.split('\n')[0] || '(empty)';

    const spacer = document.createElement('span');
    spacer.className = 'annotation-item-spacer';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'annotation-item-delete';
    deleteButton.textContent = '🗑';
    deleteButton.setAttribute('aria-label', 'Delete this annotation');
    deleteButton.addEventListener('mousedown', (event) => {
      // mousedown, not click: fires before the textarea below it would otherwise steal focus.
      event.preventDefault();
      collapsedAnnotations.delete(annotation.from);
      const to = Math.min(annotation.to + 1, view.state.doc.length);
      view.dispatch({ changes: { from: annotation.from, to, insert: '' } });
    });

    header.append(swatch, collapseButton, preview, spacer, deleteButton);
    item.append(header);

    const textarea = document.createElement('textarea');
    textarea.className = 'annotation-item-text';
    textarea.value = annotation.text;
    textarea.rows = Math.max(1, annotation.text.split('\n').length);
    textarea.spellcheck = false;
    textarea.addEventListener('blur', () => {
      const next = textarea.value;
      if (next === annotation.text) return;
      view.dispatch({ changes: { from: annotation.contentFrom, to: annotation.contentTo, insert: next } });
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        textarea.value = annotation.text;
        textarea.blur();
      }
      // Prevent this editor's own keymap (Enter/Tab/arrow handling meant for the document) from
      // seeing keystrokes typed into this plain textarea.
      event.stopPropagation();
    });
    item.append(textarea);

    return item;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.group?.remove();
  }

  ignoreEvent(): boolean {
    return true;
  }
}

type TargetGroup = { range: SourceRange; left: ColoredAnnotation[]; right: ColoredAnnotation[] };

function buildAnnotationDecorations(state: EditorState): DecorationSet {
  const source = state.doc.toString();
  const annotations = annotationRanges(source);
  if (!annotations.length) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  for (const annotation of annotations) {
    ranges.push(Decoration.replace({ widget: new HiddenWidget(), block: true }).range(annotation.from, annotation.to));
  }

  if (state.field(annotationsVisibleField)) {
    const groups = new Map<string, TargetGroup>();
    for (const annotation of annotations) {
      const target = resolveAnnotationTarget(source, annotation);
      if (!target) continue;
      const key = `${target.from}:${target.to}`;
      let group = groups.get(key);
      if (!group) {
        group = { range: target, left: [], right: [] };
        groups.set(key, group);
      }
      group[annotation.side].push({
        annotation,
        color: colorForAnnotation(annotations, annotation),
        collapsed: collapsedAnnotations.has(annotation.from),
      });
    }
    for (const group of groups.values()) {
      addTargetStripeDecorations(
        ranges,
        state,
        group.range,
        group.left.map((entry) => entry.color),
        group.right.map((entry) => entry.color),
      );
      // A whole-block target (a table/fenced-code/display-math/compound-list-item block,
      // spanning more than one line) is itself rendered as a block-level replace decoration by
      // loommark-core's own fields — a plain inline point widget positioned at that exact
      // boundary gets swallowed by it rather than rendering alongside it. Marking this widget
      // block:true too gives it its own slot instead of competing for the same one; a
      // single-line target doesn't have that conflict, and inline positioning (visually
      // attached to the line's own text) reads better there anyway.
      const isWholeBlock = state.doc.lineAt(group.range.from).number !== state.doc.lineAt(group.range.to).number;
      if (group.left.length) {
        ranges.push(Decoration.widget({
          widget: new AnnotationMarginWidget('left', group.left, group.range.from),
          side: -1,
          block: isWholeBlock,
        }).range(group.range.from));
      }
      if (group.right.length) {
        ranges.push(Decoration.widget({
          widget: new AnnotationMarginWidget('right', group.right, group.range.to),
          side: 1,
          block: isWholeBlock,
        }).range(group.range.to));
      }
    }
  }

  return Decoration.set(ranges, true);
}

const annotationField = StateField.define<DecorationSet>({
  create: buildAnnotationDecorations,
  update(value, transaction) {
    if (transaction.docChanged
      || transaction.effects.some((effect) => effect.is(toggleAnnotationsVisible) || effect.is(refreshAnnotations))) {
      return buildAnnotationDecorations(transaction.state);
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Typing the 3rd `<` (or `>`) of a delimiter line auto-closes it immediately, the same way
// loommark-core's own completeBlockDelimiters does for code fences/math. Without this, a bare
// `<<<` typed anywhere with no matching close left "open" until the next `<<<`/`>>>` line
// anywhere later in the document, however far away — which silently swallows every real paragraph
// in between into the hidden block, with no visible sign anything went wrong (the content doesn't
// look deleted, it just isn't there — see annotationRanges' fence-matching in loommark-core).
// Auto-closing on the same keystroke that completes the opener means a bare, unclosed `<<<`
// essentially can't happen through normal typing in the first place.
const completeAnnotationDelimiters = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || text.length !== 1 || (text !== '<' && text !== '>')) return false;
  const line = view.state.doc.lineAt(from);
  if (view.state.doc.sliceString(from, line.to).trim() !== '') return false;
  const before = view.state.doc.sliceString(line.from, from);
  const indent = before.match(/^ {0,3}/)?.[0] ?? '';
  if (before !== `${indent}${text}${text}`) return false;

  view.dispatch({
    changes: { from, to, insert: `${text}\n\n${indent}${text}${text}${text}` },
    selection: { anchor: from + 1 },
    userEvent: 'input.type',
  });
  return true;
});

// Keeps every annotation card glued to its target line across reflows that don't touch this
// widget's own eq() (see AnnotationMarginWidget.eq/repositionAnnotationCards above) — a
// window/panel resize that rewraps a long line, or an edit above the target that pushes it down,
// without changing this annotation's own content/color/collapsed state.
const repositionOnGeometryChange = EditorView.updateListener.of((update) => {
  if (update.geometryChanged || update.docChanged) repositionAnnotationCards(update.view);
});

export function annotationExtension(): Extension {
  return [
    annotationsVisibleField,
    annotationField,
    repositionOnGeometryChange,
    completeAnnotationDelimiters,
    keymap.of([
      {
        key: 'Mod-Shift-a',
        run(view) {
          view.dispatch({ effects: toggleAnnotationsVisible.of() });
          return true;
        },
      },
    ]),
  ];
}
