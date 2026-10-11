/// <reference types="electron-vite/node" />

/** The built-in TokenDance key, injected at build time (electron.vite.config.ts). Empty when not set. */
declare const __SIKEOOP_JEV_KEY__: string;

/** Main-process-only optional free-provider build configuration. */
declare const __SIKEOOP_BUILTIN_FREE_BASE_URL__: string;
declare const __SIKEOOP_BUILTIN_FREE_KEY__: string;

/** Sanitized JSON array, main process only; defaults to "[]". */
declare const __SIKEOOP_BUILTIN_FREE_PROVIDERS__: string;
