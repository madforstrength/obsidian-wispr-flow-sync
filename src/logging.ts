/** A log sink. Kept as a bare function type so core modules never depend on
 *  Obsidian or the filesystem — the plugin injects a real sink, tests inject
 *  an array push, and production defaults to doing nothing. */
export type Logger = (message: string) => void;

export const NULL_LOGGER: Logger = () => {
  /* intentionally does nothing */
};

/** Wrap a sink so every message carries a scope prefix, and so a throwing
 *  sink can never break the code that was merely trying to log. */
export function withPrefix(scope: string, sink: Logger): Logger {
  return (message: string) => {
    try {
      sink(`[${scope}] ${message}`);
    } catch {
      /* logging must never be load-bearing */
    }
  };
}
