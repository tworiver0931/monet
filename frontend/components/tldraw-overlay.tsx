"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  Tldraw,
  useEditor,
  type Editor,
  type TLAssetStore,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import "tldraw/tldraw.css";

import type { UploadedImageRecord } from "@/lib/websocket";

const PEN_COLOR = "blue";

function TransparentBackground() {
  return null;
}

export type TldrawTool = "select" | "draw" | "eraser" | "text" | "frame";

export type UploadFileFn = (file: File) => Promise<UploadedImageRecord>;

function isShapeWithinFrame(
  editor: Editor,
  shape: Pick<TLShape, "id" | "parentId">,
  frameId: TLShapeId,
): boolean {
  if (shape.id === frameId) {
    return true;
  }

  let parentId = shape.parentId;
  while (typeof parentId === "string") {
    if (parentId === frameId) {
      return true;
    }
    const parent = editor.getShape(parentId as TLShapeId);
    if (!parent) {
      return false;
    }
    parentId = parent.parentId;
  }

  return false;
}

function collectDescendantShapeIds(
  editor: Editor,
  parentId: TLShapeId,
): TLShapeId[] {
  const childIds = editor.getSortedChildIdsForParent(parentId) as TLShapeId[];
  const descendants: TLShapeId[] = [];

  for (const childId of childIds) {
    descendants.push(childId, ...collectDescendantShapeIds(editor, childId));
  }

  return descendants;
}

