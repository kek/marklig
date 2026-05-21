export type Format = "markdown" | "typst";

const MARKDOWN_EXTS = ["md", "markdown", "mdx", "mdown"] as const;
const TYPST_EXTS = ["typ"] as const;
const ALL_EXTS = [...MARKDOWN_EXTS, ...TYPST_EXTS];

function extOf(path: string | null): string | null {
  if (!path) return null;
  const i = path.lastIndexOf(".");
  if (i < 0) return null;
  return path.slice(i + 1).toLowerCase();
}

export function detectFormat(path: string | null): Format {
  const ext = extOf(path);
  if (ext && (TYPST_EXTS as readonly string[]).includes(ext)) return "typst";
  return "markdown";
}

export function isSupportedExtension(path: string): boolean {
  const ext = extOf(path);
  if (!ext) return false;
  return (ALL_EXTS as readonly string[]).includes(ext);
}

export function supportedExtensions(): string[] {
  return [...ALL_EXTS];
}

export function markdownExtensions(): string[] {
  return [...MARKDOWN_EXTS];
}

export function typstExtensions(): string[] {
  return [...TYPST_EXTS];
}
