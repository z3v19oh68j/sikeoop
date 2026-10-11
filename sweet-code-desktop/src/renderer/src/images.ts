import type { ImageInput } from "@shared/types";

/** Longest side sent to the vision model; larger images cost more and don't read better. */
const MAX_SIDE = 1568;
const THUMB_SIDE = 240;
/** Above this, PNG is re-encoded as JPEG. Small screenshots stay PNG so text stays sharp. */
const PNG_BUDGET = 1.5 * 1024 * 1024;

export interface Attachment {
  id: string;
  name: string;
  image: ImageInput;
  /** Small JPEG data URL for the composer, the chat bubble and the saved conversation. */
  thumb: string;
}

/** Resize a picked, pasted or dropped image for sending. */
export async function prepareImage(file: Blob, name = "图片"): Promise<Attachment> {
  if (!file.type.startsWith("image/")) throw new Error(`${name} 不是图片`);
  const img = await load(file);
  const full = draw(img, MAX_SIDE);
  let url = full.toDataURL("image/png");
  if (url.length * 0.75 > PNG_BUDGET) url = full.toDataURL("image/jpeg", 0.9);
  const [, mime, data] = url.match(/^data:([^;]+);base64,(.*)$/)!;
  return {
    id: crypto.randomUUID(),
    name,
    image: { mime, data },
    thumb: draw(img, THUMB_SIDE).toDataURL("image/jpeg", 0.8),
  };
}

function load(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读不了这张图片"));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("这张图片的格式不支持"));
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function draw(img: HTMLImageElement, maxSide: number): HTMLCanvasElement {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
