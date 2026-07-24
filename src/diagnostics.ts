import type {
  CssDeclaration,
  HtmlDiagnostics,
  HtmlDiagnosticsOptions
} from "./types.js";

export interface HtmlDiagnosticsRecorder {
  recordUnsupportedCss: (declaration: CssDeclaration) => void;
  toJSON: () => HtmlDiagnostics;
}

export function createDiagnostics(
  options: HtmlDiagnosticsOptions | undefined
): HtmlDiagnosticsRecorder | undefined {
  if (!options?.unsupportedCss) return undefined;
  const sampleLimit = options.sampleLimit ?? 3;
  const unsupported = new Map<
    string,
    { property: string; value: string; count: number; samples: string[] }
  >();
  return {
    recordUnsupportedCss(declaration) {
      const property = declaration.property.trim().toLowerCase();
      const value = declaration.value.trim();
      const key = `${property}\n${value}`;
      const entry = unsupported.get(key) ?? {
        property,
        value,
        count: 0,
        samples: []
      };
      entry.count += 1;
      const sample = declaration.selector
        ? `${declaration.selector} { ${property}: ${value} }`
        : `${property}: ${value}`;
      if (entry.samples.length < sampleLimit && !entry.samples.includes(sample)) {
        entry.samples.push(sample);
      }
      unsupported.set(key, entry);
    },
    toJSON() {
      return {
        unsupportedCss: [...unsupported.values()]
          .sort((a, b) => b.count - a.count || a.property.localeCompare(b.property))
          .map(({ property, value, count, samples }) => ({
            property,
            value,
            count,
            samples: samples.length > 0 ? samples : undefined
          }))
      };
    }
  };
}
