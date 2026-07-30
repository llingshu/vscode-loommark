import {
  annotationRanges,
  annotationColor,
  containsPosition,
  fencedCodeRanges,
  nextAnnotationOpeningTag,
  renderAnnotationInlineMarkdown,
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

// Persisted across widget rebuilds. Numbered annotations use their stable source ID; legacy
// unnumbered blocks fall back to side+offset and retain the older upstream-edit limitation.
const collapsedAnnotations = new Set<string>();
let pendingFocusAnnotationFrom: number | undefined;
let lockedAnnotationKey: string | undefined;

// A user can force an individual note's card to stay permanently visible via Pin/Unpin,
// regardless of how much margin is available. Numbered notes are keyed by their stable ID.
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
const PIN_THRESHOLD_PX = 292;

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

// One stripe bar per annotation attached to a target, stacked inward from that side's own
// line-box edge (index 0 = outermost, closest to the edge = first/oldest annotation on this
// target) — a real overlay element (see findLineElement's comment for why), not a
// background-image layer. Deliberately bold enough to actually catch the eye rather than read as
// a hairline — this is the primary always-visible indicator now that there's no separate marker.
const BAR_WIDTH = 4;
const BAR_GAP = 2;
// Extra hit-area around a stripe bar so hovering to reveal a card doesn't require pixel-precise
// aim at a few-px-wide line — the bar stays thin, only the invisible hover target backing it is
// wider.
const STRIPE_HIT_PADDING = 6;

// Gap kept between two stacked cards on the same side — purely cosmetic, no CSS counterpart to
// stay in sync with.
const CARD_STACK_GAP = 10;
const CARD_EDGE_GAP = 6;
// A connector only appears for the active or locked card. A fixed, short outward jog is therefore
// clearer than routing a bundle of simultaneously visible lines around one another.
const CONNECTOR_CLEARANCE = 3;
const CONNECTOR_THICKNESS = 3;
const SIDE_DENSITY_COLLAPSE_THRESHOLD = 5;

// A single straight piece of a connector — several of these, laid end to end, make up one note's
// full route from its natural row to wherever it actually ended up. See measureGroupLayout's
// per-side lane-assignment comment for why a route needs more than one piece at all.
type ConnectorSegment = { left: number; top: number; width: number; height: number };

type GroupLayoutResult = {
  card: HTMLElement;
  connectorPath: HTMLElement;
  stripeBar: HTMLElement;
  stripeHit: HTMLElement;
  targetBadge: HTMLElement;
  offscreen: boolean;
  top: number;
  barLeft: number;
  stripeTop: number;
  stripeHeight: number;
  targetBadgeLeft: number;
  targetBadgeTop: number;
  densityCollapsed: boolean;
  segments: ConnectorSegment[];
};

// Reads every currently-live annotation group's natural position and, for cards pinned open,
// packs them top-to-bottom without overlap — the same margin-comment stacking Word/Google Docs
// use: sorted by natural (document) order (a stable sort, so several notes sharing one target —
// identical natural position — keep their own stackIndex order rather than an arbitrary one),
// each card pushed down only as far as clearing the previous one requires, never pulled earlier
// than its own natural position. Also positions each group's stripe bar (spanning the target's
// whole vertical extent, whether that's one line or a multi-line block) and, only for a card that
// actually ended up displaced from its natural row, a short connector back to it.
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
    card: HTMLElement; connectorPath: HTMLElement;
    stripeBar: HTMLElement; stripeHit: HTMLElement; targetBadge: HTMLElement;
    side: 'left' | 'right'; naturalTop: number | null; barLeft: number;
    stripeTop: number; stripeHeight: number; targetBadgeLeft: number; targetBadgeTop: number;
    height: number; cardWidth: number; noteCount: number; densityCollapsed: boolean;
  };

  const groups = Array.from(workspaceElement.querySelectorAll<HTMLElement>(':scope > .annotation-group'));
  const raw: RawEntry[] = groups.map((group) => {
    const card = group.querySelector<HTMLElement>('.annotation-card')!;
    const connectorPath = group.querySelector<HTMLElement>('.annotation-connector-path')!;
    const stripeBar = group.querySelector<HTMLElement>('.annotation-stripe-bar')!;
    const stripeHit = group.querySelector<HTMLElement>('.annotation-stripe-hit')!;
    const targetBadge = group.querySelector<HTMLElement>('.annotation-target-badge')!;
    const side: 'left' | 'right' = group.dataset.side === 'right' ? 'right' : 'left';
    const stackIndex = Number(group.dataset.stackIndex) || 0;
    const noteCount = Math.max(1, Number(group.dataset.noteCount) || 1);
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
    // just not for the stripe's left/right edge, which has no meaningful "line box" to match when
    // there's no real line there at all.
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
    const barLeft = !topLineRect ? 0
      : side === 'left'
        ? (topLineRect.left - workspaceRect.left + scrollLeft) + stackIndex * (BAR_WIDTH + BAR_GAP)
        : (topLineRect.right - workspaceRect.left + scrollLeft) - (stackIndex + 1) * BAR_WIDTH - stackIndex * BAR_GAP;
    const targetBadgeLeft = !topLineRect ? 0
      : side === 'left'
        ? (topLineRect.left - workspaceRect.left + scrollLeft) - 12
        : (topLineRect.right - workspaceRect.left + scrollLeft) + 12;
    // A target can own several annotations on the same side. Stacking their number chips down the
    // margin keeps each ID legible instead of letting later chips disappear beyond the page edge.
    const targetBadgeTop = stripeTop + 10 + stackIndex * 20;
    // Only cards actually pinned open occupy stacking space; an on-hover-only popup is transient
    // and doesn't need collision avoidance against a card that might not even be showing right now.
    const cardRect = card.getBoundingClientRect();
    const height = card.classList.contains('is-pinned') ? cardRect.height : 0;
    return { card, connectorPath, stripeBar, stripeHit, targetBadge, side, naturalTop, barLeft, stripeTop, stripeHeight, targetBadgeLeft, targetBadgeTop, height, cardWidth: cardRect.width, noteCount, densityCollapsed: false };
  });

  // Density is a property of the currently visible page, not of one target line. Two notes on an
  // otherwise empty side remain open; a side only becomes compact when that side itself is busy.
  const visibleBottom = scrollTop + workspaceRect.height;
  for (const side of ['left', 'right'] as const) {
    const visibleCount = raw.filter((entry) => entry.side === side
      && entry.naturalTop !== null
      && entry.stripeTop <= visibleBottom
      && entry.stripeTop + Math.max(entry.stripeHeight, 1) >= scrollTop)
      .reduce((count, entry) => count + entry.noteCount, 0);
    if (visibleCount < SIDE_DENSITY_COLLAPSE_THRESHOLD) continue;
    raw.filter((entry) => entry.side === side && entry.card.classList.contains('is-pinned'))
      .forEach((entry) => { entry.densityCollapsed = true; });
  }

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

  const segmentsByEntry = new Map<RawEntry, ConnectorSegment[]>();
  for (const entry of raw) {
    const top = packedTop.get(entry) ?? entry.naturalTop;
    if (top === null || entry.naturalTop === null || Math.abs(top - entry.naturalTop) <= 1) continue;
    const outward = entry.side === 'left' ? -1 : 1;
    const railX = entry.barLeft + outward * CONNECTOR_CLEARANCE;
    const startY = entry.stripeTop + Math.min(entry.stripeHeight / 2, 11);
    const endY = top + 16;
    const cardNearEdge = entry.side === 'left'
      ? CARD_EDGE_GAP + entry.cardWidth
      : workspaceRect.width - CARD_EDGE_GAP - entry.cardWidth;
    const horizontal = (from: number, to: number, y: number): ConnectorSegment => ({
      left: Math.min(from, to), top: y, width: Math.abs(to - from) + CONNECTOR_THICKNESS, height: CONNECTOR_THICKNESS,
    });
    segmentsByEntry.set(entry, [
      horizontal(entry.barLeft, railX, startY),
      { left: railX, top: Math.min(startY, endY), width: CONNECTOR_THICKNESS, height: Math.abs(endY - startY) + CONNECTOR_THICKNESS },
      horizontal(railX, cardNearEdge, endY),
    ]);
  }

  return raw.map((entry) => {
    const { card, connectorPath, stripeBar, stripeHit, targetBadge, barLeft, stripeTop, stripeHeight, targetBadgeLeft, targetBadgeTop, densityCollapsed } = entry;
    // A card not part of the packed (pinned) stacking above just uses its own natural position —
    // covers the hover-only fallback, which doesn't get displaced by neighbors at all.
    const top = packedTop.get(entry) ?? entry.naturalTop;
    if (top === null) {
      return { card, connectorPath, stripeBar, stripeHit, targetBadge, offscreen: true, top: 0, barLeft, stripeTop, stripeHeight, targetBadgeLeft, targetBadgeTop, densityCollapsed, segments: [] };
    }
    return { card, connectorPath, stripeBar, stripeHit, targetBadge, offscreen: false, top, barLeft, stripeTop, stripeHeight, targetBadgeLeft, targetBadgeTop, densityCollapsed, segments: segmentsByEntry.get(entry) ?? [] };
  });
}

