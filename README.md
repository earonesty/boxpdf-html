# boxpdf-html

Readable HTML-to-PDF translation built on [`boxpdf`](https://github.com/earonesty/boxpdf).

This package is intended to translate authored/static HTML into boxpdf primitives. It prioritizes readable PDF output and document structure over browser pixel fidelity.

## Alpha API

```ts
import { fontFamily, htmlToBoxpdf } from "boxpdf-html";

const { nodes, warnings } = htmlToBoxpdf(html, {
  font,
  boldFont,
  italicFont,
  resolveFont: fontFamily({
    Inter: {
      normal: interRegular,
      bold: interBold,
      italic: interItalic
    },
    Helvetica: {
      normal: font,
      bold: boldFont,
      italic: italicFont
    }
  }),
  width: 468
});
```

`htmlToBoxpdf` returns boxpdf nodes that can be passed to the normal `boxpdf` document/page render flow. The alpha parser also exports `parseHtml` for tests and translator debugging.

Fonts must be supplied by the caller. `font`, `boldFont`, and `italicFont` are the fallback faces. `resolveFont` is an optional hook for CSS `font-family`, `font-weight`, and `font-style`; `fontFamily()` is the common-case helper that builds this hook from already-embedded fonts.

## Supported Surface

- HTML fragment parsing through `parse5`, including parser-inserted table sections.
- Stylesheet and inline style parsing through `css-tree`.
- Selectors: tag, class, id, attributes, descendant, direct child, adjacent sibling, general sibling, `:root`, `:first-child`, `:last-child`, and simple `:nth-child()`.
- CSS cascade basics: stylesheet rules, inline styles, `!important`, inherited text styles, custom properties, and `var()` fallbacks.
- Document boxes: block, inline, inline-block, inline-flex, inline-grid, flex rows/columns including reverse directions, simple grid fallback, tables, floats, and replaced images.
- Text behavior: rich inline runs, hard breaks, `white-space` modes, `text-transform`, text decoration, text align, vertical align, hanging list indents, no-wrap, and normal wrapping.
- Sizing and spacing: CSS pixels, `pt`, `em`, `rem`, `vw`, `vh`, percentages for common widths, `calc()`, min/max widths, `box-sizing`, margins including horizontal `auto`, padding, and gaps.
- Box styling: color, modern `rgb()`/`hsl()` colors, background color, background images with size/repeat/position, simple borders, per-side borders, border collapse, border radius, and overflow clipping.
- Positioning: relative/absolute boxes, CSS inset aliases, paired-edge stretch, and `z-index`.
- Images: `<img>`, `object-fit: contain|cover`, unresolved image placeholders when size is known, `srcset`, and simple `picture > source` selection.
- Fonts: CSS `font-family`, `font-size`, `font-weight`, `font-style`, line height, and `font` shorthand through caller-provided font resolvers.
- Diagnostics: optional profile callbacks and unsupported CSS aggregation for real-page triage.

The translator is still intentionally document-oriented: it aims for readable static output from authored HTML, not browser pixel fidelity for arbitrary interactive pages.

## Diagnostics

```ts
const result = htmlToBoxpdf(html, {
  font,
  width: 468,
  diagnostics: { unsupportedCss: true, sampleLimit: 3 },
  profile: (event) => console.log(event.phase, event.elapsedMs)
});

console.log(result.diagnostics?.unsupportedCss);
```

Unsupported CSS diagnostics are aggregated by property/value pair. Profile events cover parsing, style computation, render-tree construction, and output node counts.

## Development

During local development, `package.json` depends on the adjacent checkout:

```json
"boxpdf": "file:.."
```

Release packing is done through `scripts/prepare-publish.mjs`, which copies the package to a temporary staging directory and rewrites the published manifest to a real semver dependency such as:

```json
"boxpdf": "^1.7.0"
```

The script fails if a packed/published manifest would contain a local `file:` dependency.

## Scripts

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run compare:prince
pnpm run visual:regenerate
pnpm run visual:check
pnpm run profile:render
pnpm run pack:release
BOXPDF_DEP_VERSION=^1.7.0 pnpm run publish:release
```

`compare:prince` renders `fixtures/alpha-mvp.html` through both `boxpdf-html` and Prince, then writes PDFs and PNGs to `artifacts/prince-reference`. `visual:regenerate` runs the full fixture set from `scripts/comparisons.mjs`; `visual:check` re-renders BoxPDF outputs and compares PNG baselines. Prince is used as a useful reference renderer, not as the source of truth when its behavior disagrees with CSS or when it lacks a newer feature.

The Prince binary is read from `PRINCE_BIN` when set, otherwise from `.tools/prince/lib/prince/bin/prince`.
