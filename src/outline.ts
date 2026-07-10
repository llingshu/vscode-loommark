import { fromMarkdown } from 'mdast-util-from-markdown';

type MdastNode = {
  type: string;
  value?: string;
  alt?: string;
  depth?: number;
  children?: MdastNode[];
  position?: { start: { line: number } };
};

export type OutlineNode = {
  label: string;
  level: number;
  line: number;
  ordinal: number;
  children: OutlineNode[];
};

function nodeText(node: MdastNode): string {
  if (node.value) return node.value;
  if (node.type === 'image' && node.alt) return node.alt;
  return node.children?.map(nodeText).join('') ?? '';
}

export function markdownOutline(markdown: string): OutlineNode[] {
  const tree = fromMarkdown(markdown) as MdastNode;
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  let ordinal = 0;

  for (const child of tree.children ?? []) {
    if (child.type !== 'heading' || !child.depth) continue;
    const node: OutlineNode = {
      label: nodeText(child).trim() || `Untitled H${child.depth}`,
      level: child.depth,
      line: child.position?.start.line ?? 1,
      ordinal,
      children: [],
    };
    ordinal++;
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    const siblings = stack.length ? stack[stack.length - 1].children : roots;
    siblings.push(node);
    stack.push(node);
  }

  return roots;
}
