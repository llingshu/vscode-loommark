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
// unrelated color systems. An annotation created through this extension (the context menu's
// "+ Add note", either arrow-key shortcut, or auto-close-on-typing) gets one of these written
// directly into its opening delimiter as a fixed 6-hex-digit tag (loommark-core's
// AnnotationRange.color — see newAnnotationColorTag below), so it keeps the same color forever
// after. Only an annotation that predates this (or was typed by hand without one) falls back to
// colorForAnnotation's by-position assignment, which — as before — can still shift if an earlier,
// still-untagged annotation is added or removed.
const COLOR_PALETTE = ['#7c3aed', '#2563eb', '#168a72', '#b46a08', '#be3455', '#087f8c'];

function colorForAnnotation(allAnnotations: AnnotationRange[], annotation: AnnotationRange): string {
  if (annotation.color) return `#${annotation.color}`;
  const index = allAnnotations.indexOf(annotation);
  return COLOR_PALETTE[(index < 0 ? 0 : index) % COLOR_PALETTE.length];
}

// The 6-hex-digit tag (no `#`) to write into a brand-new annotation's opening delimiter — see
// AnnotationRange.color in loommark-core. Picks the next color in rotation by how many
// annotations already exist in the document; since the new one is tagged from the moment it's
// created, this exact choice only has to be *a* reasonable spread, not track any particular
// position precisely — unlike an untagged annotation's color, it won't recompute or drift later.
function newAnnotationColorTag(source: string): string {
  const count = annotationRanges(source).length;
  return COLOR_PALETTE[count % COLOR_PALETTE.length].slice(1);
}

// Persisted across widget rebuilds (which happen on every edit — see annotationField below) by
// keying on the annotation's own source offset, the same "identify a not-yet-recomputed thing by
// where it used to be" approach TableWidget's pendingTableFocus already relies on elsewhere in
// this kernel. Not robust to an edit shifting offsets *before* the annotation in question — an
// acceptable, clearly-scoped limitation for a first pass, not a hidden one.
const collapsedAnnotations = new Set<number>();
let pendingFocusAnnotationFrom: number | undefined;

// A user can force an individual note's card to stay permanently visible via the right-click
// "Pin"/"Unpin" action, regardless of how much margin is actually available — keyed by
// `${side}:${annotation.from}` since every note is now its own independent card. Checked alongside
// the margin-availability computation in AnnotationMarginWidget's updatePinned.
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
const BAR_WIDTH = 6;
const BAR_GAP = 2;
// Extra hit-area around a stripe bar so hovering to reveal a card doesn't require pixel-precise
// aim at a few-px-wide line — the bar stays thin, only the invisible hover target backing it is
// wider.
const STRIPE_HIT_PADDING = 6;

// Gap kept between two stacked cards on the same side — purely cosmetic, no CSS counterpart to
// stay in sync with.
const CARD_STACK_GAP = 8;
// These two must stay in sync with .annotation-card's width and .annotation-card-left/-right's
// edge offset in annotation.css: the connector's reach toward the card is computed analytically
// here (rather than measured) so measureGroupLayout can run entirely inside CodeMirror's read
// phase without needing a card's real rendered rect just to find its near edge.
const CARD_WIDTH = 230;
const CARD_EDGE_GAP = 6;
// The rail's minimum clearance from its own stripe bar's edge (so the two don't draw on top of
// each other) and the step between two rails simultaneously in use. LANE_GAP equals THICKNESS
// exactly, so adjacent lanes sit flush against each other — a real rainbow's bands touch directly
// with no white sliver between colors, and any actual white gap between two lanes reads as a
// visible defect rather than a deliberate separation, especially right at a turn where it can look
// like a notch cut into the corner. (An earlier version widened this gap to make simultaneous
// connectors distinguishable at all, since a too-small gap is genuinely invisible at normal zoom —
// but the fix for "invisible" is contiguous bands of different color, not empty space between them.)
const CONNECTOR_CLEARANCE = 3;
const CONNECTOR_LANE_GAP = 4;
const CONNECTOR_THICKNESS = 4;

// A single straight piece of a connector — several of these, laid end to end, make up one note's
// full route from its natural row to wherever it actually ended up. See measureGroupLayout's
// per-side lane-assignment comment for why a route needs more than one piece at all.
type ConnectorSegment = { left: number; top: number; width: number; height: number };