function applyGroupLayout(results: GroupLayoutResult[]): void {
  for (const { card, connectorPath, stripeBar, stripeHit, targetBadge, offscreen, top, barLeft, stripeTop, stripeHeight, targetBadgeLeft, targetBadgeTop, densityCollapsed, segments } of results) {
    card.classList.toggle('is-density-collapsed', densityCollapsed);
    card.classList.toggle('is-offscreen', offscreen);
    stripeBar.classList.toggle('is-offscreen', offscreen);
    stripeHit.classList.toggle('is-offscreen', offscreen);
    targetBadge.classList.toggle('is-offscreen', offscreen || stripeHeight === 0);
    if (offscreen) {
      for (const el of Array.from(connectorPath.children)) el.classList.remove('is-visible');
      continue;
    }
    card.style.top = `${top}px`;

    stripeBar.style.left = `${barLeft}px`;
    stripeBar.style.top = `${stripeTop}px`;
    stripeBar.style.height = `${stripeHeight}px`;
    stripeHit.style.left = `${barLeft - STRIPE_HIT_PADDING}px`;
    stripeHit.style.top = `${stripeTop}px`;
    stripeHit.style.width = `${BAR_WIDTH + STRIPE_HIT_PADDING * 2}px`;
    stripeHit.style.height = `${stripeHeight}px`;
    targetBadge.style.left = `${targetBadgeLeft}px`;
    targetBadge.style.top = `${targetBadgeTop}px`;

    // The path's own element count tracks each result's own segment count exactly (rebuilt fresh
    // every measure pass from the current lane assignment) — reusing existing elements where
    // possible instead of always clearing + recreating avoids a flash of "no connector" every time
    // the DOM is touched, e.g. while a neighboring note's typing is triggering nearby relayouts.
    const existing = Array.from(connectorPath.children) as HTMLElement[];
    segments.forEach((segment, index) => {
      let el = existing[index];
      if (!el) {
        el = document.createElement('div');
        el.className = 'annotation-connector-segment';
        connectorPath.appendChild(el);
      }
      el.style.left = `${segment.left}px`;
      el.style.top = `${segment.top}px`;
      el.style.width = `${segment.width}px`;
      el.style.height = `${segment.height}px`;
      el.classList.add('is-visible');
    });
    for (let i = segments.length; i < existing.length; i++) existing[i].remove();
  }
}

