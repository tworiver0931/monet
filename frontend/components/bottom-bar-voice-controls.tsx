"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

const ATTACK_LERP = 0.42;
const RELEASE_LERP = 0.1;
const MIN_LEVEL = 0.002;
const IDLE_GLOW_LEVEL = 0.22;
const LEVEL_RESPONSE_EXPONENT = 0.7;
const GLOW_TRANSITION =
  "transform 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 320ms cubic-bezier(0.22, 1, 0.36, 1)";

export type BottomBarVoiceControlsHandle = {
  pushUserAudioLevel: (level: number) => void;
  pushAgentAudioLevel: (level: number) => void;
  resetUserAudio: () => void;
  resetAgentAudio: () => void;
};

type BottomBarVoiceControlsProps = {
  isConnected: boolean;
  isRecording: boolean;
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
  const lastRenderedLevelRef = useRef(0);
  const lastRenderedAtRef = useRef(0);
  const [agentLevel, setAgentLevel] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      pushUserAudioLevel() {},
      pushAgentAudioLevel(level) {
        const nextLevel = smoothLevel(agentLevelRef.current, clampLevel(level));
        agentLevelRef.current = nextLevel;

        const now = performance.now();
        const levelDelta = Math.abs(nextLevel - lastRenderedLevelRef.current);
        const shouldRender =
          levelDelta >= 0.025 ||
          now - lastRenderedAtRef.current >= 33 ||
          nextLevel === 0;

        if (!shouldRender) {
          return;
        }

        lastRenderedLevelRef.current = nextLevel;
        lastRenderedAtRef.current = now;
        setAgentLevel(nextLevel);
      },
      resetUserAudio() {},
      resetAgentAudio() {
        agentLevelRef.current = 0;
        lastRenderedLevelRef.current = 0;
        lastRenderedAtRef.current = 0;
        setAgentLevel(0);
      },
    }),
    [],
  );

  useEffect(() => {
    if (!isConnected) {
      agentLevelRef.current = 0;
      lastRenderedLevelRef.current = 0;
      lastRenderedAtRef.current = 0;
      setAgentLevel(0);
    }
  }, [isConnected]);

  if (!isConnected) {
    return null;
  }

  const levelEnergy = Math.pow(
    Math.max(agentLevel, MIN_LEVEL),
    LEVEL_RESPONSE_EXPONENT,
  );
  const glowStrength = Math.min(1, IDLE_GLOW_LEVEL + levelEnergy);
  const depthOpacity = 0.18 + glowStrength * 0.16;
  const horizonOpacity = 0.2 + glowStrength * 0.2;
  const atmosphereOpacity = 0.18 + glowStrength * 0.2;
  const coreOpacity = 0.16 + glowStrength * 0.2;
  const depthScaleX = 1 + glowStrength * 0.18;
  const depthScaleY = 0.9 + glowStrength * 0.16;
  const horizonScaleX = 1 + glowStrength * 0.2;
  const horizonScaleY = 0.9 + glowStrength * 0.2;
  const atmosphereScaleX = 1 + glowStrength * 0.24;
  const atmosphereScaleY = 0.98 + glowStrength * 0.24;
  const coreScaleX = 1 + glowStrength * 0.26;
  const coreScaleY = 1 + glowStrength * 0.34;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative h-28 w-[700px] max-w-[96vw] select-none overflow-visible"
    >
      <div className="absolute inset-x-0 bottom-0 h-full">
        <div
          className="absolute bottom-[-56px] left-1/2 h-[138px] w-[172%] rounded-full blur-[84px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(16, 36, 138, 0.44) 0%, rgba(34, 62, 171, 0.3) 26%, rgba(56, 90, 220, 0.12) 52%, rgba(56, 90, 220, 0) 76%)",
            opacity: depthOpacity,
            transform: `translateX(-50%) scale(${depthScaleX}, ${depthScaleY})`,
            transition: GLOW_TRANSITION,
          }}
        />
        <div
          className="absolute bottom-[-42px] left-1/2 h-[122px] w-[158%] rounded-full blur-[62px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(54, 94, 255, 0.62) 0%, rgba(54, 94, 255, 0.38) 28%, rgba(54, 94, 255, 0.14) 54%, rgba(54, 94, 255, 0) 78%)",
            opacity: horizonOpacity,
            transform: `translateX(-50%) scale(${horizonScaleX}, ${horizonScaleY})`,
            transition: GLOW_TRANSITION,
          }}
        />
        <div
          className="absolute bottom-[-10px] left-1/2 h-[90px] w-[114%] rounded-full blur-[42px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(132, 188, 255, 0.34) 0%, rgba(102, 157, 255, 0.26) 26%, rgba(70, 109, 229, 0.1) 58%, rgba(70, 109, 229, 0) 80%)",
            opacity: atmosphereOpacity,
            transform: `translateX(-50%) scale(${atmosphereScaleX}, ${atmosphereScaleY})`,
            transition: GLOW_TRANSITION,
          }}
        />
        <div
          className="absolute bottom-[12px] left-1/2 h-[46px] w-[66%] rounded-full blur-[24px]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(220, 239, 255, 0.2) 0%, rgba(158, 205, 255, 0.18) 22%, rgba(106, 159, 255, 0.12) 48%, rgba(106, 159, 255, 0) 80%)",
            opacity: coreOpacity,
            transform: `translateX(-50%) scale(${coreScaleX}, ${coreScaleY})`,
            transition: GLOW_TRANSITION,
          }}
        />
      </div>
    </div>
  );
});

BottomBarVoiceControls.displayName = "BottomBarVoiceControls";
