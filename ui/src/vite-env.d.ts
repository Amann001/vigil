/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the live system runs (the Hugging Face Space), set when the public replay is built. */
  readonly VITE_LIVE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
