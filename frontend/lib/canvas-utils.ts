import type { Editor, TLShapeId } from "tldraw";

const FRAME_CAPTURE_INSET_PX = 0;

export const MAX_PREVIEW_CAPTURE_DIM = 768;
export const MAX_GENERATION_FRAME_DIM = 1024;

export function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const clone = document.createElement("canvas");
  clone.width = source.width;
  clone.height = source.height;
  clone.getContext("2d")?.drawImage(source, 0, 0);
  return clone;
}

export function resizeCanvasToMaxDimension(
  source: HTMLCanvasElement,
  maxDim: number,
): HTMLCanvasElement {
  if (source.width <= maxDim && source.height <= maxDim) {
    return source;
  }

  const scale = Math.min(maxDim / source.width, maxDim / source.height);
  const resized = document.createElement("canvas");
  resized.width = Math.max(1, Math.round(source.width * scale));
  resized.height = Math.max(1, Math.round(source.height * scale));
  resized
    .getContext("2d")
    ?.drawImage(source, 0, 0, resized.width, resized.height);
  return resized;
}

export function cropCanvas(
  source: HTMLCanvasElement,
  rect: { x: number; y: number; width: number; height: number },
): HTMLCanvasElement {
  const cropped = document.createElement("canvas");
  cropped.width = rect.width;
  cropped.height = rect.height;
  cropped
    .getContext("2d")
    ?.drawImage(
      source,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );
  return cropped;
}

export function getFrameCaptureRect(
  editor: Editor,
  frameId: TLShapeId,
  container: HTMLDivElement,
  canvas: HTMLCanvasElement,
): { x: number; y: number; width: number; height: number } | null {
  const bounds = editor.getShapePageBounds(frameId);
  if (!bounds || container.clientWidth === 0 || container.clientHeight === 0) {
    return null;
  }

  const topLeft = editor.pageToViewport({ x: bounds.x, y: bounds.y });
  const bottomRight = editor.pageToViewport({
    x: bounds.x + bounds.w,
    y: bounds.y + bounds.h,
  });

  const sx = canvas.width / container.clientWidth;
  const sy = canvas.height / container.clientHeight;
  const insetX = FRAME_CAPTURE_INSET_PX * sx;
  const insetY = FRAME_CAPTURE_INSET_PX * sy;
  const left = Math.min(topLeft.x, bottomRight.x) * sx + insetX;
  const top = Math.min(topLeft.y, bottomRight.y) * sy + insetY;
  const right = Math.max(topLeft.x, bottomRight.x) * sx - insetX;
  const bottom = Math.max(topLeft.y, bottomRight.y) * sy - insetY;
  const x = Math.max(0, Math.floor(left));
  const y = Math.max(0, Math.floor(top));
  const width = Math.min(
    canvas.width - x,
    Math.max(1, Math.ceil(right - left)),
  );
  const height = Math.min(
    canvas.height - y,
    Math.max(1, Math.ceil(bottom - top)),
  );

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { x, y, width, height };
}

export type FrameViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function getFrameViewportRect(
  editor: Editor,
  frameId: TLShapeId,
): FrameViewportRect | null {
  const bounds = editor.getShapePageBounds(frameId);
  if (!bounds) {
    return null;
  }

  const topLeft = editor.pageToViewport({ x: bounds.x, y: bounds.y });
  const bottomRight = editor.pageToViewport({
    x: bounds.x + bounds.w,
    y: bounds.y + bounds.h,
  });
  const left = Math.floor(Math.min(topLeft.x, bottomRight.x));
  const top = Math.floor(Math.min(topLeft.y, bottomRight.y));
  const right = Math.ceil(Math.max(topLeft.x, bottomRight.x));
  const bottom = Math.ceil(Math.max(topLeft.y, bottomRight.y));

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export async function loadImageDimensions(src: string): Promise<{
  width: number;
  height: number;
}> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return {
    width: image.naturalWidth || image.width || 1,
    height: image.naturalHeight || image.height || 1,
  };
}
