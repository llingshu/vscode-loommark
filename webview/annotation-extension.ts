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

  constructor(
    private readonly side: 'left' | 'right',
    private readonly items: ColoredAnnotation[],
  ) {
    super();
  }

  eq(other: AnnotationMarginWidget): boolean {
    return this.side === other.side
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

    const icon = document.createElement('span');
    icon.className = 'annotation-icon';
    icon.textContent = this.side === 'left' ? '◂' : '▸';
    icon.setAttribute('aria-hidden', 'true');

    const card = document.createElement('div');
    card.className = 'annotation-card';
    card.setAttribute('aria-label', `${this.items.length} annotation(s)`);

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

    wrapper.append(icon, card);
    wrapper.addEventListener('mouseenter', () => wrapper.classList.add('is-open'));
    wrapper.addEventListener('mouseleave', () => wrapper.classList.remove('is-open'));

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
        return;
      }
      const columnRect = textColumn.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const margin = this.side === 'left'
        ? columnRect.left - workspaceRect.left
        : workspaceRect.right - columnRect.right;
      wrapper.classList.toggle('is-pinned', margin >= PIN_THRESHOLD_PX);
    };
    updatePinned();
    this.resizeObserver = new ResizeObserver(updatePinned);
    this.resizeObserver.observe(view.scrollDOM);
    const workspaceElement = view.dom.parentElement?.parentElement;
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
    deleteButton.textContent = '×';
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
          widget: new AnnotationMarginWidget('left', group.left),
          side: -1,
          block: isWholeBlock,
        }).range(group.range.from));
      }
      if (group.right.length) {
        ranges.push(Decoration.widget({
          widget: new AnnotationMarginWidget('right', group.right),
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

export function annotationExtension(): Extension {
  return [
    annotationsVisibleField,
    annotationField,
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
