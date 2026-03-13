"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const LEADING_EDGE_LENGTH = 7;
const REVEAL_DURATION_MS = 2500;
const EASE_X1 = 0.25;
const EASE_Y1 = 0.1;
const EASE_X2 = 0.25;
const EASE_Y2 = 1;

type HomeScreenTransitionPhase = "idle" | "holding" | "revealing";
type ViewportSize = { width: number; height: number };
type Point = { x: number; y: number };

type HomeScreenTransitionState = {
  id: number;
  phase: HomeScreenTransitionPhase;
  backgroundImageSrc: string | null;
};

type HomeScreenTransitionContextValue = {
  phase: HomeScreenTransitionPhase;
  beginHomeTransition: (backgroundImageSrc: string) => void;
  revealHomeTransition: () => void;
  cancelHomeTransition: () => void;
};

export const HomeScreenTransitionContext =
  createContext<HomeScreenTransitionContextValue | null>(null);

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function createPolylinePath(points: Point[]) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function getWindowedProgress(progress: number, start: number, end: number) {
  if (progress <= start) {
    return 0;
  }

  if (progress >= end) {
    return 1;
  }

  return (progress - start) / (end - start);
}

function getWindowedReveal(progress: number, start: number, end: number) {
  return getWindowedProgress(progress, start, end) * 100;
}

function getBezierCoordinate(t: number, p1: number, p2: number) {
  const inverseT = 1 - t;

  return (
    3 * inverseT * inverseT * t * p1 + 3 * inverseT * t * t * p2 + t * t * t
  );
}

function getBezierDerivative(t: number, p1: number, p2: number) {
  const inverseT = 1 - t;

  return (
    3 * inverseT * inverseT * p1 +
    6 * inverseT * t * (p2 - p1) +
    3 * t * t * (1 - p2)
  );
}

function applyEase(progress: number) {
  if (progress <= 0 || progress >= 1) {
    return progress;
  }

  let t = progress;

  for (let i = 0; i < 5; i += 1) {
    const currentX = getBezierCoordinate(t, EASE_X1, EASE_X2);
    const derivative = getBezierDerivative(t, EASE_X1, EASE_X2);

    if (Math.abs(derivative) < 1e-6) {
      break;
    }

    t -= (currentX - progress) / derivative;
    t = clamp(t, 0, 1);
  }

  return getBezierCoordinate(t, EASE_Y1, EASE_Y2);
}

