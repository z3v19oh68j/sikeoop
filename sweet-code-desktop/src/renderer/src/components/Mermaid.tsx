import { type ReactNode, useEffect, useState } from "react";

// ```mermaid blocks drawn as diagrams. Mermaid is large, so it loads on the first diagram.
// securityLevel "strict" makes it sanitize labels and drop click handlers, so model output
// can't inject markup through the SVG.

let ready: Promise<typeof import("mermaid").default> | null = null;
function load() {
  ready ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "inherit" });
    return mermaid;
  });
  return ready;
}

let counter = 0;

/** The diagram, or `fallback` (the source as a code block) while loading or when it doesn't parse. */
export function MermaidBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Streaming chat re-renders on every delta; wait for the block to settle.
    const timer = setTimeout(() => {
      load()
        .then((m) => m.render(`mmd-${++counter}`, code))
        .then(
          (r) => alive && setSvg(r.svg),
          () => alive && setSvg(null),
        );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code]);
  return svg ? <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} /> : <>{fallback}</>;
}
