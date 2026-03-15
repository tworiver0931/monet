"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import opentype from "opentype.js";

// Module-level font cache to avoid reloading on every render
let _cachedFont: opentype.Font | null = null;
let _fontLoadPromise: Promise<opentype.Font | null> | null = null;
const _loadedImages = new Set<string>();
const _imageLoadPromises = new Map<string, Promise<void>>();

async function getCachedFont(): Promise<opentype.Font | null> {
  if (_cachedFont) return _cachedFont;
  if (_fontLoadPromise) return _fontLoadPromise;

  _fontLoadPromise = (async () => {
    const fontPaths = [
      "/LastoriaBoldRegular.otf",
      "./LastoriaBoldRegular.otf",
      `${window.location.origin}/LastoriaBoldRegular.otf`,
    ];
    for (const path of fontPaths) {
      try {
        _cachedFont = await opentype.load(path);
        return _cachedFont;
      } catch {
        // Try next path
      }
    }
    return null;
  })();

  return _fontLoadPromise;
}

async function ensureImageLoaded(src: string): Promise<void> {
  if (_loadedImages.has(src)) {
    return;
  }

  const existingPromise = _imageLoadPromises.get(src);
  if (existingPromise) {
    return existingPromise;
  }

  const loadPromise = new Promise<void>((resolve, reject) => {
    const image = new window.Image();

    image.onload = () => {
      _loadedImages.add(src);
      resolve();
    };
    image.onerror = () => {
      reject(new Error(`Failed to load image: ${src}`));
    };
    image.src = src;

    if (image.complete) {
      _loadedImages.add(src);
      resolve();
      return;
    }

    if (typeof image.decode === "function") {
      void image.decode().then(
        () => {
          _loadedImages.add(src);
          resolve();
        },
        () => {
          // Keep the onload fallback above for browsers where decode fails.
        },
      );
    }
  }).finally(() => {
    _imageLoadPromises.delete(src);
  });

  _imageLoadPromises.set(src, loadPromise);
  return loadPromise;
}

interface SignatureProps {
  text?: string;
  color?: string;
  imageUrl?: string;
  fontSize?: number;
  duration?: number;
  delay?: number;
  className?: string;
  inView?: boolean;
  once?: boolean;
}