type GroupLayoutResult = {
  card: HTMLElement;
  connectorPath: HTMLElement;
  stripeBar: HTMLElement;
  stripeHit: HTMLElement;
  offscreen: boolean;
  top: number;
  barLeft: number;
  stripeTop: number;
  stripeHeight: number;
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
    stripeBar: HTMLElement; stripeHit: HTMLElement;
    side: 'left' | 'right'; naturalTop: number | null; barLeft: number;
    stripeTop: number; stripeHeight: number; height: number;
  };

  const groups = Array.from(workspaceElement.querySelectorAll<HTMLElement>(':scope > .annotation-group'));
  const raw: RawEntry[] = groups.map((group) => {
    const card = group.querySelector<HTMLElement>('.annotation-card')!;
    const connectorPath = group.querySelector<HTMLElement>('.annotation-connector-path')!;
    const stripeBar = group.querySelector<HTMLElement>('.annotation-stripe-bar')!;
    const stripeHit = group.querySelector<HTMLElement>('.annotation-stripe-hit')!;
    const side: 'left' | 'right' = group.dataset.side === 'right' ? 'right' : 'left';
    const stackIndex = Number(group.dataset.stackIndex) || 0;
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
    // Only cards actually pinned open occupy stacking space; an on-hover-only popup is transient
    // and doesn't need collision avoidance against a card that might not even be showing right now.
    const height = card.classList.contains('is-pinned') ? card.getBoundingClientRect().height : 0;
    return { card, connectorPath, stripeBar, stripeHit, side, naturalTop, barLeft, stripeTop, stripeHeight, height };
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

  // Only a card actually pushed away from its own natural row draws a connector at all — several
  // notes on the exact same target inevitably need this (they can't all sit at an identical
  // position), but a lone note usually won't. Two *unrelated* notes (different targets) can easily
  // need one at the same time too, if enough separate single-note targets get crowded together —
  // and since every "first note on its own target" bar sits at the same relative offset
  // (stackIndex 0), their connectors would land at the exact same x and draw right over each other
  // without lane assignment. But a single fixed lane for a connector's *entire* run — assigned once
  // by how much it overlaps everyone else across its whole length — routes it at that same
  // outward offset even long after whatever it was avoiding has already ended, which reads as
  // several permanently-parallel lines rather than one bundle that thins out as each branch peels
  // away. So lanes are assigned per height range instead: the whole set of "connector starts or
  // ends here" heights on a side splits it into slices, and within each slice, only whichever
  // connectors are actually active right then compete for lanes — ranked by how much run they have
  // left (whichever will stay in flight *longest* keeps the innermost lane, hugging the text edge
  // undisturbed, while whichever is about to peel off soonest is the one that steps outward to make
  // room for it — a brief guest taking a detour past a resident that isn't going anywhere), the same
  // interval-scheduling a calendar view uses to lay out overlapping events side by side. Each note's
  // own consecutive same-lane slices are merged back into as few straight pieces as possible, with a
  // short horizontal jog wherever its lane actually changes — so a note's route runs tight alongside
  // its neighbors except exactly where, and for as long as, avoiding them actually requires it.
  type Connecting = { entry: RawEntry; top: number; spanFrom: number; spanTo: number };
  const connecting: Connecting[] = [];
  for (const entry of raw) {
    const top = packedTop.get(entry) ?? entry.naturalTop;
    if (top === null || entry.naturalTop === null || Math.abs(top - entry.naturalTop) <= 1) continue;
    connecting.push({ entry, top, spanFrom: Math.min(entry.naturalTop, top), spanTo: Math.max(entry.naturalTop, top) });
  }

  const segmentsByEntry = new Map<RawEntry, ConnectorSegment[]>();
  const cardNearEdgeFor = (side: 'left' | 'right') =>
    side === 'left' ? CARD_EDGE_GAP + CARD_WIDTH : workspaceRect.width - CARD_EDGE_GAP - CARD_WIDTH;

  for (const side of ['left', 'right'] as const) {
    const items = connecting.filter((item) => item.entry.side === side);
    if (!items.length) continue;
    const outward = side === 'left' ? -1 : 1;
    const railX = (item: Connecting, lane: number) => item.entry.barLeft + outward * (CONNECTOR_CLEARANCE + lane * CONNECTOR_LANE_GAP);

    // Every height any connector on this side starts or ends at, sorted — the boundaries between
    // slices where the set of "who's active" can change.
    const breakpoints = Array.from(new Set(items.flatMap((item) => [item.spanFrom, item.spanTo]))).sort((a, b) => a - b);

    // Each item's own sequence of {from, to, lane} runs, consecutive same-lane slices already
    // merged as they're built.
    const runsByItem = new Map<Connecting, { from: number; to: number; lane: number }[]>(items.map((item) => [item, []]));
    for (let i = 0; i + 1 < breakpoints.length; i++) {
      const sliceFrom = breakpoints[i];
      const sliceTo = breakpoints[i + 1];
      if (sliceTo <= sliceFrom) continue;
      const active = items
        .filter((item) => item.spanFrom <= sliceFrom && item.spanTo >= sliceTo)
        .sort((a, b) => b.spanTo - a.spanTo);
      active.forEach((item, lane) => {
        const runs = runsByItem.get(item)!;
        const last = runs[runs.length - 1];
        if (last && last.lane === lane && last.to === sliceFrom) last.to = sliceTo;
        else runs.push({ from: sliceFrom, to: sliceTo, lane });
      });
    }

    for (const item of items) {
      const runs = runsByItem.get(item)!;
      if (!runs.length) continue;
      const segments: ConnectorSegment[] = [];
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        const x = railX(item, run.lane);
        segments.push({ left: x, top: run.from, width: CONNECTOR_THICKNESS, height: run.to - run.from });
        const next = runs[i + 1];
        if (next && next.lane !== run.lane) {
          const nextX = railX(item, next.lane);
          segments.push({ left: Math.min(x, nextX), top: run.to, width: Math.abs(nextX - x), height: CONNECTOR_THICKNESS });
        }
      }
      const lastRun = runs[runs.length - 1];
      const lastX = railX(item, lastRun.lane);
      const cardNearEdge = cardNearEdgeFor(side);
      segments.push({ left: Math.min(lastX, cardNearEdge), top: item.top, width: Math.abs(cardNearEdge - lastX), height: CONNECTOR_THICKNESS });
      segmentsByEntry.set(item.entry, segments);
    }
  }

  return raw.map((entry) => {
    const { card, connectorPath, stripeBar, stripeHit, barLeft, stripeTop, stripeHeight } = entry;
    // A card not part of the packed (pinned) stacking above just uses its own natural position —
    // covers the hover-only fallback, which doesn't get displaced by neighbors at all.
    const top = packedTop.get(entry) ?? entry.naturalTop;
    if (top === null) {
      return { card, connectorPath, stripeBar, stripeHit, offscreen: true, top: 0, barLeft, stripeTop, stripeHeight, segments: [] };
    }
    return { card, connectorPath, stripeBar, stripeHit, offscreen: false, top, barLeft, stripeTop, stripeHeight, segments: segmentsByEntry.get(entry) ?? [] };
  });
}

