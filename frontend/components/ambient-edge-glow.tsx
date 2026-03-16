"use client";

import { useEffect, useRef, useState } from "react";

const EDGE_GLOW_MASK =
  "radial-gradient(ellipse at center, rgba(0, 0, 0, 0) 24%, rgba(0, 0, 0, 0.03) 42%, rgba(0, 0, 0, 0.16) 58%, rgba(0, 0, 0, 0.44) 74%, rgba(0, 0, 0, 0.78) 90%, rgba(0, 0, 0, 1) 100%)";

const GLOW_ENTER_SETTLE_MS = 420;
const GLOW_EXIT_SETTLE_MS = 980;

type GlowPhase = "hidden" | "entering" | "active" | "exiting";

function clearTimer(timerRef: { current: number | null }) {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

export default function AmbientEdgeGlow({
  isActive = false,
}: {
  isActive?: boolean;
}) {
  const [phase, setPhase] = useState<GlowPhase>(isActive ? "active" : "hidden");
  const enterTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      clearTimer(enterTimerRef);
      clearTimer(exitTimerRef);
    };
  }, []);

  useEffect(() => {
    let frameId: number | null = null;

    if (isActive) {
      clearTimer(exitTimerRef);
      frameId = window.requestAnimationFrame(() => {
        setPhase((current) => (current === "active" ? current : "entering"));
      });
      clearTimer(enterTimerRef);
      enterTimerRef.current = window.setTimeout(() => {
        setPhase("active");
        enterTimerRef.current = null;
      }, GLOW_ENTER_SETTLE_MS);
      return;
    }

    clearTimer(enterTimerRef);
    frameId = window.requestAnimationFrame(() => {
      setPhase((current) => (current === "hidden" ? current : "exiting"));
    });
    clearTimer(exitTimerRef);
    exitTimerRef.current = window.setTimeout(() => {
      setPhase("hidden");
      exitTimerRef.current = null;
    }, GLOW_EXIT_SETTLE_MS);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [isActive]);

  const containerStyle =
    phase === "active"
      ? {
          opacity: 1,
          transform: "scale(1)",
          filter: "blur(0px) saturate(1)",
          transition:
            "opacity 720ms cubic-bezier(0.22, 1, 0.36, 1), transform 1200ms cubic-bezier(0.22, 1, 0.36, 1), filter 1200ms cubic-bezier(0.22, 1, 0.36, 1)",
        }
      : phase === "entering"
        ? {
            opacity: 0.7,
            transform: "scale(1.028)",
            filter: "blur(10px) saturate(0.98)",
            transition:
              "opacity 820ms cubic-bezier(0.16, 1, 0.3, 1), transform 1500ms cubic-bezier(0.16, 1, 0.3, 1), filter 1500ms cubic-bezier(0.16, 1, 0.3, 1)",
          }
        : phase === "exiting"
          ? {
              opacity: 0.34,
              transform: "scale(1.018)",
              filter: "blur(12px) saturate(0.94)",
              transition:
                "opacity 1400ms cubic-bezier(0.2, 0.7, 0.2, 1), transform 1800ms cubic-bezier(0.2, 0.7, 0.2, 1), filter 1800ms cubic-bezier(0.2, 0.7, 0.2, 1)",
            }
          : {
              opacity: 0,
              transform: "scale(1.038)",
              filter: "blur(18px) saturate(0.88)",
              transition:
                "opacity 900ms cubic-bezier(0.2, 0.7, 0.2, 1), transform 1300ms cubic-bezier(0.2, 0.7, 0.2, 1), filter 1300ms cubic-bezier(0.2, 0.7, 0.2, 1)",
            };

  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div
        ref={containerRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
        style={{
          ...containerStyle,
          willChange: phase === "hidden" ? "auto" : "opacity, transform, filter",
        }}
      >
        <div
          data-chat-edge-glow
          className="absolute inset-[-20%] blur-[92px]"
          style={{
            WebkitMaskImage: EDGE_GLOW_MASK,
            maskImage: EDGE_GLOW_MASK,
            background:
              "radial-gradient(48% 42% at -8% -10%, rgba(179, 246, 255, 1) 0%, rgba(179, 246, 255, 0.52) 24%, rgba(179, 246, 255, 0.12) 40%, rgba(179, 246, 255, 0) 68%), radial-gradient(44% 38% at 110% -8%, rgba(99, 196, 255, 0.98) 0%, rgba(99, 196, 255, 0.44) 24%, rgba(99, 196, 255, 0.12) 40%, rgba(99, 196, 255, 0) 68%), radial-gradient(42% 38% at -12% 64%, rgba(111, 228, 255, 0.94) 0%, rgba(111, 228, 255, 0.36) 22%, rgba(111, 228, 255, 0.1) 38%, rgba(111, 228, 255, 0) 64%), radial-gradient(42% 38% at 114% 58%, rgba(86, 149, 255, 0.9) 0%, rgba(86, 149, 255, 0.34) 22%, rgba(86, 149, 255, 0.1) 38%, rgba(86, 149, 255, 0) 62%), radial-gradient(52% 40% at 50% 118%, rgba(64, 114, 255, 0.94) 0%, rgba(64, 114, 255, 0.36) 22%, rgba(64, 114, 255, 0.1) 38%, rgba(64, 114, 255, 0) 64%)",
            animation: "chatEdgeGlowPulsePrimary 8.5s ease-in-out infinite",
            animationPlayState: isVisible ? "running" : "paused",
            filter: "saturate(1.42) brightness(1.14)",
            mixBlendMode: "screen",
            opacity: 1,
          }}
        />
        <div
          data-chat-edge-glow
          className="absolute inset-[-28%] blur-[148px]"
          style={{
            WebkitMaskImage: EDGE_GLOW_MASK,
            maskImage: EDGE_GLOW_MASK,
            background:
              "radial-gradient(52% 40% at 50% -12%, rgba(188, 246, 255, 0.94) 0%, rgba(188, 246, 255, 0.3) 22%, rgba(188, 246, 255, 0.1) 38%, rgba(188, 246, 255, 0) 64%), radial-gradient(54% 42% at 50% 114%, rgba(80, 116, 255, 0.9) 0%, rgba(80, 116, 255, 0.26) 22%, rgba(80, 116, 255, 0.08) 38%, rgba(80, 116, 255, 0) 66%), radial-gradient(42% 36% at 2% 16%, rgba(167, 238, 255, 0.68) 0%, rgba(167, 238, 255, 0.2) 20%, rgba(167, 238, 255, 0.06) 32%, rgba(167, 238, 255, 0) 56%), radial-gradient(42% 36% at 98% 18%, rgba(96, 180, 255, 0.66) 0%, rgba(96, 180, 255, 0.18) 20%, rgba(96, 180, 255, 0.06) 32%, rgba(96, 180, 255, 0) 56%), radial-gradient(34% 46% at -10% 52%, rgba(118, 232, 255, 0.54) 0%, rgba(118, 232, 255, 0.14) 20%, rgba(118, 232, 255, 0) 50%), radial-gradient(34% 46% at 110% 50%, rgba(99, 158, 255, 0.48) 0%, rgba(99, 158, 255, 0.14) 20%, rgba(99, 158, 255, 0) 50%)",
            animation: "chatEdgeGlowPulseAtmosphere 15s ease-in-out infinite",
            animationPlayState: isVisible ? "running" : "paused",
            filter: "saturate(1.44) brightness(1.16)",
            mixBlendMode: "screen",
            opacity: 0.88,
          }}
        />
        <div
          data-chat-edge-glow
          className="absolute inset-[-6%] blur-[58px]"
          style={{
            WebkitMaskImage: EDGE_GLOW_MASK,
            maskImage: EDGE_GLOW_MASK,
            background:
              "radial-gradient(circle at 0% 0%, rgba(202, 250, 255, 0.98) 0%, rgba(202, 250, 255, 0.42) 14%, rgba(202, 250, 255, 0.12) 24%, rgba(202, 250, 255, 0) 38%), radial-gradient(circle at 100% 0%, rgba(126, 209, 255, 0.96) 0%, rgba(126, 209, 255, 0.36) 14%, rgba(126, 209, 255, 0.1) 24%, rgba(126, 209, 255, 0) 38%), radial-gradient(circle at 0% 100%, rgba(120, 223, 255, 0.88) 0%, rgba(120, 223, 255, 0.28) 12%, rgba(120, 223, 255, 0.08) 22%, rgba(120, 223, 255, 0) 36%), radial-gradient(circle at 100% 100%, rgba(83, 121, 255, 0.94) 0%, rgba(83, 121, 255, 0.34) 12%, rgba(83, 121, 255, 0.1) 22%, rgba(83, 121, 255, 0) 36%)",
            animation: "chatEdgeGlowPulseCorners 7.4s ease-in-out infinite",
            animationPlayState: isVisible ? "running" : "paused",
            filter: "saturate(1.46) brightness(1.14)",
            mixBlendMode: "screen",
            opacity: 0.96,
          }}
        />
        <div
          data-chat-edge-glow
          className="absolute inset-[-12%] blur-[96px]"
          style={{
            WebkitMaskImage: EDGE_GLOW_MASK,
            maskImage: EDGE_GLOW_MASK,
            background:
              "radial-gradient(42% 34% at 50% -8%, rgba(193, 247, 255, 0.9) 0%, rgba(193, 247, 255, 0.34) 20%, rgba(193, 247, 255, 0.1) 36%, rgba(193, 247, 255, 0) 64%), radial-gradient(40% 34% at 50% 108%, rgba(91, 128, 255, 0.92) 0%, rgba(91, 128, 255, 0.34) 20%, rgba(91, 128, 255, 0.1) 36%, rgba(91, 128, 255, 0) 64%), radial-gradient(34% 56% at -8% 50%, rgba(145, 234, 255, 0.72) 0%, rgba(145, 234, 255, 0.22) 20%, rgba(145, 234, 255, 0.06) 36%, rgba(145, 234, 255, 0) 58%), radial-gradient(34% 56% at 108% 50%, rgba(90, 164, 255, 0.66) 0%, rgba(90, 164, 255, 0.2) 20%, rgba(90, 164, 255, 0.06) 36%, rgba(90, 164, 255, 0) 58%)",
            animation: "chatEdgeGlowPulseRim 11s ease-in-out infinite",
            animationPlayState: isVisible ? "running" : "paused",
            filter: "saturate(1.4) brightness(1.14)",
            mixBlendMode: "screen",
            opacity: 0.94,
          }}
        />
        <div
          data-chat-edge-glow
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(255, 255, 255, 0) 18%, rgba(170, 237, 255, 0.08) 40%, rgba(112, 190, 255, 0.22) 66%, rgba(44, 88, 209, 0.34) 84%, rgba(18, 41, 112, 0.5) 100%)",
            animation: "chatEdgeGlowColorBreath 9.5s ease-in-out infinite",
            animationPlayState: isVisible ? "running" : "paused",
          }}
        />
      </div>

      <style>{`
        @keyframes chatEdgeGlowPulsePrimary {
          0% {
            transform: translate3d(-3%, -2%, 0) scale(0.98);
            opacity: 0.78;
            filter: saturate(1.18) brightness(1.02);
          }
          50% {
            transform: translate3d(1.5%, 2.5%, 0) scale(1.09);
            opacity: 1;
            filter: saturate(1.42) brightness(1.18);
          }
          100% {
            transform: translate3d(-1.5%, 1.5%, 0) scale(1.02);
            opacity: 0.84;
            filter: saturate(1.24) brightness(1.08);
          }
        }

        @keyframes chatEdgeGlowPulseAtmosphere {
          0% {
            transform: translate3d(3%, -3%, 0) scale(0.98);
            opacity: 0.52;
            filter: saturate(1.18) brightness(1.02);
          }
          50% {
            transform: translate3d(-2.5%, 2%, 0) scale(1.1);
            opacity: 0.92;
            filter: saturate(1.44) brightness(1.16);
          }
          100% {
            transform: translate3d(2%, 3%, 0) scale(1.03);
            opacity: 0.62;
            filter: saturate(1.24) brightness(1.08);
          }
        }

        @keyframes chatEdgeGlowPulseCorners {
          0% {
            transform: translate3d(0, 0, 0) scale(0.98);
            opacity: 0.72;
            filter: saturate(1.2) brightness(1.02);
          }
          50% {
            transform: translate3d(0.5%, -0.5%, 0) scale(1.12);
            opacity: 1;
            filter: saturate(1.5) brightness(1.18);
          }
          100% {
            transform: translate3d(0, 0.5%, 0) scale(1.02);
            opacity: 0.8;
            filter: saturate(1.28) brightness(1.08);
          }
        }

        @keyframes chatEdgeGlowPulseRim {
          0%,
          100% {
            transform: scale(0.99) translate3d(0, 0, 0);
            opacity: 0.68;
            filter: saturate(1.16) brightness(1);
          }
          50% {
            transform: scale(1.1) translate3d(0, -0.5%, 0);
            opacity: 0.98;
            filter: saturate(1.4) brightness(1.16);
          }
        }

        @keyframes chatEdgeGlowColorBreath {
          0%,
          100% {
            opacity: 0.64;
            filter: saturate(1.04) brightness(1);
          }
          50% {
            opacity: 0.98;
            filter: saturate(1.26) brightness(1.12);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          [data-chat-edge-glow] {
            animation: none !important;
            transform: none !important;
          }
        }
      `}</style>
    </>
  );
}