export function Signature({
  text = "Signature",
  color = "#000",
  imageUrl,
  fontSize = 14,
  duration = 1.5,
  delay = 0,
  className,
  inView = false,
  once = true,
}: SignatureProps) {
  const [paths, setPaths] = useState<string[]>([]);
  const [viewBox, setViewBox] = useState("0 0 300 100");
  const [svgWidth, setSvgWidth] = useState(300);
  const [svgHeight, setSvgHeight] = useState(100);
  const [isAssetReady, setIsAssetReady] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [patternOffset, setPatternOffset] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ w: 1920, h: 1080 });
  const uniqueId = useId().replace(/:/g, "");
  const maskId = `signature-reveal-${uniqueId}`;
  const patternId = `signature-pattern-${uniqueId}`;
  const fillColor = imageUrl ? `url(#${patternId})` : color;
  const isReady = paths.length > 0 && isAssetReady;

  const updatePatternPosition = useCallback(() => {
    if (!svgRef.current || !imageUrl) return;
    const rect = svgRef.current.getBoundingClientRect();
    setPatternOffset({ x: -rect.left, y: -rect.top });
    setViewportSize({ w: window.innerWidth, h: window.innerHeight });
  }, [imageUrl]);

  useEffect(() => {
    if (!imageUrl) return;
    // Recalculate after mount/remount (paths.length change causes key change)
    requestAnimationFrame(updatePatternPosition);
    let rafId: number | null = null;
    const debouncedUpdate = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updatePatternPosition);
    };
    window.addEventListener("resize", debouncedUpdate);
    window.addEventListener("scroll", debouncedUpdate, { passive: true });
    return () => {
      window.removeEventListener("resize", debouncedUpdate);
      window.removeEventListener("scroll", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [imageUrl, updatePatternPosition, paths]);

  useEffect(() => {
    async function load() {
      setIsAssetReady(false);

      try {
        const [font] = await Promise.all([
          getCachedFont(),
          imageUrl ? ensureImageLoaded(imageUrl) : Promise.resolve(),
        ]);

        if (!font) {
          throw new Error("Font could not be loaded from any path");
        }

        const scale = fontSize / font.unitsPerEm;
        const ascender = font.ascender * scale;
        const padding = fontSize * 0.15;
        const baseline = padding + ascender;

        let x = padding;
        const newPaths: string[] = [];
        let maxX = 0;
        let minY = Infinity;
        let maxY = -Infinity;

        for (const char of text) {
          const glyph = font.charToGlyph(char);
          const path = glyph.getPath(x, baseline, fontSize);
          const bbox = path.getBoundingBox();
          if (bbox.x2 > maxX) maxX = bbox.x2;
          if (bbox.y1 < minY) minY = bbox.y1;
          if (bbox.y2 > maxY) maxY = bbox.y2;
          newPaths.push(path.toPathData(3));

          const advanceWidth = glyph.advanceWidth ?? font.unitsPerEm;
          x += advanceWidth * scale;
        }

        const totalWidth = Math.max(x, maxX) + padding;
        const actualMinY = Math.min(minY, padding);
        const actualMaxY = Math.max(maxY, baseline);
        const totalHeight = actualMaxY - actualMinY + padding * 2;

        setPaths(newPaths);
        setSvgWidth(totalWidth);
        setSvgHeight(totalHeight);
        setViewBox(`0 0 ${totalWidth} ${totalHeight}`);
        setIsAssetReady(true);
      } catch {
        setPaths([]);
        setSvgWidth(text.length * fontSize * 0.6);
        setSvgHeight(fontSize * 2);
        setViewBox(`0 0 ${text.length * fontSize * 0.6} ${fontSize * 2}`);
        setIsAssetReady(true);
      }
    }

    load();
  }, [fontSize, imageUrl, text]);

  const variants = {
    hidden: { pathLength: 0, opacity: 0 },
    visible: { pathLength: 1, opacity: 1 },
  };

  if (!isReady) {
    return (
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={viewBox}
        fill="none"
        className={className}
        aria-hidden="true"
        style={{ visibility: "hidden" }}
      />
    );
  }

  return (
    <motion.svg
      ref={svgRef}
      key={`${text}-${fontSize}-${imageUrl ?? "solid"}`}
      width={svgWidth}
      height={svgHeight}
      viewBox={viewBox}
      fill="none"
      className={className}
      initial="hidden"
      whileInView={inView ? "visible" : undefined}
      animate={inView ? undefined : "visible"}
      viewport={{ once }}
      onAnimationStart={updatePatternPosition}
    >
      <defs>
        {imageUrl && (
          <pattern
            id={patternId}
            patternUnits="userSpaceOnUse"
            x={patternOffset.x}
            y={patternOffset.y}
            width={viewportSize.w}
            height={viewportSize.h}
          >
            <image
              href={imageUrl}
              x={0}
              y={0}
              width={viewportSize.w}
              height={viewportSize.h}
              preserveAspectRatio="xMidYMid slice"
            />
          </pattern>
        )}
        <mask id={maskId} maskUnits="userSpaceOnUse">
          {paths.map((d, i) => (
            <motion.path
              key={i}
              d={d}
              stroke="white"
              strokeWidth={fontSize * 0.22}
              fill="none"
              variants={variants}
              transition={{
                pathLength: {
                  delay: delay + i * 0.2,
                  duration,
                  ease: "easeInOut",
                },
                opacity: {
                  delay: delay + i * 0.2 + 0.01,
                  duration: 0.01,
                },
              }}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </mask>
      </defs>

      {paths.map((d, i) => (
        <motion.path
          key={i}
          d={d}
          stroke={fillColor}
          strokeWidth={2}
          fill="none"
          variants={variants}
          transition={{
            pathLength: {
              delay: delay + i * 0.2,
              duration,
              ease: "easeInOut",
            },
            opacity: {
              delay: delay + i * 0.2 + 0.01,
              duration: 0.01,
            },
          }}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="butt"
          strokeLinejoin="round"
        />
      ))}

      <g mask={`url(#${maskId})`}>
        {paths.map((d, i) => (
          <path key={i} d={d} fill={fillColor} />
        ))}
      </g>
    </motion.svg>
  );
}
