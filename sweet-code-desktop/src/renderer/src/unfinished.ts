// Features whose main-process side isn't finished yet: shown while developing, hidden in packaged builds.
// Regression console and deep research (not yet run for real), one-click publish (hosting not deployed yet).
export const SHOW_UNFINISHED = import.meta.env.DEV;
