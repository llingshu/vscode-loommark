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

// Toggles whether arrow indicators render at all. The underlying annotation source stays hidden
// either way — this only controls the "always shown" arrow itself, matching "正常会一直显示（除非
// 关闭显示）": turning it off hides the arrows, not the invisibility of the annotation blocks.
export const toggleAnnotationsVisible = StateEffect.define<void>();

const annotationsVisibleField = StateField.define<boolean>({
  create: () => true,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(toggleAnnotationsVisible)) return !value;
    }
    return value;
  },
});

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

// Below this many pixels of margin (the gap between the editor's own text column and the edge of
// its scroller) on the widget's side, there isn't room to lay the card out permanently — it falls
// back to an icon revealed on hover instead. Comfortably fits the card's own width (see .annotation-card
// in annotation.css) plus the gap CSS places between it and the text column.
const PIN_THRESHOLD_PX = 232;

// The margin indicator: an icon when space is tight, the note card itself (always visible, no
// hover needed) when there's room — re-measured live via ResizeObserver, since the available
// margin changes with the window/editor width, not just once at render time. Each note is
// directly editable (a <textarea>, not contentEditable — content can be genuinely multi-line, and
// getting a clean, unambiguous string with real "\n"s back out of a multi-line contentEditable
// region is inconsistent across browsers in a way a textarea's own .value never is) and has its
// own delete control; edits commit on blur, matching how table cells already commit in this
// editor, so the whole widget isn't torn down and rebuilt (losing focus) on every keystroke.
class AnnotationMarginWidget extends WidgetType {
  private resizeObserver: ResizeObserver | undefined;

  constructor(
    private readonly side: 'left' | 'right',
    private readonly annotations: AnnotationRange[],
  ) {
    super();
  }

  eq(other: AnnotationMarginWidget): boolean {
    return this.side === other.side
      && this.annotations.length === other.annotations.length
      && this.annotations.every((annotation, index) => (
        annotation.from === other.annotations[index].from && annotation.text === other.annotations[index].text
      ));
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = `annotation-marker annotation-marker-${this.side}`;

    const icon = document.createElement('span');
    icon.className = 'annotation-icon';
    icon.textContent = this.side === 'left' ? '◂' : '▸';
    icon.setAttribute('aria-hidden', 'true');

    const card = document.createElement('div');
    card.className = 'annotation-card';
    card.setAttribute('aria-label', `${this.annotations.length} annotation(s)`);
    for (const annotation of this.annotations) card.append(this.renderItem(view, annotation));

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

    return wrapper;
  }

  private renderItem(view: EditorView, annotation: AnnotationRange): HTMLElement {
    const item = document.createElement('div');
    item.className = 'annotation-item';

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

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'annotation-item-delete';
    deleteButton.textContent = '×';
    deleteButton.setAttribute('aria-label', 'Delete this annotation');
    deleteButton.addEventListener('mousedown', (event) => {
      // mousedown, not click: fires before the textarea below it would otherwise steal focus.
      event.preventDefault();
      const to = Math.min(annotation.to + 1, view.state.doc.length);
      view.dispatch({ changes: { from: annotation.from, to, insert: '' } });
    });

    item.append(textarea, deleteButton);
    return item;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
  }

  ignoreEvent(): boolean {
    return true;
  }
}

type TargetGroup = { range: SourceRange; left: AnnotationRange[]; right: AnnotationRange[] };

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
      group[annotation.side].push(annotation);
    }
    for (const group of groups.values()) {
      // A whole-block target (a table/fenced-code/display-math block, spanning more than one
      // line) is itself rendered as a block-level replace decoration by loommark-core's own
      // fields — a plain inline point widget positioned at that exact boundary gets swallowed
      // by it rather than rendering alongside it. Marking this widget block:true too gives it
      // its own slot instead of competing for the same one; a single-line target doesn't have
      // that conflict; and inline positioning (visually attached to the line's own text).
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
    if (transaction.docChanged || transaction.effects.some((effect) => effect.is(toggleAnnotationsVisible))) {
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
