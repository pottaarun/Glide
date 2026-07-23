/**
 * Augment the generated binding types with the CF_API_TOKEN secret.
 * Secrets are not declared in wrangler.jsonc, so `wrangler types` does not
 * know about them — we merge it into the generated `Cloudflare.Env` here.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      /** Cloudflare API token Glide uses to drive the Cloudflare API (optional fallback; can also be set in the GUI). */
      CF_API_TOKEN: string;
      /**
       * 32-byte (base64) key used to derive the AES-256-GCM key that encrypts
       * GUI-provided API tokens at rest in the Durable Object. Set with
       * `wrangler secret put GLIDE_TOKEN_KEY`. When absent, GUI token storage is disabled.
       */
      GLIDE_TOKEN_KEY?: string;
      /**
       * Base URL of the Switchflare / migration tool Worker (e.g.
       * "https://switchflare.example.workers.dev" or "http://localhost:8788").
       * Used as a FALLBACK when the `MIGRATION` service binding isn't present.
       * Glide calls its READ-ONLY endpoints (`/api/providers`, `/api/preview-rules`,
       * `/api/generate-terraform`) to inspect a team's existing provider config when
       * migrating to Cloudflare. Set via `.dev.vars` locally or
       * `wrangler secret put MIGRATION_API_URL` in production.
       */
      MIGRATION_API_URL?: string;
      /**
       * Service binding to the Switchflare / migration tool Worker. PREFERRED over
       * MIGRATION_API_URL: it invokes the Worker directly inside the runtime, so it
       * works even when the migration tool's public hostname is protected by
       * Cloudflare Access (no public request, no Access challenge). Configured via
       * the `services` binding in `wrangler.jsonc`.
       */
      MIGRATION?: Fetcher;
    }
  }
}

export {};
