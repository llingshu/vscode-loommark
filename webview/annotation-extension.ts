import {
  annotationRanges,
  resolveAnnotationTarget,
  type AnnotationRange,
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
// collapsedAnnotations/manuallyPinnedKeys (plain module-level Sets, not CodeMirror state of their
// own, the same way TableWidget's pendingTableFocus isn't either).
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

// A user can force a group's card to stay permanently visible via the right-click "Pin"/"Unpin"
// action, regardless of how much margin is actually available — keyed by `${side}:${targetFrom}`
// since left/right cards on the same target are independent. Checked alongside the
// margin-availability computation in AnnotationMarginWidget's updatePinned.
const manuallyPinnedKeys = new Set<string>();

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

// Below this many pixels of margin (the gap between the editor's centered text column and the
// workspace container around it) on the widget's side, there isn't room to lay the card out
// permanently — it falls back to a hover-revealed popup instead. Comfortably fits the card's own
// width (see .annotation-card in annotation.css) plus the gap CSS places around it. A manual
// "Pin" (see manuallyPinnedKeys) overrides this regardless of actual available room.
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

// Finds the actual `.cm-line` DOM element for a document position, so the target-highlight stripe
// and the card's natural row can both be measured from the same real, rendered box — rather than
// from `view.coordsAtPos`, which resolves to wherever the *text itself* happens to end (far short
// of the line's own right edge for a short line). Positioning stripes as their own overlay
// elements here (rather than as a `Decoration.line({attributes:{style}})`, the earlier approach)
// also sidesteps a real bug: loommark-core's own heading-card decoration sets that same line's
// `style` attribute (background-image, and the CSS custom property its border color depends on);
// CodeMirror concatenates multiple decorations' `style` strings onto one line rather than merging
// them property-by-property, so whichever decoration's string comes later simply overrides any
// property both happen to declare — annotations, being a host extension appended after
// loommark-core's own fields, always won, silently erasing the heading card's own background.
// An independent overlay element never touches the line's attributes at all, so it can't collide.
function findLineElement(view: EditorView, pos: number): HTMLElement | null {
  const { node } = view.domAtPos(pos);
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest('.cm-line') ?? null;
}

// One thin stripe bar per annotation attached to a target, stacked inward from that side's own
// line-box edge (closest to the edge = first/oldest annotation) — now a real overlay element
// (see findLineElement's comment for why), not a background-image layer.
const BAR_WIDTH = 3;
const BAR_GAP = 1;
// Extra hit-area around the stacked stripe bars so hovering to reveal a card doesn't require
// pixel-precise aim at a 3px-wide line — the bars stay thin, only the invisible hover target
// backing them is wider.
const STRIPE_HIT_PADDING = 6;

// Gap kept between two stacked cards on the same side, and the thickness of a connector line —
// both purely cosmetic, no CSS counterpart to stay in sync with.
const CARD_STACK_GAP = 8;
// How far the connector's short "peel" reaches out from the card's own edge — deliberately NOT
// spanning all the way back to the text (a prior version did, and for a short/blank line or a very
// wide window with a narrow centered text column, that reach could stretch most of the way across
// the screen). The stripe overlay (same color) is what actually marks the text; the connector only
// needs to associate a *stack position* with its card, which a short nub does just as well as a
// long line would.
const PEEL_LENGTH = 14;
// These two must stay in sync with .annotation-card's width and .annotation-card-left/-right's
// edge offset in annotation.css: the connector's rail is computed analytically here (rather than
// measured) so measureCardLayout can run entirely inside CodeMirror's read phase without needing a
// card's real rendered rect just to find its near edge.
const CARD_WIDTH = 230;
const CARD_EDGE_GAP = 6;

type ConnectorGeometry = {
  hLeft: number; hTop: number; hWidth: number;
  vLeft: number; vTop: number; vHeight: number;
};

type StripeBar = { el: HTMLElement; left: number; color: string };

type GroupLayoutResult = {
  card: HTMLElement;
  connectorH: HTMLElement;
  connectorV: HTMLElement;
  stripeHit: HTMLElement;
  bars: StripeBar[];
  offscreen: boolean;
  top: number;
  stripeTop: number;
  stripeHeight: number;
  connector: ConnectorGeometry | undefined;
};

// Reads every currently-live annotation group's natural position and, for cards pinned open,
// packs them top-to-bottom without overlap — the same margin-comment stacking Word/Google Docs
// use: sorted by natural (document) order, each card pushed down only as far as clearing the
// previous one requires, never pulled earlier than its own natural position. Also positions each
// group's stripe bars (spanning the target's whole vertical extent, whether that's one line or a
// multi-line block) and its connector's short peel-and-rail.
// Reads from each group's own data-* attributes rather than closing over one widget instance, so a
// single listener (registered once in annotationExtension) can lay out every card regardless of
// which widget last rebuilt it.
function measureGroupLayout(view: EditorView): GroupLayoutResult[] {
  const workspaceElement = findWorkspaceElement(view);
  if (!workspaceElement) return [];
  const workspaceRect = workspaceElement.getBoundingClientRect();
  const scrollLeft = workspaceElement.scrollLeft;
  const scrollTop = workspaceElement.scrollTop;

  type RawEntry = {
    card: HTMLElement; connectorH: HTMLElement; connectorV: HTMLElement; stripeHit: HTMLElement;
    bars: StripeBar[];
    side: 'left' | 'right'; naturalTop: number | null; stripeTop: number; stripeHeight: number;
    lineLeft: number; lineRight: number; height: number;
  };

  const groups = Array.from(workspaceElement.querySelectorAll<HTMLElement>(':scope > .annotation-group'));
  const raw: RawEntry[] = groups.map((group) => {
    const card = group.querySelector<HTMLElement>('.annotation-card')!;
    const connectorH = group.querySelector<HTMLElement>('.annotation-connector-h')!;
    const connectorV = group.querySelector<HTMLElement>('.annotation-connector-v')!;
    const stripeHit = group.querySelector<HTMLElement>('.annotation-stripe-hit')!;
    const barEls = Array.from(group.querySelectorAll<HTMLElement>('.annotation-stripe-bar'));
    const side: 'left' | 'right' = group.dataset.side === 'right' ? 'right' : 'left';
    const targetFrom = Number(group.dataset.targetFrom);
    const targetTo = Number(group.dataset.targetTo);
    const topLineRect = Number.isFinite(targetFrom) ? findLineElement(view, targetFrom)?.getBoundingClientRect() : undefined;
    const bottomLineRect = Number.isFinite(targetTo) ? findLineElement(view, targetTo)?.getBoundingClientRect() : undefined;
    // A table (unlike a fenced-code block, which still renders real per-line `.cm-line` elements
    // under its own styling) replaces its whole source with one opaque widget — no `.cm-line`
    // exists anywhere inside it, so findLineElement comes back empty there. Falling all the way
    // back to offscreen in that case would make the card vanish entirely, not just lose its
    // stripe (the true original limitation, and a much smaller loss than the card disappearing).
    // view.coordsAtPos still resolves a position inside a replaced range to that widget's own
    // boundary, so it's a safe fallback for the card/connector's vertical position specifically —
    // just not for the stripe's left/right edges, which have no meaningful "line box" to match
    // when there's no real line there at all.
    const topCoords = !topLineRect && Number.isFinite(targetFrom) ? view.coordsAtPos(targetFrom) : null;
    const naturalTop = topLineRect
      ? topLineRect.top - workspaceRect.top + scrollTop
      : topCoords
        ? topCoords.top - workspaceRect.top + scrollTop
        : null;
    const stripeTop = naturalTop ?? 0;
    const stripeHeight = topLineRect && bottomLineRect
      ? (bottomLineRect.bottom - topLineRect.top)
      : 0;
    const lineLeft = topLineRect ? topLineRect.left - workspaceRect.left + scrollLeft : 0;
    const lineRight = topLineRect ? topLineRect.right - workspaceRect.left + scrollLeft : 0;
    const bars: StripeBar[] = barEls.map((el, index) => ({
      el,
      color: el.dataset.color || COLOR_PALETTE[0],
      left: side === 'left'
        ? lineLeft + index * (BAR_WIDTH + BAR_GAP)
        : lineRight - (index + 1) * BAR_WIDTH - index * BAR_GAP,
    }));
    // Only cards actually pinned open occupy stacking space; an on-hover-only popup is transient
    // and doesn't need collision avoidance against a card that might not even be showing right now.
    const height = card.classList.contains('is-pinned') ? card.getBoundingClientRect().height : 0;
    return { card, connectorH, connectorV, stripeHit, bars, side, naturalTop, stripeTop, stripeHeight, lineLeft, lineRight, height };
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
    const { card, connectorH, connectorV, stripeHit, bars, side, naturalTop, stripeTop, stripeHeight } = entry;
    // A card not part of the packed (pinned) stacking above just uses its own natural position —
    // covers the hover-only fallback, which doesn't get displaced by neighbors at all.
    const top = packedTop.get(entry) ?? naturalTop;
    if (top === null) {
      return { card, connectorH, connectorV, stripeHit, bars, offscreen: true, top: 0, stripeTop, stripeHeight, connector: undefined };
    }

    let connector: ConnectorGeometry | undefined;
    if (naturalTop !== null) {
      const railX = side === 'left' ? CARD_EDGE_GAP + CARD_WIDTH : CARD_EDGE_GAP;
      const peelX = side === 'left' ? railX + PEEL_LENGTH : workspaceRect.width - railX - PEEL_LENGTH;
      const railXAbs = side === 'left' ? railX : workspaceRect.width - railX;
      connector = {
        vLeft: railXAbs,
        vTop: Math.min(naturalTop, top),
        vHeight: Math.abs(top - naturalTop),
        hLeft: Math.min(railXAbs, peelX),
        hTop: naturalTop,
        hWidth: PEEL_LENGTH,
      };
    }
    return { card, connectorH, connectorV, stripeHit, bars, offscreen: false, top, stripeTop, stripeHeight, connector };
  });
}

function applyGroupLayout(results: GroupLayoutResult[]): void {
  for (const { card, connectorH, connectorV, stripeHit, bars, offscreen, top, stripeTop, stripeHeight, connector } of results) {
    card.classList.toggle('is-offscreen', offscreen);
    for (const bar of bars) bar.el.classList.toggle('is-offscreen', offscreen);
    stripeHit.classList.toggle('is-offscreen', offscreen);
    if (offscreen) {
      connectorH.classList.remove('is-visible');
      connectorV.classList.remove('is-visible');
      continue;
    }
    card.style.top = `${top}px`;

    for (const bar of bars) {
      bar.el.style.left = `${bar.left}px`;
      bar.el.style.top = `${stripeTop}px`;
      bar.el.style.height = `${stripeHeight}px`;
      bar.el.style.setProperty('--annotation-stripe-color', bar.color);
    }
    const hitLeft = bars.length ? Math.min(...bars.map((b) => b.left)) - STRIPE_HIT_PADDING : 0;
    const hitRight = bars.length ? Math.max(...bars.map((b) => b.left + BAR_WIDTH)) + STRIPE_HIT_PADDING : 0;
    stripeHit.style.left = `${hitLeft}px`;
    stripeHit.style.top = `${stripeTop}px`;
    stripeHit.style.width = `${hitRight - hitLeft}px`;
    stripeHit.style.height = `${stripeHeight}px`;

    connectorH.classList.toggle('is-visible', !!connector);
    connectorV.classList.toggle('is-visible', !!connector);
    if (!connector) continue;
    connectorH.style.left = `${connector.hLeft}px`;
    connectorH.style.top = `${connector.hTop}px`;
    connectorH.style.width = `${connector.hWidth}px`;
    connectorV.style.left = `${connector.vLeft}px`;
    connectorV.style.top = `${connector.vTop}px`;
    connectorV.style.height = `${connector.vHeight}px`;
  }
}

// requestMeasure's own key coalesces same-key requests queued within a frame down to one, so
// several widgets each calling this in the same toDOM pass (e.g. a left and a right group both
// rebuilding on the same edit) run one shared layout pass instead of one redundant pass per widget.
const annotationLayoutMeasureKey = {};

// Split into measure (read) + apply (write) and run through view.requestMeasure rather than
// reading layout directly: called synchronously from inside toDOM, view.coordsAtPos (and by
// extension anything that forces a layout read) throws ("Reading the editor layout isn't allowed
// during an update") since toDOM itself runs mid-update, before this very update's own layout has
// settled. requestMeasure defers the read to the point CodeMirror considers it safe, and the write
// to right after — the same phased read/write batching CodeMirror's own built-in panels and
// tooltips rely on for this exact situation.
function repositionAnnotationGroups(view: EditorView): void {
  view.requestMeasure({ key: annotationLayoutMeasureKey, read: measureGroupLayout, write: applyGroupLayout });
}

// A small floating right-click menu, since delete/add-note/pin moved out of always-visible inline
// buttons (which cluttered a card meant to read as a single clean colored surface) into actions
// you reach only when you actually want them. Only one is ever open; opening a new one, clicking
// outside, or pressing Escape closes whichever is open.
let activeContextMenu: { menu: HTMLElement; dismiss: (event: MouseEvent) => void; onKey: (event: KeyboardEvent) => void } | undefined;

function closeContextMenu(): void {
  if (!activeContextMenu) return;
  activeContextMenu.menu.remove();
  window.removeEventListener('mousedown', activeContextMenu.dismiss, true);
  window.removeEventListener('keydown', activeContextMenu.onKey, true);
  activeContextMenu = undefined;
}

function showContextMenu(x: number, y: number, items: { label: string; onSelect: () => void }[]): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'annotation-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      item.onSelect();
      closeContextMenu();
    });
    menu.append(button);
  }
  document.body.append(menu);
  const dismiss = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node)) closeContextMenu();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeContextMenu();
  };
  // Capture phase, and deferred a tick: the same mousedown/contextmenu that opens the menu would
  // otherwise immediately re-trigger this listener and close it right back.
  window.setTimeout(() => {
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
  activeContextMenu = { menu, dismiss, onKey };
}

// The margin indicator: the card itself when there's room (always visible, no hover needed),
// a hover-revealed popup otherwise — re-measured live via ResizeObserver, since the available
// margin changes with the window/editor width, not just once at render time, and a manual "Pin"
// (see manuallyPinnedKeys) can force it open regardless. Each note is directly editable (a
// <textarea>, not contentEditable — content can be genuinely multi-line, and getting a clean,
// unambiguous string with real "\n"s back out of a multi-line contentEditable region is
// inconsistent across browsers in a way a textarea's own .value never is) and collapsible; delete/
// add-note/pin live in a right-click context menu instead of inline buttons. Edits commit on blur,
// matching how table cells already commit in this editor, so the whole widget isn't torn down and
// rebuilt (losing focus) on every keystroke.
class AnnotationMarginWidget extends WidgetType {
  private resizeObserver: ResizeObserver | undefined;
  private group: HTMLElement | undefined;

  constructor(
    private readonly side: 'left' | 'right',
    private readonly items: ColoredAnnotation[],
    // The full target range this group's stripe/card/connector is attached to — carried along so
    // toDOM can record it for repositionAnnotationGroups to read back later (both endpoints, since
    // the stripe needs the target's whole vertical extent, not just one end of it), and so eq()
    // notices when an upstream edit shifts it (annotation.from already has this same
    // shifts-under-upstream-edits characteristic; these just extend the same comparison).
    private readonly targetFrom: number,
    private readonly targetTo: number,
  ) {
    super();
  }

  private get pinKey(): string {
    return `${this.side}:${this.targetFrom}`;
  }

  eq(other: AnnotationMarginWidget): boolean {
    return this.side === other.side
      && this.targetFrom === other.targetFrom
      && this.targetTo === other.targetTo
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
    // Zero-size — purely a position anchor for CodeMirror's own decoration bookkeeping (eq/destroy
    // lifecycle). Nothing about this annotation renders inline in the text anymore: the stripe
    // (an overlay, not this anchor) is the sole always-visible indicator, doubling as the
    // hover/click target, so there's no second, separate colored marker duplicating it.
    const anchor = document.createElement('span');
    anchor.style.display = 'none';

    // group itself is `display: contents` (see annotation.css) purely so the card/connectors/
    // stripe bars/hit-area still all resolve their position:absolute containing block through to
    // .loommark-workspace, while still being removable as one unit in destroy().
    const group = document.createElement('div');
    group.className = 'annotation-group';
    group.dataset.targetFrom = String(this.targetFrom);
    group.dataset.targetTo = String(this.targetTo);
    group.dataset.side = this.side;
    const primaryColor = this.items[0]?.color ?? COLOR_PALETTE[0];

    const card = document.createElement('div');
    card.className = `annotation-card annotation-card-${this.side}`;
    card.setAttribute('aria-label', `${this.items.length} annotation(s)`);
    card.style.setProperty('--annotation-accent', primaryColor);

    const connectorH = document.createElement('div');
    connectorH.className = 'annotation-connector-h';
    connectorH.style.setProperty('--annotation-connector-color', primaryColor);
    const connectorV = document.createElement('div');
    connectorV.className = 'annotation-connector-v';
    connectorV.style.setProperty('--annotation-connector-color', primaryColor);

    // One thin bar per stacked annotation, plus one wider (but invisible) hit-area that's the
    // actual hover/click target — see STRIPE_HIT_PADDING.
    const bars = this.items.map(({ color }) => {
      const bar = document.createElement('div');
      bar.className = 'annotation-stripe-bar';
      bar.dataset.color = color;
      return bar;
    });
    const stripeHit = document.createElement('div');
    stripeHit.className = 'annotation-stripe-hit';

    const list = document.createElement('div');
    list.className = 'annotation-card-list';
    for (const { annotation, color, collapsed } of this.items) list.append(this.renderItem(view, annotation, color, collapsed));
    card.append(list);

    const insertNewNote = () => {
      const last = this.items[this.items.length - 1].annotation;
      const marker = this.side === 'left' ? '<<<' : '>>>';
      const insertAt = last.to + 1;
      const insertText = `${marker}\n\n${marker}\n`;
      pendingFocusAnnotationFrom = insertAt;
      view.dispatch({ changes: { from: insertAt, insert: insertText } });
    };

    const togglePinned = () => {
      if (manuallyPinnedKeys.has(this.pinKey)) manuallyPinnedKeys.delete(this.pinKey);
      else manuallyPinnedKeys.add(this.pinKey);
      updatePinned();
      repositionAnnotationGroups(view);
    };

    const deleteAnnotation = (annotation: AnnotationRange) => {
      collapsedAnnotations.delete(annotation.from);
      const to = Math.min(annotation.to + 1, view.state.doc.length);
      view.dispatch({ changes: { from: annotation.from, to, insert: '' } });
    };

    const openMenu = (event: MouseEvent) => {
      event.preventDefault();
      const itemEl = (event.target as HTMLElement).closest<HTMLElement>('.annotation-item');
      const menuItems: { label: string; onSelect: () => void }[] = [];
      if (itemEl) {
        const annotationFrom = Number(itemEl.dataset.annotationFrom);
        const target = this.items.find((entry) => entry.annotation.from === annotationFrom)?.annotation;
        if (target) menuItems.push({ label: 'Delete this note', onSelect: () => deleteAnnotation(target) });
      }
      menuItems.push({ label: '+ Add note', onSelect: insertNewNote });
      menuItems.push({ label: manuallyPinnedKeys.has(this.pinKey) ? 'Unpin' : 'Pin', onSelect: togglePinned });
      showContextMenu(event.clientX, event.clientY, menuItems);
    };
    card.addEventListener('contextmenu', openMenu);
    for (const bar of bars) bar.addEventListener('contextmenu', openMenu);
    stripeHit.addEventListener('contextmenu', openMenu);

    // The stripe hit-area and the (now-detached) card no longer share a DOM ancestor, so ":hover"
    // can't bridge them with a plain CSS descendant selector; open/close state is tracked on the
    // card directly instead, and mouseleave gets a grace delay so the mouse can travel across the
    // gap between the highlighted line and the edge-pinned card without the card closing mid-transit.
    let closeTimer: number | undefined;
    const openCard = () => {
      window.clearTimeout(closeTimer);
      card.classList.add('is-open');
    };
    const scheduleClose = () => {
      closeTimer = window.setTimeout(() => card.classList.remove('is-open'), 300);
    };
    stripeHit.addEventListener('mouseenter', openCard);
    stripeHit.addEventListener('mouseleave', scheduleClose);
    card.addEventListener('mouseenter', openCard);
    card.addEventListener('mouseleave', scheduleClose);

    group.append(card, connectorH, connectorV, stripeHit, ...bars);
    const workspaceElement = findWorkspaceElement(view);
    (workspaceElement ?? anchor).append(group);
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
        card.classList.remove('is-pinned');
        return;
      }
      const columnRect = textColumn.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const margin = this.side === 'left'
        ? columnRect.left - workspaceRect.left
        : workspaceRect.right - columnRect.right;
      const pinned = margin >= PIN_THRESHOLD_PX || manuallyPinnedKeys.has(this.pinKey);
      card.classList.toggle('is-pinned', pinned);
    };
    updatePinned();
    repositionAnnotationGroups(view);
    this.resizeObserver = new ResizeObserver(() => {
      updatePinned();
      repositionAnnotationGroups(view);
    });
    this.resizeObserver.observe(view.scrollDOM);
    this.resizeObserver.observe(card);
    if (workspaceElement) this.resizeObserver.observe(workspaceElement);

    if (pendingFocusAnnotationFrom !== undefined) {
      const focusFrom = pendingFocusAnnotationFrom;
      const textarea = list.querySelector<HTMLTextAreaElement>(`[data-annotation-from="${focusFrom}"] .annotation-item-text`);
      if (textarea) {
        pendingFocusAnnotationFrom = undefined;
        window.setTimeout(() => textarea.focus(), 0);
      }
    }

    return anchor;
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

    header.append(swatch, collapseButton, preview);
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

type TargetGroup = { from: number; to: number; left: ColoredAnnotation[]; right: ColoredAnnotation[] };

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
        group = { from: target.from, to: target.to, left: [], right: [] };
        groups.set(key, group);
      }
      group[annotation.side].push({
        annotation,
        color: colorForAnnotation(annotations, annotation),
        collapsed: collapsedAnnotations.has(annotation.from),
      });
    }
    for (const group of groups.values()) {
      // A whole-block target (a table/fenced-code/display-math/compound-list-item block,
      // spanning more than one line) is itself rendered as a block-level replace decoration by
      // loommark-core's own fields — a plain inline point widget positioned at that exact
      // boundary gets swallowed by it rather than rendering alongside it. Marking this widget
      // block:true too gives it its own slot instead of competing for the same one; a
      // single-line target doesn't have that conflict, and inline positioning reads better there
      // anyway (not that it matters for rendering now — the anchor itself is invisible either way).
      const isWholeBlock = state.doc.lineAt(group.from).number !== state.doc.lineAt(group.to).number;
      if (group.left.length) {
        ranges.push(Decoration.widget({
          widget: new AnnotationMarginWidget('left', group.left, group.from, group.to),
          side: -1,
          block: isWholeBlock,
        }).range(group.from));
      }
      if (group.right.length) {
        ranges.push(Decoration.widget({
          widget: new AnnotationMarginWidget('right', group.right, group.from, group.to),
          side: 1,
          block: isWholeBlock,
        }).range(group.to));
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

// Keeps every annotation group glued to its target line across reflows that don't touch this
// widget's own eq() (see AnnotationMarginWidget.eq/repositionAnnotationGroups above) — a
// window/panel resize that rewraps a long line, or an edit above the target that pushes it down,
// without changing this annotation's own content/color/collapsed state.
const repositionOnGeometryChange = EditorView.updateListener.of((update) => {
  if (update.geometryChanged || update.docChanged) repositionAnnotationGroups(update.view);
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
