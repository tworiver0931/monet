"use client";

import type { AgentState } from "@livekit/components-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { AgentAudioVisualizerAura } from "@/components/agents-ui/agent-audio-visualizer-aura";

const USER_ACTIVITY_FLOOR = 0.035;
const AGENT_ACTIVITY_FLOOR = 0.03;
const USER_ACTIVE_HOLD_MS = 120;
const AGENT_ACTIVE_HOLD_MS = 480;
const SPEAKING_RELEASE_MS = 260;
const THINKING_WINDOW_MS = 1400;
const ATTACK_LERP = 0.8;
const RELEASE_LERP = 0.18;
const MIN_LEVEL = 0.002;

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

const VISUALIZER_COLOR: `#${string}` = "#06b6d4";
const VISUALIZER_COLOR_SHIFT = 0.05;

export const BottomBarVoiceControls = forwardRef<
  BottomBarVoiceControlsHandle,
  BottomBarVoiceControlsProps
>(function BottomBarVoiceControls({ isConnected, isRecording }, ref) {
  const userInputLevelRef = useRef(0);
  const agentInputLevelRef = useRef(0);
  const userLevelRef = useRef(0);
  const agentLevelRef = useRef(0);
  const lastUserActivityAtRef = useRef(0);
  const lastAgentActivityAtRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const speakingReleaseTimeoutRef = useRef<number | null>(null);
  const [frame, setFrame] = useState({
    userLevel: 0,
    agentLevel: 0,
    now: Date.now(),
  });
  const [visualizerState, setVisualizerState] = useState<AgentState>(
    isConnected ? "idle" : "connecting",
  );

  useImperativeHandle(
    ref,
    () => ({
      pushUserAudioLevel(level) {
        const nextLevel = clampLevel(level);
        userInputLevelRef.current = nextLevel;
        if (nextLevel > USER_ACTIVITY_FLOOR) {
          lastUserActivityAtRef.current = Date.now();
        }
      },
      pushAgentAudioLevel(level) {
        const nextLevel = clampLevel(level);
        agentInputLevelRef.current = nextLevel;
        if (nextLevel > AGENT_ACTIVITY_FLOOR) {
          lastAgentActivityAtRef.current = Date.now();
        }
      },
      resetUserAudio() {
        userInputLevelRef.current = 0;
        userLevelRef.current = 0;
        setFrame((current) => ({
          ...current,
          userLevel: 0,
          now: Date.now(),
        }));
      },
      resetAgentAudio() {
        agentInputLevelRef.current = 0;
        agentLevelRef.current = 0;
        setFrame((current) => ({
          ...current,
          agentLevel: 0,
          now: Date.now(),
        }));
      },
    }),
    [],
  );

  useEffect(() => {
    let idleCount = 0;
    const IDLE_THRESHOLD = 60; // ~1s at 60fps
    let throttleInterval: ReturnType<typeof setInterval> | null = null;

    const computeFrame = () => {
      userLevelRef.current = smoothLevel(
        userLevelRef.current,
        userInputLevelRef.current,
      );
      agentLevelRef.current = smoothLevel(
        agentLevelRef.current,
        agentInputLevelRef.current,
      );

      const userLevel = userLevelRef.current;
      const agentLevel = agentLevelRef.current;

      setFrame({
        userLevel,
        agentLevel,
        now: Date.now(),
      });

      // Throttle when both levels are effectively zero
      if (userLevel < MIN_LEVEL && agentLevel < MIN_LEVEL) {
        idleCount++;
        if (idleCount > IDLE_THRESHOLD && !throttleInterval) {
          if (animationFrameRef.current !== null) {
            window.cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
          }
          throttleInterval = setInterval(computeFrame, 100);
          return;
        }
      } else {
        idleCount = 0;
        if (throttleInterval) {
          clearInterval(throttleInterval);
          throttleInterval = null;
        }
      }

      animationFrameRef.current = window.requestAnimationFrame(computeFrame);
    };

    animationFrameRef.current = window.requestAnimationFrame(computeFrame);
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      if (throttleInterval) {
        clearInterval(throttleInterval);
      }
    };
  }, []);

  useEffect(() => {
    if (!isRecording) {
      userInputLevelRef.current = 0;
      userLevelRef.current = 0;
      setFrame((current) => ({
        ...current,
        userLevel: 0,
        now: Date.now(),
      }));
    }
  }, [isRecording]);

  useEffect(() => {
    if (!isConnected) {
      if (speakingReleaseTimeoutRef.current !== null) {
        window.clearTimeout(speakingReleaseTimeoutRef.current);
        speakingReleaseTimeoutRef.current = null;
      }
      userInputLevelRef.current = 0;
      agentInputLevelRef.current = 0;
      userLevelRef.current = 0;
      agentLevelRef.current = 0;
      setFrame({
        userLevel: 0,
        agentLevel: 0,
        now: Date.now(),
      });
    }
  }, [isConnected]);

  const targetVisualizerState = useMemo<AgentState>(() => {
    if (!isConnected) {
      return "connecting";
    }

    const hasRecentAgentAudio =
      frame.agentLevel > AGENT_ACTIVITY_FLOOR ||
      frame.now - lastAgentActivityAtRef.current < AGENT_ACTIVE_HOLD_MS;
    if (hasRecentAgentAudio) {
      return "speaking";
    }

    const hasRecentUserAudio =
      isRecording &&
      (frame.userLevel > USER_ACTIVITY_FLOOR ||
        frame.now - lastUserActivityAtRef.current < USER_ACTIVE_HOLD_MS);
    if (hasRecentUserAudio) {
      return "listening";
    }

    const isWaitingOnAgent =
      lastUserActivityAtRef.current > lastAgentActivityAtRef.current &&
      frame.now - lastUserActivityAtRef.current < THINKING_WINDOW_MS;
    if (isWaitingOnAgent) {
      return "thinking";
    }

    return "idle";
  }, [frame.agentLevel, frame.now, frame.userLevel, isConnected, isRecording]);

  useEffect(() => {
    if (speakingReleaseTimeoutRef.current !== null) {
      window.clearTimeout(speakingReleaseTimeoutRef.current);
      speakingReleaseTimeoutRef.current = null;
    }

    // Immediate transitions: entering speaking or connecting
    if (
      targetVisualizerState === "speaking" ||
      targetVisualizerState === "connecting"
    ) {
      setVisualizerState(targetVisualizerState);
      return;
    }

    // Same state — nothing to do
    if (targetVisualizerState === visualizerState) {
      return;
    }

    // Debounce all other transitions to prevent rapid cycling
    speakingReleaseTimeoutRef.current = window.setTimeout(() => {
      setVisualizerState(targetVisualizerState);
      speakingReleaseTimeoutRef.current = null;
    }, SPEAKING_RELEASE_MS);

    return () => {
      if (speakingReleaseTimeoutRef.current !== null) {
        window.clearTimeout(speakingReleaseTimeoutRef.current);
        speakingReleaseTimeoutRef.current = null;
      }
    };
  }, [targetVisualizerState, visualizerState]);

  const color = VISUALIZER_COLOR;
  const colorShift = VISUALIZER_COLOR_SHIFT;
  const activeAudioLevel =
    visualizerState === "speaking" ? frame.agentLevel : frame.userLevel;

  return (
    <div className="relative flex size-14 items-center justify-center">
      <AgentAudioVisualizerAura
        aria-hidden="true"
        size="sm"
        state={visualizerState}
        audioLevel={activeAudioLevel}
        color={color}
        colorShift={colorShift}
        themeMode="light"
        className="size-14"
      />
    </div>
  );
});

BottomBarVoiceControls.displayName = "BottomBarVoiceControls";
