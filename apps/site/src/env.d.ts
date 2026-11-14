/// <reference types="astro/client" />

/** Absolute path of docs/prd/done, set in astro.config.mjs. */
declare const __SPECS_DIR__: string;

interface ImportMetaEnv {
  readonly PUBLIC_WAITLIST_ACTION?: string;
}
