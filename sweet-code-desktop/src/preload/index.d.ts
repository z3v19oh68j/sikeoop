import type { SweetApi } from "../shared/types";

declare global {
  interface Window {
    sweet: SweetApi;
  }
}

export {};
