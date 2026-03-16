"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

const ATTACK_LERP = 0.5;
const RELEASE_LERP = 0.12;
const MIN_LEVEL = 0.002;
const IDLE_GLOW_LEVEL = 0.22;
const LEVEL_RESPONSE_EXPONENT = 0.58;
const ACCENT_DECAY = 0.82;
const ACCENT_RESPONSE_EXPONENT = 0.72;
const GLOW_TRANSITION =
  "transform 200ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms cubic-bezier(0.22, 1, 0.36, 1)";

export type BottomBarVoiceControlsHandle = {
  pushAgentAudioLevel: (level: number) => void;
  resetAgentAudio: () => void;
};

type BottomBarVoiceControlsProps = {
  isConnected: boolean;
};

function clampLevel(level: number) {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(1, level));
}

function smoothLevel(current: number, target: number) {
  const lerp = target > current ? ATTACK_LERP : RELEASE_LERP;
  const next = current + (target - current) * lerp;
  return next < MIN_LEVEL ? 0 : next;
}

export const BottomBarVoiceControls = forwardRef<
  BottomBarVoiceControlsHandle,
  BottomBarVoiceControlsProps
>(function BottomBarVoiceControls({ isConnected }, ref) {
  const agentLevelRef = useRef(0);
  const agentAccentRef = useRef(0);
  const lastRenderedLevelRef = useRef(0);
  const lastRenderedAtRef = useRef(0);
  const [agentLevel, setAgentLevel] = useState(0);
  const [agentAccent, setAgentAccent] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      pushAgentAudioLevel(level) {
        const targetLevel = clampLevel(level);
        const nextLevel = smoothLevel(agentLevelRef.current, targetLevel);
        const levelJump = Math.max(0, targetLevel - agentLevelRef.current);
        const nextAccent = Math.max(levelJump, agentAccentRef.current * ACCENT_DECAY);
        agentLevelRef.current = nextLevel;
        agentAccentRef.current = nextAccent;

        const now = performance.now();
        const levelDelta = Math.abs(nextLevel - lastRenderedLevelRef.current);
        const shouldRender =
          levelDelta >= 0.015 ||
          Math.abs(nextAccent - agentAccent) >= 0.04 ||
          now - lastRenderedAtRef.current >= 24 ||
          nextLevel === 0;

        if (!shouldRender) {
          return;
        }

        lastRenderedLevelRef.current = nextLevel;
        lastRenderedAtRef.current = now;
        setAgentLevel(nextLevel);
        setAgentAccent(nextAccent);
      },
      resetAgentAudio() {
        agentLevelRef.current = 0;
        agentAccentRef.current = 0;
        lastRenderedLevelRef.current = 0;
        lastRenderedAtRef.current = 0;
        setAgentLevel(0);
        setAgentAccent(0);
      },
    }),
    [agentAccent],
  );

  useEffect(() => {
    let frameId: number | null = null;

    if (!isConnected) {
      agentLevelRef.current = 0;
      agentAccentRef.current = 0;
      lastRenderedLevelRef.current = 0;
      lastRenderedAtRef.current = 0;
      frameId = window.requestAnimationFrame(() => {
        setAgentLevel(0);
        setAgentAccent(0);
      });
    }

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [isConnected]);

  if (!isConnected) {
    return null;
  }

  const levelEnergy = Math.pow(
    Math.max(agentLevel, MIN_LEVEL),
    LEVEL_RESPONSE_EXPONENT,
  );
  const accentEnergy = Math.pow(
    Math.max(agentAccent, MIN_LEVEL),
    ACCENT_RESPONSE_EXPONENT,
  );
  const glowStrength = Math.min(
    1,
    IDLE_GLOW_LEVEL + levelEnergy * 1.14 + accentEnergy * 0.42,
  );
  const motionLift = Math.min(1, levelEnergy * 0.92 + accentEnergy * 0.92);
  const motionBurst = Math.min(1, accentEnergy * 1.18);
  const contrastOpacity = 0.26 + glowStrength * 0.22 + motionBurst * 0.05;
  const depthOpacity = 0.24 + glowStrength * 0.22 + motionBurst * 0.05;
  const horizonOpacity = 0.28 + glowStrength * 0.26 + motionBurst * 0.06;
  const atmosphereOpacity = 0.24 + glowStrength * 0.26 + motionBurst * 0.07;
  const coreOpacity = 0.2 + glowStrength * 0.28 + motionBurst * 0.1;
  const focusOpacity = 0.18 + glowStrength * 0.24 + motionBurst * 0.14;
  const contrastScaleX = 1 + glowStrength * 0.18 + motionBurst * 0.05;
  const contrastScaleY = 0.94 + glowStrength * 0.16 + motionBurst * 0.05;
  const depthScaleX = 1 + glowStrength * 0.24 + motionBurst * 0.07;
  const depthScaleY = 0.9 + glowStrength * 0.22 + motionBurst * 0.07;
  const horizonScaleX = 1 + glowStrength * 0.28 + motionBurst * 0.12;
  const horizonScaleY = 0.9 + glowStrength * 0.26 + motionBurst * 0.1;
  const atmosphereScaleX = 1 + glowStrength * 0.34 + motionBurst * 0.16;
  const atmosphereScaleY = 0.98 + glowStrength * 0.34 + motionBurst * 0.14;
  const coreScaleX = 1 + glowStrength * 0.38 + motionBurst * 0.2;
  const coreScaleY = 1 + glowStrength * 0.48 + motionBurst * 0.18;
  const focusScaleX = 1 + glowStrength * 0.24 + motionBurst * 0.24;
  const focusScaleY = 1 + glowStrength * 0.28 + motionBurst * 0.22;
  const contrastTranslateY = -2 * motionLift - motionBurst;
  const depthTranslateY = -4 * motionLift - 2 * motionBurst;
  const horizonTranslateY = -7 * motionLift - 4 * motionBurst;
  const atmosphereTranslateY = -10 * motionLift - 6 * motionBurst;
  const coreTranslateY = -12 * motionLift - 8 * motionBurst;
  const focusTranslateY = -9 * motionLift - 10 * motionBurst;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative h-28 w-[700px] max-w-[96vw] select-none overflow-visible isolate"
    >
      <div
        className="absolute inset-x-0 bottom-0 h-full"
        style={{ filter: "saturate(1.18) contrast(1.08)" }}
      >
        <div
          className="absolute bottom-[-64px] left-1/2 h-[162px] w-[188%] rounded-full blur-[112px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(3, 8, 42, 0.54) 0%, rgba(7, 18, 74, 0.46) 18%, rgba(12, 28, 108, 0.32) 38%, rgba(18, 36, 126, 0.16) 62%, rgba(18, 36, 126, 0.06) 78%, rgba(18, 36, 126, 0) 92%)",
            opacity: contrastOpacity,
            transform: `translate3d(-50%, ${contrastTranslateY}px, 0) scale(${contrastScaleX}, ${contrastScaleY})`,
            transition: GLOW_TRANSITION,
            mixBlendMode: "normal",
          }}
        />
        <div
          className="absolute bottom-[-56px] left-1/2 h-[148px] w-[176%] rounded-full blur-[98px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(14, 34, 146, 0.7) 0%, rgba(22, 52, 170, 0.58) 16%, rgba(34, 70, 196, 0.42) 34%, rgba(56, 98, 234, 0.22) 56%, rgba(56, 98, 234, 0.1) 70%, rgba(56, 98, 234, 0.03) 82%, rgba(56, 98, 234, 0) 90%)",
            opacity: depthOpacity,
            transform: `translate3d(-50%, ${depthTranslateY}px, 0) scale(${depthScaleX}, ${depthScaleY})`,
            transition: GLOW_TRANSITION,
            mixBlendMode: "normal",
          }}
        />
        <div
          className="absolute bottom-[-42px] left-1/2 h-[132px] w-[162%] rounded-full blur-[76px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(64, 112, 255, 0.84) 0%, rgba(64, 112, 255, 0.68) 18%, rgba(64, 112, 255, 0.5) 34%, rgba(64, 112, 255, 0.3) 54%, rgba(64, 112, 255, 0.14) 68%, rgba(64, 112, 255, 0.05) 80%, rgba(64, 112, 255, 0) 90%)",
            opacity: horizonOpacity,
            transform: `translate3d(-50%, ${horizonTranslateY}px, 0) scale(${horizonScaleX}, ${horizonScaleY})`,
            transition: GLOW_TRANSITION,
            mixBlendMode: "normal",
          }}
        />
        <div
          className="absolute bottom-[-12px] left-1/2 h-[102px] w-[118%] rounded-full blur-[54px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(146, 204, 255, 0.56) 0%, rgba(124, 186, 255, 0.46) 18%, rgba(102, 164, 255, 0.36) 36%, rgba(70, 114, 236, 0.2) 58%, rgba(70, 114, 236, 0.1) 72%, rgba(70, 114, 236, 0.03) 84%, rgba(70, 114, 236, 0) 92%)",
            opacity: atmosphereOpacity,
            transform: `translate3d(-50%, ${atmosphereTranslateY}px, 0) scale(${atmosphereScaleX}, ${atmosphereScaleY})`,
            transition: GLOW_TRANSITION,
            mixBlendMode: "normal",
          }}
        />
        <div
          className="absolute bottom-[10px] left-1/2 h-[56px] w-[70%] rounded-full blur-[34px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(236, 246, 255, 0.34) 0%, rgba(206, 232, 255, 0.3) 18%, rgba(162, 208, 255, 0.24) 38%, rgba(102, 160, 255, 0.13) 58%, rgba(102, 160, 255, 0.06) 72%, rgba(102, 160, 255, 0.02) 84%, rgba(102, 160, 255, 0) 92%)",
            opacity: coreOpacity,
            transform: `translate3d(-50%, ${coreTranslateY}px, 0) scale(${coreScaleX}, ${coreScaleY})`,
            transition: GLOW_TRANSITION,
            mixBlendMode: "normal",
          }}
        />
        <div
          className="absolute bottom-[16px] left-1/2 h-[34px] w-[46%] rounded-full blur-[22px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(242, 249, 255, 0.72) 0%, rgba(180, 220, 255, 0.42) 30%, rgba(110, 168, 255, 0.16) 60%, rgba(110, 168, 255, 0) 90%)",
            opacity: focusOpacity,
            transform: `translate3d(-50%, ${focusTranslateY}px, 0) scale(${focusScaleX}, ${focusScaleY})`,
            transition: GLOW_TRANSITION,
            mixBlendMode: "normal",
          }}
        />
      </div>
    </div>
  );
});

BottomBarVoiceControls.displayName = "BottomBarVoiceControls";
