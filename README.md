# boxpdf-html

Readable HTML-to-PDF translation built on [`boxpdf`](https://github.com/earonesty/boxpdf).

This package is intended to translate authored/static HTML into boxpdf primitives. It prioritizes readable PDF output and document structure over browser pixel fidelity.

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