function applyGroupLayout(results: GroupLayoutResult[]): void {
  for (const { card, connectorPath, stripeBar, stripeHit, offscreen, top, barLeft, stripeTop, stripeHeight, segments } of results) {
    card.classList.toggle('is-offscreen', offscreen);
    stripeBar.classList.toggle('is-offscreen', offscreen);
    stripeHit.classList.toggle('is-offscreen', offscreen);
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

// The margin indicator for exactly one note: the card itself when there's room (always visible,
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
    return `${this.side}:${this.annotation.from}`;
  }

  eq(other: AnnotationMarginWidget): boolean {
    return this.side === other.side
      && this.targetFrom === other.targetFrom
      && this.targetTo === other.targetTo
      && this.stackIndex === other.stackIndex
      && this.annotation.from === other.annotation.from
      && this.annotation.text === other.annotation.text
      && this.color === other.color
      && this.collapsed === other.collapsed;
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

    const card = document.createElement('div');
    card.className = `annotation-card annotation-card-${this.side}`;
    card.setAttribute('aria-label', 'Annotation');
    card.style.setProperty('--annotation-accent', this.color);
    card.classList.toggle('is-collapsed', this.collapsed);

    const header = document.createElement('div');
    header.className = 'annotation-card-header';
    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'annotation-card-collapse';
    collapseButton.textContent = this.collapsed ? '▸' : '▾';
    collapseButton.setAttribute('aria-label', this.collapsed ? 'Expand this annotation' : 'Collapse this annotation');
    collapseButton.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (collapsedAnnotations.has(this.annotation.from)) collapsedAnnotations.delete(this.annotation.from);
      else collapsedAnnotations.add(this.annotation.from);
      view.dispatch({ effects: refreshAnnotations.of() });
    });
    const preview = document.createElement('span');
    preview.className = 'annotation-card-preview';
    preview.textContent = this.annotation.text.split('\n')[0] || '(empty)';
    header.append(collapseButton, preview);
    card.append(header);

    const textarea = document.createElement('textarea');
    textarea.className = 'annotation-card-text';
    textarea.value = this.annotation.text;
    textarea.rows = Math.max(1, this.annotation.text.split('\n').length);
    textarea.spellcheck = false;
    textarea.addEventListener('blur', () => {
      const next = textarea.value;
      if (next === this.annotation.text) return;
      view.dispatch({ changes: { from: this.annotation.contentFrom, to: this.annotation.contentTo, insert: next } });
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        textarea.value = this.annotation.text;
        textarea.blur();
      }
      // Prevent this editor's own keymap (Enter/Tab/arrow handling meant for the document) from
      // seeing keystrokes typed into this plain textarea.
      event.stopPropagation();
    });
    card.append(textarea);

    const connectorPath = document.createElement('div');
    connectorPath.className = 'annotation-connector-path';
    connectorPath.style.setProperty('--annotation-connector-color', this.color);

    const stripeBar = document.createElement('div');
    stripeBar.className = 'annotation-stripe-bar';
    stripeBar.style.setProperty('--annotation-stripe-color', this.color);
    const stripeHit = document.createElement('div');
    stripeHit.className = 'annotation-stripe-hit';

    const insertNewNote = () => {
      const marker = this.side === 'left' ? '<<<' : '>>>';
      const insertAt = this.annotation.to + 1;
      const tag = newAnnotationColorTag(view.state.doc.toString());
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

    const deleteAnnotation = () => {
      collapsedAnnotations.delete(this.annotation.from);
      manuallyPinnedKeys.delete(this.pinKey);
      const to = Math.min(this.annotation.to + 1, view.state.doc.length);
      view.dispatch({ changes: { from: this.annotation.from, to, insert: '' } });
    };

    const openMenu = (event: MouseEvent) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        { label: 'Delete this note', onSelect: deleteAnnotation },
        { label: '+ Add note', onSelect: insertNewNote },
        { label: manuallyPinnedKeys.has(this.pinKey) ? 'Unpin' : 'Pin', onSelect: togglePinned },
      ]);
    };
    card.addEventListener('contextmenu', openMenu);
    stripeBar.addEventListener('contextmenu', openMenu);
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

    group.append(card, connectorPath, stripeBar, stripeHit);
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

    if (pendingFocusAnnotationFrom === this.annotation.from) {
      pendingFocusAnnotationFrom = undefined;
      window.setTimeout(() => textarea.focus(), 0);
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

type ColoredAnnotation = { annotation: AnnotationRange; color: string; collapsed: boolean };
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
      group.left.forEach(({ annotation, color, collapsed }, stackIndex) => {
        ranges.push(Decoration.widget({
          widget: new AnnotationMarginWidget('left', annotation, color, collapsed, group.from, group.to, stackIndex),
          side: -1,
          block: isWholeBlock,
        }).range(group.from));
      });
      group.right.forEach(({ annotation, color, collapsed }, stackIndex) => {
        ranges.push(Decoration.widget({
          widget: new AnnotationMarginWidget('right', annotation, color, collapsed, group.from, group.to, stackIndex),
          side: 1,
          block: isWholeBlock,
        }).range(group.to));
      });
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

  const tag = newAnnotationColorTag(view.state.doc.toString());
  view.dispatch({
    changes: { from, to, insert: `${text}${tag}\n\n${indent}${text}${text}${text}` },
    selection: { anchor: from + 1 + tag.length },
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
    const tag = newAnnotationColorTag(view.state.doc.toString());
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
