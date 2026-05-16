# boxpdf-html

Readable HTML-to-PDF translation built on [`boxpdf`](https://github.com/earonesty/boxpdf).

This package is intended to translate authored/static HTML into boxpdf primitives. It prioritizes readable PDF output and document structure over browser pixel fidelity.

## Alpha API

```ts
import { htmlToBoxpdf } from "boxpdf-html";

const { nodes, warnings } = htmlToBoxpdf(html, {
  font,
  boldFont,
  italicFont,
  width: 468
});
```

`htmlToBoxpdf` returns boxpdf nodes that can be passed to the normal `boxpdf` document/page render flow. The alpha parser also exports `parseHtml` for tests and translator debugging.

## Supported MVP Surface

- HTML fragment parsing through `parse5`, including parser-inserted table sections.
- Stylesheet and inline style parsing through `css-tree`.
- Simple selectors: tag, class, id, and descendant selectors.
- Common document boxes: block, inline, inline-block, flex row/column, and table.
- Common text and box styles: color, background color, font size/weight/style, line height, text align, vertical align, width, height, margin, padding, gap, and simple borders.

The goal for `0.1` is a small, predictable translator pipeline that is easy to extend. It does not try to emulate browser layout exhaustively.

## Development

During local development, `package.json` depends on the adjacent checkout:

```json
"boxpdf": "file:.."
```

Release packing is done through `scripts/prepare-publish.mjs`, which copies the package to a temporary staging directory and rewrites the published manifest to a real semver dependency such as:

```json
"boxpdf": "^1.6.1"
```

The script fails if a packed/published manifest would contain a local `file:` dependency.

## Scripts

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:release
BOXPDF_DEP_VERSION=^1.6.1 pnpm run publish:release
```