// requestMeasure's own key coalesces same-key requests queued within a frame down to one, so
// several widgets each calling this in the same toDOM pass (e.g. two notes on the same target
// both rebuilding on the same edit) run one shared layout pass instead of one redundant pass per
// widget.
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

type ColoredAnnotation = { annotation: AnnotationRange; color: string; collapsed: boolean };

// The margin indicator for one target-side group: notes sharing a target on the same side become
// sections inside one card, keeping the margin quiet even when a line has many annotations.
// The card itself when there's room (always visible,
// no hover needed), a hover-revealed popup otherwise — re-measured live via ResizeObserver, since
// the available margin changes with the window/editor width, not just once at render time, and a
// manual "Pin" (see manuallyPinnedKeys) can force it open regardless. Several notes attached to
// the same line each get their own independent widget/card/stripe bar rather than being crammed
// into one shared card — a single card holding several unrelated notes read as far messier than
// several small, clean, single-purpose cards stacked in the margin the same way unrelated notes
// already are. The note is directly editable (a <textarea>, not contentEditable — content can be
// genuinely multi-line, and getting a clean, unambiguous string with real "\n"s back out of a
// multi-line contentEditable region is inconsistent across browsers in a way a textarea's own
// .value never is) and collapsible; delete/add-note/pin live in a right-click context menu instead
// of inline buttons. Edits commit on blur, matching how table cells already commit in this editor,
// so the widget isn't torn down and rebuilt (losing focus) on every keystroke.
class AnnotationMarginWidget extends WidgetType {
  private resizeObserver: ResizeObserver | undefined;
  private group: HTMLElement | undefined;

