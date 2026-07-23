import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root (this config lives at the root next to index.html).
const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Build-time "dev docs" manifest.
 *
 * Scans the project's Markdown docs (root README + the fix-progress log +
 * everything under `docs/`) and exposes them to the client as a virtual module
 * `virtual:glide-docs`. The Admin page (`/admin`) renders this as a
 * documentation-update tracker: title, last-modified time, size, and an inline
 * viewer. Content is embedded at build time, so there is no runtime filesystem
 * or network access — a fresh `npm run build` refreshes the snapshot.
 */
interface DocEntry {
  id: string;
  path: string;
  title: string;
  summary: string;
  bytes: number;
  lines: number;
  mtimeMs: number;
  mtimeISO: string;
  content: string;
}

function firstHeading(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return (m?.[1] ?? fallback).trim();
}

function firstSummary(md: string): string {
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith(">") ||
      line.startsWith("|") ||
      line.startsWith("```") ||
      line.startsWith("---")
    ) {
      continue;
    }
    // Strip the most common inline markdown so the blurb reads cleanly.
    return line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").slice(0, 240);
  }
  return "";
}

function collectDocs(): { generatedAt: string; docs: DocEntry[] } {
  const files: string[] = [];
  for (const name of ["README.md", "GLIDE_FIX_PROGRESS.md"]) {
    const p = join(ROOT, name);
    if (existsSync(p)) files.push(p);
  }
  const docsDir = join(ROOT, "docs");
  if (existsSync(docsDir)) {
    for (const name of readdirSync(docsDir)) {
      if (name.toLowerCase().endsWith(".md")) files.push(join(docsDir, name));
    }
  }

  const docs: DocEntry[] = files.map((abs) => {
    const content = readFileSync(abs, "utf8");
    const st = statSync(abs);
    const rel = relative(ROOT, abs).split("\\").join("/");
    return {
      id: rel,
      path: rel,
      title: firstHeading(content, basename(abs)),
      summary: firstSummary(content),
      bytes: st.size,
      lines: content.split(/\r?\n/).length,
      mtimeMs: st.mtimeMs,
      mtimeISO: new Date(st.mtimeMs).toISOString(),
      content,
    };
  });

  // Most recently modified first — this is the "what changed" tracker.
  docs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { generatedAt: new Date().toISOString(), docs };
}

function glideDocsPlugin(): Plugin {
  const virtualId = "virtual:glide-docs";
  const resolvedId = "\0" + virtualId;
  return {
    name: "glide-docs-manifest",
    resolveId(id) {
      if (id === virtualId) return resolvedId;
      return null;
    },
    load(id) {
      if (id !== resolvedId) return null;
      const data = collectDocs();
      return `export const docsManifest = ${JSON.stringify(data)};\nexport default docsManifest;`;
    },
  };
}

// Glide's React chat UI is built to ./dist/client and served by the Worker
// via the ASSETS binding (configured in wrangler.jsonc).
export default defineConfig(({ mode }) => ({
  plugins: [react(), glideDocsPlugin()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    // Diagnostic: `--mode development` produces an unminified bundle so React's
    // dev build prints full error messages + readable component stacks.
    // Normal production builds stay minified.
    minify: mode === "development" ? false : "esbuild",
  },
}));
