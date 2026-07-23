/**
 * Type surface for the build-time docs manifest injected by the
 * `glide-docs-manifest` Vite plugin (see `vite.config.ts`). Consumed by the
 * Admin page's "Dev docs updates" section.
 */
declare module "virtual:glide-docs" {
  export interface GlideDocEntry {
    /** Stable id (repo-relative path). */
    id: string;
    /** Repo-relative path, e.g. "docs/architecture.md". */
    path: string;
    /** First `#` heading, or the filename. */
    title: string;
    /** First readable line of prose, for a one-line blurb. */
    summary: string;
    /** File size in bytes. */
    bytes: number;
    /** Line count. */
    lines: number;
    /** Last-modified time (epoch ms). */
    mtimeMs: number;
    /** Last-modified time (ISO 8601). */
    mtimeISO: string;
    /** Full Markdown source. */
    content: string;
  }

  export interface GlideDocsManifest {
    /** When this manifest was built (ISO 8601). */
    generatedAt: string;
    /** Docs, most recently modified first. */
    docs: GlideDocEntry[];
  }

  export const docsManifest: GlideDocsManifest;
  const _default: GlideDocsManifest;
  export default _default;
}