  constructor(
    private readonly side: 'left' | 'right',
    private readonly annotation: AnnotationRange,
    private readonly color: string,
    private readonly collapsed: boolean,
    private readonly members: ColoredAnnotation[],
    // The full target range this note's stripe/card/connector is attached to — carried along so
    // toDOM can record it for repositionAnnotationGroups to read back later (both endpoints, since
    // the stripe needs the target's whole vertical extent, not just one end of it), and so eq()
    // notices when an upstream edit shifts it (annotation.from already has this same
    // shifts-under-upstream-edits characteristic; these just extend the same comparison).
    private readonly targetFrom: number,
    private readonly targetTo: number,
    // This note's position among every note attached to the same target+side, in document order —
    // index 0 is the outermost stripe bar (closest to the true edge). Only affects the bar's own
    // stacking offset; carried in eq() since a sibling note being added/removed shifts everyone
    // after it over by one bar-width, which needs a rebuilt DOM node to pick up.
    private readonly stackIndex: number,
  ) {
    super();
  }

  private get pinKey(): string {
    const identities = this.members
      .map(({ annotation }) => annotation.id !== undefined ? `id:${annotation.id}` : `at:${annotation.from}`)
      .join(',');
    return `group:${this.side}:${identities}`;
  }

  eq(other: AnnotationMarginWidget): boolean {
    return this.side === other.side
      && this.targetFrom === other.targetFrom
      && this.targetTo === other.targetTo
      && this.stackIndex === other.stackIndex
      && this.annotation.from === other.annotation.from
      && this.annotation.text === other.annotation.text
      && this.annotation.id === other.annotation.id
      && this.color === other.color
      && this.collapsed === other.collapsed
      && this.members.length === other.members.length
      && this.members.every(({ annotation, color }, index) => {
        const otherMember = other.members[index];
        return otherMember?.annotation.from === annotation.from
          && otherMember.annotation.text === annotation.text
          && otherMember.annotation.id === annotation.id
          && otherMember.color === color;
      });
  }

