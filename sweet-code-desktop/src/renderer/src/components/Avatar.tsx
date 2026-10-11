import { characterFor } from "../home/characters";

/**
 * A partner's face: her illustration cropped to a circle, or her initial on her color. Providers
 * without a character (custom ones) show `name`'s initial on a color derived from it.
 */
export function Avatar({ providerId, size, name }: { providerId: string; size?: "lg"; name?: string }) {
  const c = characterFor(providerId);
  const fallback = name ?? "?";
  const hue = [...fallback].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0);
  return (
    <span
      className={"avatar" + (size ? ` ${size}` : "")}
      style={c ? (c.art ? undefined : { background: c.accent }) : { background: `hsl(${hue} 55% 55%)` }}
      aria-hidden="true"
    >
      {c?.art ? <img src={c.art} alt="" /> : (c?.name ?? fallback).slice(0, 1)}
    </span>
  );
}