function useViewportSize() {
  const [viewport, setViewport] = useState<ViewportSize>(() => {
    if (typeof window === "undefined") {
      return {
        width: 1440,
        height: 900,
      };
    }

    return {
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });

  useEffect(() => {
    const updateViewport = () => {
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    updateViewport();
    window.addEventListener("resize", updateViewport);

    return () => {
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  return viewport;
}

function createBrushGeometry(viewport: ViewportSize) {
  const leadingEdgeWidth = clamp(
    Math.min(viewport.width, viewport.height) * 0.16,
    92,
    188,
  );
  const eraseWidth = clamp(
    Math.max(leadingEdgeWidth * 2.8, viewport.height * 0.42),
    320,
    620,
  );
  const edgeOverflow = eraseWidth * 0.55;
  const points: Point[] = [
    { x: -edgeOverflow * 0.45, y: -edgeOverflow * 0.4 },
    { x: viewport.width * 0.055, y: viewport.height * 0.045 },
    { x: -edgeOverflow * 0.08, y: viewport.height * 0.35 },
    { x: viewport.width * 0.23, y: viewport.height * 0.04 },
    { x: viewport.width * 0.05, y: viewport.height * 0.64 },
    { x: viewport.width * 0.52, y: viewport.height * 0.03 },
    { x: viewport.width * 0.21, y: viewport.height * 0.91 },
    { x: viewport.width * 0.8, y: viewport.height * 0.16 },
    { x: viewport.width * 0.54, y: viewport.height * 0.91 },
    { x: viewport.width + edgeOverflow * 0.1, y: viewport.height * 0.34 },
    { x: viewport.width * 0.81, y: viewport.height * 0.86 },
    { x: viewport.width * 0.82, y: viewport.height * 0.73 },
    { x: viewport.width * 0.8, y: viewport.height * 0.91 },
    { x: viewport.width * 0.89, y: viewport.height * 0.84 },
    {
      x: viewport.width + edgeOverflow * 0.85,
      y: viewport.height + edgeOverflow * 0.35,
    },
  ];

  const bottomLeftCornerPath = createPolylinePath([
    { x: viewport.width * 0.21, y: viewport.height * 0.91 },
    { x: viewport.width * 0.12, y: viewport.height * 0.82 },
    { x: viewport.width * 0.03, y: viewport.height * 0.96 },
    { x: -edgeOverflow * 0.42, y: viewport.height + edgeOverflow * 0.3 },
  ]);
  const bottomLeftPocketFillPath = `
    M ${viewport.width * 0.1} ${viewport.height * 0.78}
    C ${viewport.width * 0.17} ${viewport.height * 0.69},
      ${viewport.width * 0.31} ${viewport.height * 0.685},
      ${viewport.width * 0.41} ${viewport.height * 0.77}
    C ${viewport.width * 0.49} ${viewport.height * 0.84},
      ${viewport.width * 0.5} ${viewport.height * 0.95},
      ${viewport.width * 0.43} ${viewport.height + edgeOverflow * 0.09}
    C ${viewport.width * 0.34} ${viewport.height + edgeOverflow * 0.16},
      ${viewport.width * 0.18} ${viewport.height + edgeOverflow * 0.13},
      ${viewport.width * 0.11} ${viewport.height * 0.96}
    C ${viewport.width * 0.07} ${viewport.height * 0.9},
      ${viewport.width * 0.065} ${viewport.height * 0.83},
      ${viewport.width * 0.1} ${viewport.height * 0.78}
    Z
  `;
  const topRightCornerPath = createPolylinePath([
    { x: viewport.width * 0.8, y: viewport.height * 0.16 },
    { x: viewport.width * 0.9, y: viewport.height * 0.24 },
    { x: viewport.width * 0.985, y: viewport.height * 0.08 },
    { x: viewport.width + edgeOverflow * 0.48, y: -edgeOverflow * 0.32 },
  ]);

  return {
    eraseWidth,
    leadingEdgeWidth,
    bottomLeftCornerPath,
    bottomLeftPocketFillPath,
    path: createPolylinePath(points),
    topRightCornerPath,
  };
}

function HomeScreenTransitionOverlay({
  transitionId,
  phase,
  backgroundImageSrc,
  onRevealFinished,
}: {
  transitionId: number;
  phase: HomeScreenTransitionPhase;
  backgroundImageSrc: string | null;
  onRevealFinished: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const viewport = useViewportSize();
  const {
    eraseWidth,
    leadingEdgeWidth,
    path: brushPath,
    bottomLeftCornerPath,
    bottomLeftPocketFillPath,
    topRightCornerPath,
  } = useMemo(() => createBrushGeometry(viewport), [viewport]);
  const maskId = `home-screen-transition-mask-${transitionId}`;

  useEffect(() => {
    if (phase === "idle") {
      setProgress(0);
      return;
    }

    if (phase !== "revealing") {
      setProgress(0);
      return;
    }

    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setProgress(1);
      onRevealFinished();
      return;
    }

    let frameId = 0;
    let finishTimeout: number | undefined;
    const startTime = performance.now();

    const animate = (now: number) => {
      const rawProgress = Math.min((now - startTime) / REVEAL_DURATION_MS, 1);
      setProgress(applyEase(rawProgress));

      if (rawProgress < 1) {
        frameId = window.requestAnimationFrame(animate);
        return;
      }

      finishTimeout = window.setTimeout(onRevealFinished, 60);
    };

    frameId = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(frameId);
      if (finishTimeout !== undefined) {
        window.clearTimeout(finishTimeout);
      }
    };
  }, [onRevealFinished, phase, transitionId]);

  if (!backgroundImageSrc || phase === "idle") {
    return null;
  }

  const revealLength = progress * 100;
  const leadingEdgeStart = Math.max(revealLength - LEADING_EDGE_LENGTH, 0);
  const leadingEdgeVisibleLength = Math.min(revealLength, LEADING_EDGE_LENGTH);
  const bottomLeftRevealLength = getWindowedReveal(progress, 0.34, 0.54);
  const topRightRevealLength = getWindowedReveal(progress, 0.56, 0.76);
  const bottomLeftPocketProgress = applyEase(
    getWindowedProgress(progress, 0.3, 0.56),
  );
  const topRightPocketProgress = applyEase(
    getWindowedProgress(progress, 0.56, 0.78),
  );
  const bottomLeftPocketCenterX = viewport.width * 0.275;
  const bottomLeftPocketCenterY = viewport.height * 0.91;
  const topRightPocketCenterX = viewport.width * 0.675;
  const topRightPocketCenterY = viewport.height * 0.12;
  const isHolding = phase === "holding";

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[60] overflow-hidden"
    >
      {isHolding ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={backgroundImageSrc}
          alt=""
          decoding="sync"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}

      <svg
        className={`h-full w-full ${isHolding ? "opacity-0" : "opacity-100"}`}
        role="presentation"
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      >
        <defs>
          <mask
            id={maskId}
            height={viewport.height}
            maskUnits="userSpaceOnUse"
            width={viewport.width}
            x="0"
            y="0"
          >
            <rect
              fill="white"
              height={viewport.height}
              width={viewport.width}
              x="0"
              y="0"
            />
            <path
              d={brushPath}
              fill="none"
              pathLength={100}
              stroke="black"
              strokeDasharray={`${revealLength} 100`}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={eraseWidth}
            />
            {bottomLeftRevealLength > 0 ? (
              <path
                d={bottomLeftCornerPath}
                fill="none"
                pathLength={100}
                stroke="black"
                strokeDasharray={`${bottomLeftRevealLength} 100`}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={eraseWidth * 1.05}
              />
            ) : null}
            {bottomLeftPocketProgress > 0 ? (
              <path
                d={bottomLeftPocketFillPath}
                fill="black"
                opacity={bottomLeftPocketProgress}
              />
            ) : null}
            {topRightRevealLength > 0 ? (
              <path
                d={topRightCornerPath}
                fill="none"
                pathLength={100}
                stroke="black"
                strokeDasharray={`${topRightRevealLength} 100`}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={eraseWidth * 1.05}
              />
            ) : null}
            {bottomLeftPocketProgress > 0 ? (
              <ellipse
                cx={bottomLeftPocketCenterX}
                cy={bottomLeftPocketCenterY}
                fill="black"
                rx={Math.max(eraseWidth * 0.44 * bottomLeftPocketProgress, 1)}
                ry={Math.max(eraseWidth * 0.6 * bottomLeftPocketProgress, 1)}
                transform={`rotate(-30 ${bottomLeftPocketCenterX} ${bottomLeftPocketCenterY})`}
              />
            ) : null}
            {topRightPocketProgress > 0 ? (
              <ellipse
                cx={topRightPocketCenterX}
                cy={topRightPocketCenterY}
                fill="black"
                rx={Math.max(eraseWidth * 0.36 * topRightPocketProgress, 1)}
                ry={Math.max(eraseWidth * 0.42 * topRightPocketProgress, 1)}
                transform={`rotate(-18 ${topRightPocketCenterX} ${topRightPocketCenterY})`}
              />
            ) : null}
          </mask>
        </defs>

        <image
          height={viewport.height}
          href={backgroundImageSrc}
          mask={`url(#${maskId})`}
          preserveAspectRatio="xMidYMid slice"
          width={viewport.width}
        />

        {phase === "revealing" && leadingEdgeVisibleLength > 0 ? (
          <path
            d={brushPath}
            fill="none"
            pathLength={100}
            stroke="rgba(255,255,255,0.28)"
            strokeDasharray={`${leadingEdgeVisibleLength} 100`}
            strokeDashoffset={-leadingEdgeStart}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={leadingEdgeWidth}
          />
        ) : null}
      </svg>
    </div>
  );
}

export function HomeScreenTransitionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [transition, setTransition] = useState<HomeScreenTransitionState>({
    id: 0,
    phase: "idle",
    backgroundImageSrc: null,
  });
  // Keep the last-used background image src so we can preload it persistently
  // across page navigations (the provider never unmounts).
  const lastBgSrcRef = useRef<string | null>(null);
  if (transition.backgroundImageSrc) {
    lastBgSrcRef.current = transition.backgroundImageSrc;
  }

  const beginHomeTransition = useCallback((backgroundImageSrc: string) => {
    setTransition((previous) => ({
      id: previous.id + 1,
      phase: "holding",
      backgroundImageSrc,
    }));
  }, []);

  const revealHomeTransition = useCallback(() => {
    setTransition((previous) => {
      if (previous.phase !== "holding") {
        return previous;
      }

      return {
        ...previous,
        phase: "revealing",
      };
    });
  }, []);

  const cancelHomeTransition = useCallback(() => {
    setTransition((previous) => {
      if (previous.phase === "idle") {
        return previous;
      }

      return {
        ...previous,
        phase: "idle",
        backgroundImageSrc: null,
      };
    });
  }, []);

  const finishHomeTransition = useCallback(() => {
    setTransition((previous) => {
      if (previous.phase === "idle") {
        return previous;
      }

      return {
        ...previous,
        phase: "idle",
        backgroundImageSrc: null,
      };
    });
  }, []);

  const value = useMemo<HomeScreenTransitionContextValue>(
    () => ({
      phase: transition.phase,
      beginHomeTransition,
      revealHomeTransition,
      cancelHomeTransition,
    }),
    [
      beginHomeTransition,
      cancelHomeTransition,
      revealHomeTransition,
      transition.phase,
    ],
  );

  return (
    <HomeScreenTransitionContext.Provider value={value}>
      {children}
      <HomeScreenTransitionOverlay
        backgroundImageSrc={transition.backgroundImageSrc}
        onRevealFinished={finishHomeTransition}
        phase={transition.phase}
        transitionId={transition.id}
      />
      {/* Persistent preload: keeps the background image decoded across navigations */}
      {lastBgSrcRef.current ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          aria-hidden="true"
          alt=""
          src={lastBgSrcRef.current}
          decoding="sync"
          className="pointer-events-none fixed -z-50 h-0 w-0 opacity-0"
        />
      ) : null}
    </HomeScreenTransitionContext.Provider>
  );
}

export { useHomeScreenTransition } from "@/hooks/use-home-screen-transition";