export function removeFrameWithContents(
  editor: Editor,
  frameId: TLShapeId,
): void {
  const ids = [...collectDescendantShapeIds(editor, frameId), frameId];
  if (ids.length === 0) {
    return;
  }

  editor.run(
    () => {
      editor.deleteShapes(ids);
    },
    { ignoreShapeLock: true },
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function createAssetStore(
  uploadFile?: UploadFileFn,
  onAssetUpload?: (image: UploadedImageRecord) => void,
): TLAssetStore {
  return {
    async upload(_asset, file) {
      // Use base64 data URL for reliable display in tldraw
      const dataUrl = await fileToDataUrl(file);

      // Upload to server in the background for the agent to use in generated code
      if (uploadFile) {
        uploadFile(file)
          .then((image) => {
            onAssetUpload?.(image);
          })
          .catch(() => {
            // Keep the canvas image visible even if background upload fails.
          });
      }

      return { src: dataUrl };
    },
  };
}

export default function TldrawOverlay({
  onMount,
  tool,
  uploadFile,
  onAssetUpload,
  generationFrameId,
  isImageGenerationActive = false,
  onGenerationFrameChange,
  onGenerationFrameCreated,
}: {
  onMount?: (editor: Editor) => void;
  tool?: TldrawTool;
  uploadFile?: UploadFileFn;
  onAssetUpload?: (image: UploadedImageRecord) => void;
  generationFrameId?: TLShapeId | null;
  isImageGenerationActive?: boolean;
  onGenerationFrameChange?: (frameId: TLShapeId | null) => void;
  onGenerationFrameCreated?: (frameId: TLShapeId) => void;
}) {
  const assetStore = useMemo(
    () => createAssetStore(uploadFile, onAssetUpload),
    [uploadFile, onAssetUpload],
  );

  return (
    <div
      className={`tldraw-overlay ${isImageGenerationActive ? "tldraw-overlay--image-generation-active" : ""}`}
      style={{ width: "100%", height: "100%" }}
    >
      <style>{`
        .tldraw-overlay .tl-image-container {
          box-shadow: inset 0 0 0 2px rgba(59, 130, 246, 0.5);
        }

        .tldraw-overlay--image-generation-active .tl-frame__body,
        .tldraw-overlay--image-generation-active .tl-frame-heading,
        .tldraw-overlay--image-generation-active .tl-selection__fg,
        .tldraw-overlay--image-generation-active .tl-user-handles {
          opacity: 0;
        }
      `}</style>
      <Tldraw
        licenseKey={process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY}
        hideUi
        assets={assetStore}
        components={{ Background: TransparentBackground }}
        onMount={(editor) => {
          // Lock camera to prevent zooming and dragging/panning
          editor.setCameraOptions({
            isLocked: true,
          });
          if (tool) {
            editor.setCurrentTool(tool);
          }
          onMount?.(editor);
        }}
      >
        <ToolSwitcher tool={tool} />
        <GenerationFrameController
          generationFrameId={generationFrameId ?? null}
          isImageGenerationActive={isImageGenerationActive}
          onGenerationFrameChange={onGenerationFrameChange}
          onGenerationFrameCreated={onGenerationFrameCreated}
        />
      </Tldraw>
    </div>
  );
}

function ToolSwitcher({ tool }: { tool?: TldrawTool }) {
  const editor = useEditor();
  useEffect(() => {
    if (tool) {
      editor.setCurrentTool(tool);
    }
  }, [editor, tool]);
  return null;
}

function GenerationFrameController({
  generationFrameId,
  isImageGenerationActive,
  onGenerationFrameChange,
  onGenerationFrameCreated,
}: {
  generationFrameId: TLShapeId | null;
  isImageGenerationActive: boolean;
  onGenerationFrameChange?: (frameId: TLShapeId | null) => void;
  onGenerationFrameCreated?: (frameId: TLShapeId) => void;
}) {
  const editor = useEditor();
  const generationFrameIdRef = useRef<TLShapeId | null>(generationFrameId);
  const isImageGenerationActiveRef = useRef(isImageGenerationActive);

  useEffect(() => {
    generationFrameIdRef.current = generationFrameId;
  }, [generationFrameId]);

  useEffect(() => {
    isImageGenerationActiveRef.current = isImageGenerationActive;
  }, [isImageGenerationActive]);

  useEffect(() => {
    const frames = editor
      .getCurrentPageShapes()
      .filter((shape) => shape.type === "frame");

    if (frames.length === 0) {
      if (generationFrameIdRef.current !== null) {
        generationFrameIdRef.current = null;
        onGenerationFrameChange?.(null);
      }
      return;
    }

    const existingFrameId =
      generationFrameIdRef.current &&
      frames.some((shape) => shape.id === generationFrameIdRef.current)
        ? generationFrameIdRef.current
        : ((frames[frames.length - 1]?.id as TLShapeId | undefined) ?? null);

    if (existingFrameId !== generationFrameIdRef.current) {
      generationFrameIdRef.current = existingFrameId;
      onGenerationFrameChange?.(existingFrameId);
    }

    for (const frame of frames) {
      if (frame.id !== existingFrameId) {
        removeFrameWithContents(editor, frame.id as TLShapeId);
      }
    }
  }, [editor, onGenerationFrameChange]);

  useEffect(() => {
    const cleanupColor = editor.sideEffects.registerBeforeCreateHandler(
      "shape",
      (shape) => {
        if (shape.type === "draw") {
          return { ...shape, props: { ...shape.props, color: PEN_COLOR } };
        }
        if (shape.type === "frame") {
          return {
            ...shape,
            props: { ...shape.props, name: "Create image" },
          };
        }
        return shape;
      },
    );

    const cleanupBeforeChange = editor.sideEffects.registerBeforeChangeHandler(
      "shape",
      (prev, next) => {
        const frameId = generationFrameIdRef.current;
        if (!isImageGenerationActiveRef.current || !frameId) {
          return next;
        }

        const isManagedShape =
          prev.id === frameId ||
          next.id === frameId ||
          isShapeWithinFrame(editor, prev, frameId) ||
          isShapeWithinFrame(editor, next, frameId);

        if (!isManagedShape) {
          return next;
        }

        if (prev.id === frameId && next.id === frameId) {
          const isMoveOnlyChange =
            prev.parentId === next.parentId &&
            prev.index === next.index &&
            prev.rotation === next.rotation &&
            prev.opacity === next.opacity &&
            prev.isLocked === next.isLocked &&
            JSON.stringify(prev.props) === JSON.stringify(next.props) &&
            JSON.stringify(prev.meta) === JSON.stringify(next.meta);

          return isMoveOnlyChange ? next : prev;
        }

        return prev;
      },
    );

    const cleanupBeforeDelete = editor.sideEffects.registerBeforeDeleteHandler(
      "shape",
      (shape) => {
        const frameId = generationFrameIdRef.current;
        if (!isImageGenerationActiveRef.current || !frameId) {
          return;
        }

        if (isShapeWithinFrame(editor, shape, frameId)) {
          return false;
        }
      },
    );

    const cleanupAfterCreate = editor.sideEffects.registerAfterCreateHandler(
      "shape",
      (shape) => {
        const frameId = generationFrameIdRef.current;

        if (shape.type === "frame") {
          if (isImageGenerationActiveRef.current) {
            editor.run(
              () => {
                editor.deleteShapes([shape.id]);
              },
              { ignoreShapeLock: true },
            );
            return;
          }

          generationFrameIdRef.current = shape.id as TLShapeId;
          onGenerationFrameChange?.(shape.id as TLShapeId);

          if (frameId && frameId !== shape.id) {
            removeFrameWithContents(editor, frameId);
          }

          onGenerationFrameCreated?.(shape.id as TLShapeId);
          return;
        }

        if (
          isImageGenerationActiveRef.current &&
          frameId &&
          isShapeWithinFrame(editor, shape, frameId)
        ) {
          editor.run(
            () => {
              editor.deleteShapes([shape.id]);
            },
            { ignoreShapeLock: true },
          );
        }
      },
    );

    const cleanupAfterDelete = editor.sideEffects.registerAfterDeleteHandler(
      "shape",
      (shape) => {
        if (shape.id !== generationFrameIdRef.current) {
          return;
        }

        generationFrameIdRef.current = null;
        onGenerationFrameChange?.(null);
      },
    );

    return () => {
      cleanupColor();
      cleanupBeforeChange();
      cleanupBeforeDelete();
      cleanupAfterCreate();
      cleanupAfterDelete();
    };
  }, [editor, onGenerationFrameChange, onGenerationFrameCreated]);

  return null;
}
