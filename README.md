# @boxpdf/html-reader

Readable HTML-to-PDF rendering built on [`@boxpdf/writer`](https://github.com/earonesty/boxpdf). It is for invoices, receipts, reports, emails, and other authored document HTML where a useful static PDF matters more than browser pixel emulation.

```sh
npm install @boxpdf/html-reader @boxpdf/writer pdf-lib
```

The original `boxpdf-html` package and `boxpdf-html` command remain supported. They are published
from the same build and at the same version as `@boxpdf/html-reader`. New projects should use the
scoped package; existing projects do not need to change.

## CLI

Render an HTML file directly:

```sh
npx @boxpdf/html-reader invoice.html invoice.pdf
```

The scoped package also provides `html-reader` as a shorter command name.

With generated Tailwind CSS:

```sh
npx tailwindcss -i ./tailwind.css -o ./dist/tailwind.css --minify
npx @boxpdf/html-reader invoice.html invoice.pdf --css ./dist/tailwind.css
```

For very large inputs, add `--stream`:

```sh
npx @boxpdf/html-reader archive.html archive.pdf --stream
type archive.html | npx @boxpdf/html-reader - archive.pdf --stream
```

Streaming makes two bounded passes over the HTML: one for CSS, fonts, and
images, then one for incremental layout and PDF output. Stdin is spooled to a
temporary file so it can be reopened. The output replaces its destination only
after a successful conversion. This path requires `boxpdf` 1.12.0 or newer.

With PDF 2.0 AES-256 password encryption:

```sh
BOXPDF_PASSWORD='open me' \
  npx @boxpdf/html-reader invoice.html invoice.pdf --password-env BOXPDF_PASSWORD
```

`--password-env` accepts an environment-variable name. The variable must be
set to a non-empty password. The password value is never accepted as a command
argument, which keeps it out of the command line and process listing.

With custom fonts and local images:

```sh
npx @boxpdf/html-reader invoice.html invoice.pdf \
  --font ./Inter-Regular.ttf \
  --bold-font ./Inter-Bold.ttf \
  --font-family 'Inter=normal:Inter-Regular.ttf,bold:Inter-Bold.ttf'
```

Useful flags:

```sh
html-reader <input.html> <output.pdf>
html-reader - <output.pdf>                  # read HTML from stdin
html-reader input.html output.pdf --css app.css
html-reader input.html output.pdf --base-url ./public
html-reader input.html output.pdf --password-env BOXPDF_PASSWORD
html-reader input.html output.pdf --debug
html-reader input.html output.pdf --unsupported-css
html-reader input.html output.pdf --profile
html-reader input.html output.pdf --stream
```

The CLI defaults to pdf-lib's built-in Helvetica family. Use real embedded fonts for production output when brand matching, unicode coverage, or exact metrics matter.

## MCP server

`boxpdf-html mcp` is a stdio [MCP](https://modelcontextprotocol.io) server for AI agents. It's batteries-included: an `html_to_pdf` tool plus the full boxpdf library docs, so an agent never has to add a second server.

```sh
claude mcp add boxpdf-html -- npx -y @boxpdf/html-reader mcp
```

**Tools**

- `html_to_pdf` — render an HTML string (and optional `css`) to a PDF. Writes to `outputPath`, or returns the PDF inline as a base64 resource. Always returns `warnings` and `unsupportedCss` diagnostics so the agent can fix its input.
  - Args: `html` (required), `css`, `outputPath`, `size` (`Letter`/`A4`/`Legal`/`Tabloid`, default `Letter`), `margin` (default 40), `baseUrl`, `fonts: { regular, bold, italic, boldItalic }` (TTF/OTF paths), `allowRemote` (default `false` — http(s) image fetches are blocked unless enabled), `debug`.
- `boxpdf_docs` — focused guidance for building PDFs with the libraries directly. `topic`: `quickstart` (default), `fonts`, `themes`, `tables`, `pagination`, `streaming`, `html-api`, `cloudflare`.

**Resources**: `boxpdf-html://guide`, `boxpdf-html://readme`, `boxpdf://readme`, and the five `boxpdf://templates/<name>` sources (receipt, boarding-pass, resume, order-confirmation, certificate).

The server runs no JavaScript and (by default) makes no network requests. `outputPath` writes with the agent's filesystem permissions; without it, PDFs over 1 MB are summarized rather than inlined.

## API

### `htmlToPdf` — one call to bytes

`htmlToPdf(html, options?)` is the simplest path: it creates the document, embeds fonts, renders, and returns the PDF bytes. Fonts default to the built-in Helvetica family, so the minimal call needs no setup.

```ts
import { htmlToPdf } from "@boxpdf/html-reader";

const bytes = await htmlToPdf("<h1>Invoice</h1><p>Thanks for your order.</p>");
```

Pass embedded fonts (via `loadFont`) and a `resolveImage` callback for production output:

```ts
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { loadFont, loadImage } from "@boxpdf/writer";
import { htmlToPdf } from "@boxpdf/html-reader";

const pdf = await PDFDocument.create();
const inter = await loadFont(pdf, await readFile("Inter-Regular.ttf"));
const interBold = await loadFont(pdf, await readFile("Inter-Bold.ttf"));
const logo = await loadImage(pdf, await readFile("logo.png"));

const bytes = await htmlToPdf(await readFile("invoice.html", "utf8"), {
  pdf,                       // reuse the document you embedded into
  font: inter,
  boldFont: interBold,
  resolveImage: ({ url }) => (url === "logo.png" ? logo : undefined),
  margin: 40
});
```

Options: `font` / `boldFont` / `italicFont` / `boldItalicFont` (default to Helvetica), `pdf` (render into an existing document), `margin` (default 40), `size` (default US Letter), `width` (CSS containing-block width; defaults to the page's content width), `debug`, plus everything `htmlToBoxpdf` accepts (`resolveFont`, `resolveImage`, `baseUrl`, `defaultFontSize`, `defaultColor`, `diagnostics`, `profile`).

### `htmlToBoxpdf` — the nodes, for full control

`htmlToBoxpdf` turns HTML into normal boxpdf nodes without rendering. Reach for it when you need the nodes themselves, the `warnings`/`diagnostics`, multiple render passes, or `renderFlow` headers/footers.

```ts
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { loadFont, loadImage, renderFlow } from "@boxpdf/writer";
import { fontFamily, htmlToBoxpdf } from "@boxpdf/html-reader";

const html = await readFile("invoice.html", "utf8");
const pdf = await PDFDocument.create();

const inter = await loadFont(pdf, await readFile("Inter-Regular.ttf"));
const interBold = await loadFont(pdf, await readFile("Inter-Bold.ttf"));
const logo = await loadImage(pdf, await readFile("logo.png"));

const result = htmlToBoxpdf(html, {
  font: inter,
  boldFont: interBold,
  resolveFont: fontFamily({
    Inter: { normal: inter, bold: interBold },
    "sans-serif": { normal: inter, bold: interBold }
  }),
  resolveImage: ({ url }) => (url === "logo.png" ? logo : undefined),
  baseUrl: process.cwd(),
  width: 532
});

console.log(result.warnings);
await renderFlow(pdf, result.nodes, { margin: 40 });
const bytes = await pdf.save();
```

`width` is the CSS containing block width in PDF points. A US Letter page with 40pt margins has a 532pt content width, so `width: 532` is a good default.

### `streamHtmlToPdf` — bounded large-document conversion

`streamHtmlToPdf` accepts a function that reopens the HTML for each of its two
passes and writes PDF bytes incrementally. Embed fonts before calling it; use
`prepare` to embed images found by the resource preflight before output begins.

```ts
import { createReadStream, createWriteStream } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { nodeAdapter } from "@boxpdf/writer";
import { streamHtmlToPdf } from "@boxpdf/html-reader";

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);

const result = await streamHtmlToPdf(
  () => createReadStream("archive.html"),
  nodeAdapter(createWriteStream("archive.pdf")),
  { pdf, font, width: 532, margin: 40 }
);

console.log(result.pageCount, result.dom.maxBufferedNodes);
```

Ordinary block wrappers and tables are released in bounded continuation
fragments. Atomic layouts such as flex/grid, positioned or transformed
containers, and single uninterrupted text nodes have explicit safety caps and
fail with a useful error when they cannot be streamed safely. Selectors whose
meaning depends on sibling position conservatively disable wrapper
fragmentation.

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
npx @boxpdf/html-reader invoice.html invoice.pdf --css ./tailwind-output.css
```

Supported Tailwind patterns include common spacing, color, text, border, radius, width/height, flex, grid, table, image, and arbitrary-value utilities. Unsupported utility declarations can be reported with `--unsupported-css` or `diagnostics: { unsupportedCss: true }`.

Tailwind gotchas:

- Responsive/state variants are parsed as CSS; there is no viewport interaction. Choose a single generated CSS target for the PDF you want.
- Two-dimensional transforms support ordered `translate`, `scale`, `rotate`, `skew`, and `matrix` function lists, their X/Y variants, `transform-origin`, and the standalone `translate`, `rotate`, and `scale` properties. Length/percentage translations and `deg`, `grad`, `rad`, and `turn` angles are supported. Three-dimensional transforms, shadows, filters, transitions, and browser-only effects are ignored or reported as unsupported.
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
