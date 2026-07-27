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

// A small always-on indicator on the side its annotations attach to. Content is revealed on
// hover rather than laid out inline — a simplification for this first pass over the full "show
// inline when there's room, fall back to hover only when space is tight" behavior, which needs
// real viewport measurement to do properly and isn't needed to validate the parsing/target-
// resolution/invisibility mechanics this prototype exists to test.
class AnnotationArrowWidget extends WidgetType {
  constructor(
    private readonly side: 'left' | 'right',
    private readonly annotations: AnnotationRange[],
  ) {
    super();
  }

  eq(other: AnnotationArrowWidget): boolean {
    return this.side === other.side
      && this.annotations.length === other.annotations.length
      && this.annotations.every((annotation, index) => annotation.text === other.annotations[index].text);
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = `annotation-arrow annotation-arrow-${this.side}`;
    wrapper.textContent = this.side === 'left' ? '◂' : '▸';
    wrapper.setAttribute('aria-label', `${this.annotations.length} annotation(s)`);

    const popup = document.createElement('div');
    popup.className = 'annotation-popup';
    for (const annotation of this.annotations) {
      const item = document.createElement('div');
      item.className = 'annotation-popup-item';
      item.textContent = annotation.text;
      popup.append(item);
    }
    wrapper.append(popup);
    wrapper.addEventListener('mouseenter', () => wrapper.classList.add('is-open'));
    wrapper.addEventListener('mouseleave', () => wrapper.classList.remove('is-open'));
    return wrapper;
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
          widget: new AnnotationArrowWidget('left', group.left),
          side: -1,
          block: isWholeBlock,
        }).range(group.range.from));
      }
      if (group.right.length) {
        ranges.push(Decoration.widget({
          widget: new AnnotationArrowWidget('right', group.right),
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
