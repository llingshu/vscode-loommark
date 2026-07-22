# Rich Rendering Demo

## Table

| Name | Count | Price |
| :--- | :---: | ---: |
| Apple | 3 | $1.50 |
| **Pear** | `12` | $0.75 |

## Images

![Remote](https://raw.githubusercontent.com/microsoft/vscode/main/resources/linux/code.png)

Inline ![icon](./missing.png) placeholder demo.

## Tasks

- [ ] Write the report
- [x] Review the spec
- Regular bullet
    - Nested bullet
        - Deep bullet

1. Top level one
2. Top level two
    1. Nested under two (decimal: 2.1, cycle: a)
    2. Nested under two (decimal: 2.2, cycle: b)
        1. Doubly nested (decimal: 2.2.1, cycle: i)
3. Top level three

Note: nesting requires indenting by 4 spaces (`loommark.orderedListStyle`'s section below has
more) — CommonMark requires an ordered marker's content to reach its own content column (3-4+
characters) to be recognized as nested at all; 2 spaces only ever satisfies bullet markers.
Press Tab on a list item line to indent it correctly; it uses the right amount automatically.

## List Guides

- Parent item
    - Child A

        A continuation paragraph under Child A, still connected to it.
    - Child B
        - Grandchild B1
        - Grandchild B2

## Math

Euler's identity $e^{i\pi} + 1 = 0$ inline, and a display block:

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

Prices like $5 and $10 must stay plain text.

## Tags

Ideas tagged #idea and #project/alpha, plus non-tags: issue #123 and c#sharp.

## Escaping

Literal characters: \*not bold\*, \_not italic\_, \#not a tag, \![not an image](x.png).

## Quote and rule

> Outer quote
> > Nested quote

---

## Card Mode

This whole document is already one Card-mode example (every `##` section here is its own
nested card under the top `#` heading), but here is a deeper chain to see more levels stack:

### Level three

Body text at level three.

#### Level four

Body text at level four, nested inside level three, inside Card Mode, inside the document title.

##### Level five

The outermost card (level one, the document title) keeps its full rounded border everywhere;
deeper levels get their own background tint and a plain side-border line rather than
independent rounding, since one line can only round one border.

Done.
