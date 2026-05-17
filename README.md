# boxpdf-html

Readable HTML-to-PDF rendering built on [`boxpdf`](https://github.com/earonesty/boxpdf). It is for invoices, receipts, reports, emails, and other authored document HTML where a useful static PDF matters more than browser pixel emulation.

```sh
npm install boxpdf-html boxpdf pdf-lib
```

## CLI

Render an HTML file directly:

```sh
npx boxpdf-html invoice.html invoice.pdf
```

With generated Tailwind CSS:

```sh
npx tailwindcss -i ./tailwind.css -o ./dist/tailwind.css --minify
npx boxpdf-html invoice.html invoice.pdf --css ./dist/tailwind.css
```

With custom fonts and local images:

```sh
npx boxpdf-html invoice.html invoice.pdf \
  --font ./Inter-Regular.ttf \
  --bold-font ./Inter-Bold.ttf \
  --font-family 'Inter=normal:Inter-Regular.ttf,bold:Inter-Bold.ttf'
```

Useful flags:

```sh
boxpdf-html <input.html> <output.pdf>
boxpdf-html - <output.pdf>                  # read HTML from stdin
boxpdf-html input.html output.pdf --css app.css
boxpdf-html input.html output.pdf --base-url ./public
boxpdf-html input.html output.pdf --debug
boxpdf-html input.html output.pdf --unsupported-css
boxpdf-html input.html output.pdf --profile
```

The CLI defaults to pdf-lib's built-in Helvetica family. Use real embedded fonts for production output when brand matching, unicode coverage, or exact metrics matter.

## API

`htmlToBoxpdf` turns HTML into normal boxpdf nodes. You render those nodes with `renderFlow`.

```ts
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { loadFont, loadImage, renderFlow } from "boxpdf";
import { fontFamily, htmlToBoxpdf } from "boxpdf-html";

const html = await readFile("invoice.html", "utf8");
const pdf = await PDFDocument.create();

const inter = await loadFont(pdf, await readFile("Inter-Regular.ttf"));
const interBold = await loadFont(pdf, await readFile("Inter-Bold.ttf"));
const logo = await loadImage(pdf, await readFile("logo.png"));

const result = htmlToBoxpdf(html, {
  font: inter,
  boldFont: interBold,
  resolveFont: fontFamily({
    Inter: {
      normal: inter,
      bold: interBold
    },
    "sans-serif": {
      normal: inter,
      bold: interBold
    }
  }),
  resolveImage: ({ url }) => (url === "logo.png" ? logo : undefined),
  baseUrl: process.cwd(),
  width: 532
});

await renderFlow(pdf, result.nodes, { margin: 40 });
const bytes = await pdf.save();
```

`width` is the CSS containing block width in PDF points. A US Letter page with 40pt margins has a 532pt content width, so `width: 532` is a good default.

## Fonts

Fonts are explicit. `boxpdf-html` does not discover system fonts and does not ship a browser font stack. This keeps rendering deterministic and works in serverless runtimes.

At minimum, pass `font`. Pass `boldFont` and `italicFont` if your HTML uses bold or italic text:

```ts
const result = htmlToBoxpdf(html, {
  font,
  boldFont,
  italicFont,
  width: 532
});
```

For CSS `font-family`, use `fontFamily()`:

```ts
const resolveFont = fontFamily({
  Inter: {
    normal: interRegular,
    bold: interBold,
    italic: interItalic,
    boldItalic: interBoldItalic
  },
  Helvetica: {
    normal: fallback,
    bold: fallbackBold
  },
  "sans-serif": {
    normal: fallback,
    bold: fallbackBold
  }
});
```

The resolver receives `{ families, weight, style }` and returns a pdf-lib `PDFFont`. You can provide your own resolver when you need looser mapping, font aliases, language-specific fallbacks, or weight synthesis.

Gotchas:

- `font-family: system-ui` only works if your resolver maps `system-ui`.
- Standard pdf-lib fonts are convenient but limited; use embedded TTF/OTF fonts for real documents.
- Complex shaping depends on pdf-lib/fontkit behavior. Western-language invoice/report text is the target.
- Font metrics affect layout. Use the same embedded fonts in tests and production when visual stability matters.

## Tailwind CSS

Tailwind works when you render its generated CSS, not raw class names alone. The usual flow is:

1. Write document HTML with Tailwind classes.
2. Run Tailwind against that HTML.
3. Inline or pass the generated CSS to `boxpdf-html`.
4. Render with a containing width that matches your intended PDF content area.

Example source:

```html
<div class="p-6 bg-[#f8fafc] text-gray-900">
  <div class="max-w-[520px] rounded-[10px] border bg-white p-5 shadow-sm">
    <div class="grid grid-cols-[1fr_2fr] gap-x-4 gap-y-3">
      <div class="rounded-md border border-blue-200 bg-blue-50 p-3">
        <p class="text-xs font-semibold uppercase tracking-wide text-blue-700">Status</p>
        <p class="mt-1 text-sm font-bold">Paid</p>
      </div>
      <div class="rounded-md border border-gray-200 p-3">
        <p class="text-xs font-semibold uppercase tracking-wide text-gray-600">Notes</p>
        <p class="mt-1 text-sm leading-5">Two fraction column wraps later.</p>
      </div>
    </div>
  </div>
</div>
```

Build CSS:

```css
@import "tailwindcss";
@source "./invoice.html";
```

```sh
npx tailwindcss -i ./tailwind-input.css -o ./tailwind-output.css --minify
npx boxpdf-html invoice.html invoice.pdf --css ./tailwind-output.css
```

Supported Tailwind patterns include common spacing, color, text, border, radius, width/height, flex, grid, table, image, and arbitrary-value utilities. Unsupported utility declarations can be reported with `--unsupported-css` or `diagnostics: { unsupportedCss: true }`.

Tailwind gotchas:

- Responsive/state variants are parsed as CSS; there is no viewport interaction. Choose a single generated CSS target for the PDF you want.
- `shadow-*`, transforms, filters, transitions, and browser-only effects are either ignored or reported as unsupported. The PDF should remain readable.
- Tailwind preflight resets are mostly harmless. Diagnostics intentionally focus on utility selectors instead of noisy base selectors.
- If text layout matters, use the same fonts in Tailwind design review and PDF rendering.

## Images

The API uses `resolveImage` because pdf-lib images must be embedded before rendering:

```ts
const images = new Map([
  ["logo.png", await loadImage(pdf, await readFile("logo.png"))]
]);

htmlToBoxpdf(html, {
  font,
  resolveImage: ({ url }) => images.get(url),
  baseUrl: process.cwd()
});
```

The CLI preloads local, `http(s)`, and `data:` image URLs referenced by `<img src>` and CSS `url(...)`. Missing images preserve their layout box when width/height can be inferred.

## CSS And HTML Surface

Supported:

- HTML fragments and full documents via `parse5`.
- Stylesheets and inline styles via `css-tree`.
- Selectors: tag, class, id, attributes, descendants, child/sibling combinators, common structural pseudos, and escaped Tailwind selectors.
- Cascade basics: stylesheet rules, inline style, `!important`, inheritance, custom properties, `var()`, and common `calc()`.
- Layout: block, inline, inline-block, inline-flex, inline-grid, flex, grid fallback, tables, floats, absolute/relative positioning, z-index, overflow hidden, and replaced images.
- Text: rich inline runs, hard breaks, normal/no-wrap/pre-like whitespace, transforms, decoration, alignment, vertical-align, list hanging indents, and wrapping.
- Sizing/styling: CSS px to points, pt, em/rem, vw/vh, percentages in common places, min/max widths, box-sizing, margin/padding/gap, backgrounds, background images, borders, per-side borders, border collapse, radius, object-fit.

Not a browser:

- No JavaScript execution.
- No interactive or dynamic layout.
- No full browser paint model.
- No system font discovery.
- CSS support is intentionally expanded around static document output. Use diagnostics to find unsupported declarations in real templates.

## Diagnostics

```ts
const result = htmlToBoxpdf(html, {
  font,
  width: 532,
  diagnostics: { unsupportedCss: true, sampleLimit: 3 },
  profile: (event) => console.log(event.phase, event.elapsedMs)
});

console.log(result.diagnostics?.unsupportedCss);
```

Unsupported CSS diagnostics are aggregated by property/value pair and include selector samples. Profile events cover parsing, CSS, style computation, render-tree construction, and output node counts.

## Release

First publish is manual, because npm needs the package to exist before trusted publishing can be attached:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:release
cd .pack
npm publish --access public
```

Then configure npm trusted publishing for future releases:

```sh
npm trust github boxpdf-html --repo earonesty/boxpdf-html --file release.yml
```

If your npm CLI does not support that command, configure it in npmjs.com package settings:

- Publisher: GitHub Actions
- Owner: `earonesty`
- Repository: `boxpdf-html`
- Workflow filename: `release.yml`
- Environment: blank

Trusted publishing currently requires npm `11.5.1+` and Node `22.14+`; the `npm trust` CLI command itself requires npm `11.10+`. The release workflow uses Node 24 and upgrades npm before publishing. Future releases are tag-driven:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The workflow runs typecheck, tests, build, publishes with OIDC/provenance, and creates a GitHub Release with generated notes.

## Development

During local development, `package.json` depends on the adjacent checkout:

```json
"boxpdf": "file:.."
```

Release packing is done through `scripts/prepare-publish.mjs`, which stages the package and rewrites the published manifest to a real semver dependency:

```json
"boxpdf": "^1.7.0"
```

The script fails if a packed or published manifest would contain a local `file:` dependency.

Useful commands:

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run tailwind:fixture
pnpm run visual:check
pnpm run pack:release
BOXPDF_DEP_VERSION=^1.7.0 pnpm run publish:release
```