  toDOM(view: EditorView): HTMLElement {
    // Zero-size — purely a position anchor for CodeMirror's own decoration bookkeeping (eq/destroy
    // lifecycle). Nothing about this annotation renders inline in the text anymore: the stripe
    // (an overlay, not this anchor) is the sole always-visible indicator, doubling as the
    // hover/click target, so there's no second, separate colored marker duplicating it.
    const anchor = document.createElement('span');
    anchor.style.display = 'none';

    // group itself is `display: contents` (see annotation.css) purely so the card/connectors/
    // stripe bar/hit-area still all resolve their position:absolute containing block through to
    // .loommark-workspace, while still being removable as one unit in destroy().
    const group = document.createElement('div');
    group.className = 'annotation-group';
    group.dataset.targetFrom = String(this.targetFrom);
    group.dataset.targetTo = String(this.targetTo);
    group.dataset.side = this.side;
    group.dataset.stackIndex = String(this.stackIndex);
    group.dataset.noteCount = String(this.members.length);

    const card = document.createElement('div');
    card.className = `annotation-card annotation-card-${this.side}`;
    card.setAttribute('aria-label', 'Annotation');
    card.style.setProperty('--annotation-accent', this.color);
    card.classList.toggle('is-collapsed', this.collapsed);
    card.classList.toggle('is-locked', lockedAnnotationKey === this.pinKey);
    card.classList.toggle('has-multiple', this.members.length > 1);

    const header = document.createElement('div');
    header.className = 'annotation-card-header';
    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'annotation-card-collapse';
    collapseButton.textContent = this.collapsed ? '▸' : '▾';
    collapseButton.setAttribute('aria-label', this.collapsed ? 'Expand this annotation' : 'Collapse this annotation');
    collapseButton.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const keys = this.members.map(({ annotation }) => annotation.id !== undefined ? `id:${annotation.id}` : `${this.side}:${annotation.from}`);
      const collapse = !keys.every((key) => collapsedAnnotations.has(key));
      keys.forEach((key) => {
        if (collapse) collapsedAnnotations.add(key);
        else collapsedAnnotations.delete(key);
      });
      view.dispatch({ effects: refreshAnnotations.of() });
    });
    const preview = document.createElement('span');
    preview.className = 'annotation-card-preview';
    const firstPreview = this.members[0].annotation.text.split('\n')[0] || '(empty)';
    preview.textContent = this.members.length === 1 ? firstPreview : `${firstPreview} +${this.members.length - 1}`;
    const idBadge = document.createElement('span');
    idBadge.className = 'annotation-card-id';
    // Every section below already names its note. Repeating a long ID list in the compact header
    // would squeeze the menu out of view, so the header only identifies the first section.
    idBadge.textContent = this.annotation.id !== undefined ? `[${this.annotation.id}]` : '';
    idBadge.hidden = this.annotation.id === undefined;
    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'annotation-card-menu';
    menuButton.textContent = '⋯';
    menuButton.title = 'Annotation actions';
    menuButton.setAttribute('aria-label', 'Annotation actions');
    header.append(collapseButton, idBadge, preview, menuButton);
    card.append(header);

    const textareas: HTMLTextAreaElement[] = [];
    for (const { annotation, color } of this.members) {
      const section = document.createElement('section');
      section.className = 'annotation-card-section';
      section.style.setProperty('--annotation-section-accent', color);
      const sectionLabel = document.createElement('span');
      sectionLabel.className = 'annotation-card-section-label';
      sectionLabel.textContent = annotation.id !== undefined ? `[${annotation.id}]` : 'Note';
      const rendered = document.createElement('div');
      rendered.className = 'annotation-card-rendered';
      rendered.tabIndex = 0;
      rendered.setAttribute('role', 'button');
      rendered.setAttribute('aria-label', 'Edit annotation');
      renderAnnotationInlineMarkdown(rendered, annotation.text);
      const textarea = document.createElement('textarea');
      textarea.className = 'annotation-card-text';
      textarea.value = annotation.text;
      textarea.rows = Math.min(8, Math.max(2, annotation.text.split('\n').length));
      textarea.spellcheck = false;
      textarea.addEventListener('blur', () => {
        const next = textarea.value;
        section.classList.remove('is-editing');
        if (next !== annotation.text) {
          view.dispatch({ changes: { from: annotation.contentFrom, to: annotation.contentTo, insert: next } });
        }
      });
      textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          textarea.value = annotation.text;
          textarea.blur();
        }
        event.stopPropagation();
      });
      const startEditing = () => {
        section.classList.add('is-editing');
        window.setTimeout(() => textarea.focus(), 0);
      };
      rendered.addEventListener('mousedown', (event) => {
        if ((event.target as HTMLElement).closest('a')) return;
        event.preventDefault();
        startEditing();
      });
      rendered.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        startEditing();
      });
      section.append(sectionLabel, rendered, textarea);
      card.append(section);
      textareas.push(textarea);
    }

    const connectorPath = document.createElement('div');
    connectorPath.className = 'annotation-connector-path';
    connectorPath.style.setProperty('--annotation-connector-color', this.color);

    const stripeBar = document.createElement('div');
    stripeBar.className = 'annotation-stripe-bar';
    stripeBar.style.setProperty('--annotation-stripe-color', this.color);
    const stripeHit = document.createElement('div');
    stripeHit.className = 'annotation-stripe-hit';
    const targetBadge = document.createElement('button');
    targetBadge.type = 'button';
    targetBadge.className = 'annotation-target-badge';
    const targetLabels = this.members.map(({ annotation }) => annotation.id !== undefined ? String(annotation.id) : '•');
    // The target marker is an entry point to the combined card, not a complete index. Keeping
    // only the first ID makes it stable and legible even when a line owns many notes.
    targetBadge.textContent = targetLabels[0];
    targetBadge.title = targetLabels.length === 1
      ? `Annotation ${targetLabels[0]}`
      : `Annotations ${targetLabels.join(', ')}`;
    targetBadge.setAttribute('aria-label', targetBadge.title);
    targetBadge.style.setProperty('--annotation-accent', this.color);

    const insertNewNote = () => {
      const marker = this.side === 'left' ? '<<<' : '>>>';
      const insertAt = Math.max(...this.members.map(({ annotation }) => annotation.to)) + 1;
      const tag = nextAnnotationOpeningTag(view.state.doc.toString());
      const insertText = `${marker}${tag}\n\n${marker}\n`;
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
      collapsedAnnotations.delete(annotation.id !== undefined ? `id:${annotation.id}` : `${this.side}:${annotation.from}`);
      if (lockedAnnotationKey === this.pinKey) lockedAnnotationKey = undefined;
      const to = Math.min(annotation.to + 1, view.state.doc.length);
      view.dispatch({ changes: { from: annotation.from, to, insert: '' } });
    };

    const showActions = (x: number, y: number) => {
      const deleteActions = this.members.map(({ annotation }) => ({
        label: annotation.id !== undefined ? `Delete [${annotation.id}]` : 'Delete note',
        onSelect: () => deleteAnnotation(annotation),
      }));
      showContextMenu(x, y, [
        ...deleteActions,
        { label: '+ Add note', onSelect: insertNewNote },
        { label: manuallyPinnedKeys.has(this.pinKey) ? 'Unpin' : 'Pin', onSelect: togglePinned },
      ]);
    };
    const openMenu = (event: MouseEvent) => {
      event.preventDefault();
      showActions(event.clientX, event.clientY);
    };
    menuButton.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = menuButton.getBoundingClientRect();
      showActions(rect.right, rect.bottom + 4);
    });
    card.addEventListener('contextmenu', openMenu);
    stripeBar.addEventListener('contextmenu', openMenu);
    stripeHit.addEventListener('contextmenu', openMenu);
    targetBadge.addEventListener('contextmenu', openMenu);

    // The stripe hit-area and the (now-detached) card no longer share a DOM ancestor, so ":hover"
    // can't bridge them with a plain CSS descendant selector; open/close state is tracked on the
    // card directly instead, and mouseleave gets a grace delay so the mouse can travel across the
    // gap between the highlighted line and the edge-pinned card without the card closing mid-transit.
    let closeTimer: number | undefined;
    const openCard = () => {
      window.clearTimeout(closeTimer);
      card.classList.add('is-open', 'is-active');
      repositionAnnotationGroups(view);
    };
    const scheduleClose = () => {
      closeTimer = window.setTimeout(() => {
        card.classList.remove('is-active');
        if (!card.classList.contains('is-locked') && !card.matches(':focus-within')) card.classList.remove('is-open');
        repositionAnnotationGroups(view);
      }, 300);
    };
    stripeHit.addEventListener('mouseenter', openCard);
    stripeHit.addEventListener('mouseleave', scheduleClose);
    targetBadge.addEventListener('mouseenter', openCard);
    targetBadge.addEventListener('mouseleave', scheduleClose);
    card.addEventListener('mouseenter', openCard);
    card.addEventListener('mouseleave', scheduleClose);
    card.addEventListener('focusin', openCard);
    card.addEventListener('focusout', scheduleClose);
    const toggleLocked = (event: MouseEvent) => {
      event.preventDefault();
      const locking = lockedAnnotationKey !== this.pinKey;
      lockedAnnotationKey = locking ? this.pinKey : undefined;
      findWorkspaceElement(view)?.querySelectorAll('.annotation-card.is-locked')
        .forEach((element) => element.classList.remove('is-locked'));
      card.classList.toggle('is-locked', locking);
      if (locking) openCard();
      else scheduleClose();
    };
    stripeHit.addEventListener('mousedown', toggleLocked);
    targetBadge.addEventListener('mousedown', toggleLocked);

    group.append(card, connectorPath, stripeBar, stripeHit, targetBadge);
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

    if (this.members.some(({ annotation }) => pendingFocusAnnotationFrom === annotation.from)) {
      pendingFocusAnnotationFrom = undefined;
      window.setTimeout(() => textareas[0]?.focus(), 0);
    }

    return anchor;
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
        color: annotationColor(annotations, annotation),
        collapsed: collapsedAnnotations.has(annotation.id !== undefined ? `id:${annotation.id}` : `${annotation.side}:${annotation.from}`),
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
      for (const side of ['left', 'right'] as const) {
        const members = group[side];
        if (!members.length) continue;
        const primary = members[0];
        const collapsed = members.every((member) => member.collapsed);
        ranges.push(Decoration.widget({
          widget: new AnnotationMarginWidget(side, primary.annotation, primary.color, collapsed, members, group.from, group.to, 0),
          side: side === 'left' ? -1 : 1,
          block: isWholeBlock,
        }).range(side === 'left' ? group.from : group.to));
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

const annotationOpenPattern = /^[ \t]*(<<<|>>>)(?:\[([1-9]\d*)\])?([0-9a-fA-F]{6})?\s*$/;
const annotationClosePattern = /^[ \t]*(<<<|>>>)\s*$/;

// Returns the marker of the annotation that is still open immediately before `before`. This
// mirrors loommark-core's non-nesting fence rules closely enough to distinguish a user's closing
// delimiter from a new opener while the third character is still being typed.
function openAnnotationMarkerBefore(source: string, before: number): '<<<' | '>>>' | undefined {
  const excluded = fencedCodeRanges(source);
  const lines = source.split('\n');
  let offset = 0;
  let open: '<<<' | '>>>' | undefined;

  for (const line of lines) {
    const lineFrom = offset;
    if (lineFrom >= before) break;
    if (!containsPosition(excluded, lineFrom)) {
      if (!open) {
        const match = line.match(annotationOpenPattern);
        if (match) open = match[1] as '<<<' | '>>>';
      } else {
        const match = line.match(annotationClosePattern);
        if (match?.[1] === open) open = undefined;
      }
    }
    offset += line.length + 1;
  }

  return open;
}

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

  const source = view.state.doc.toString();
  if (containsPosition(fencedCodeRanges(source), line.from)) return false;
  const marker = text === '<' ? '<<<' : '>>>';
  if (openAnnotationMarkerBefore(source, line.from) === marker) return false;

  const tag = nextAnnotationOpeningTag(source);
  pendingFocusAnnotationFrom = line.from;
  view.dispatch({
    changes: { from, to, insert: `${text}${tag}\n\n${indent}${text}${text}${text}` },
    // The annotation is immediately replaced by a hidden block decoration. Never leave the
    // document selection inside that hidden source: Backspace/Enter would otherwise mutate its
    // generated color tag and delimiters before the card's textarea receives focus.
    selection: { anchor: line.from },
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

// Wraps the line the cursor is currently on in a fresh, empty margin annotation block and focuses
// its textarea — the keyboard equivalent of typing `<<<`/`<<<` (or `>>>`/`>>>`) by hand around
// that line, for when reaching for the mouse (or remembering the exact fence syntax) is more
// friction than the annotation itself is worth. Bound to the arrow that matches the side it
// creates (Left/Right) rather than one key for both, so the direction you press is the side you
// get, with nothing to additionally remember. Inserting `\n<<<\n\n<<<` right at the current line's
// own end (not a whole separate line below it) keeps the block immediately attached to that line,
// matching how "annotates the line directly above" already works everywhere else in this syntax;
// a leading `\n` starts the new block on its own line without disturbing the current line's own
// content, and any text that already followed ends up after the block, unchanged.
function annotateCurrentLine(side: 'left' | 'right') {
  return (view: EditorView): boolean => {
    const marker = side === 'left' ? '<<<' : '>>>';
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const insertAt = line.to;
    const focusFrom = insertAt + 1;
    const tag = nextAnnotationOpeningTag(view.state.doc.toString());
    pendingFocusAnnotationFrom = focusFrom;
    view.dispatch({ changes: { from: insertAt, insert: `\n${marker}${tag}\n\n${marker}` } });
    return true;
  };
}

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
      {
        key: 'Mod-Shift-ArrowLeft',
        run: annotateCurrentLine('left'),
      },
      {
        key: 'Mod-Shift-ArrowRight',
        run: annotateCurrentLine('right'),
      },
    ]),
  ];
}
