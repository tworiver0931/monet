import { useEffect, useRef, useState, useCallback } from "react";
import { type LocalAudioTrack, type RemoteAudioTrack } from "livekit-client";
import {
  type AnimationPlaybackControlsWithThen,
  type ValueAnimationTransition,
  animate,
  useMotionValue,
  useMotionValueEvent,
} from "motion/react";
import {
  type AgentState,
  type TrackReference,
  type TrackReferenceOrPlaceholder,
  useTrackVolume,
} from "@livekit/components-react";

const DEFAULT_SPEED = 10;
const DEFAULT_AMPLITUDE = 2;
const DEFAULT_FREQUENCY = 0.5;
const DEFAULT_SCALE = 0.2;
const DEFAULT_BRIGHTNESS = 1.5;
const DEFAULT_TRANSITION: ValueAnimationTransition = {
  duration: 0.5,
  ease: "easeOut",
};
const SPEAKING_EXIT_TRANSITION: ValueAnimationTransition = {
  duration: 0.8,
  ease: "easeOut",
};
const DEFAULT_PULSE_TRANSITION: ValueAnimationTransition = {
  duration: 0.35,
  ease: "easeOut",
  repeat: Infinity,
  repeatType: "mirror",
};

function useAnimatedValue<T>(initialValue: T) {
  const [value, setValue] = useState(initialValue);
  const motionValue = useMotionValue(initialValue);
  const controlsRef = useRef<AnimationPlaybackControlsWithThen | null>(null);
  useMotionValueEvent(motionValue, "change", (value) => setValue(value as T));

  const animateFn = useCallback(
    (targetValue: T | T[], transition: ValueAnimationTransition) => {
      controlsRef.current = animate(motionValue, targetValue, transition);
    },
    [motionValue],
  );

  const setFn = useCallback(
    (nextValue: T) => {
      motionValue.set(nextValue);
    },
    [motionValue],
  );

  return {
    value,
    motionValue,
    controls: controlsRef,
    animate: animateFn,
    set: setFn,
  };
}

export function useAgentAudioVisualizerAura(
  state: AgentState | undefined,
  audioTrack?: LocalAudioTrack | RemoteAudioTrack | TrackReferenceOrPlaceholder,
  audioLevel?: number,
) {
  const previousStateRef = useRef<AgentState | undefined>(state);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const {
    value: scale,
    animate: animateScale,
    set: setScale,
  } = useAnimatedValue(DEFAULT_SCALE);
  const { value: amplitude, animate: animateAmplitude } =
    useAnimatedValue(DEFAULT_AMPLITUDE);
  const { value: frequency, animate: animateFrequency } =
    useAnimatedValue(DEFAULT_FREQUENCY);
  const { value: brightness, animate: animateBrightness } =
    useAnimatedValue(DEFAULT_BRIGHTNESS);

  const trackVolume = useTrackVolume(audioTrack as TrackReference, {
    fftSize: 512,
    smoothingTimeConstant: 0.55,
  });
  const volume = Math.max(0, Math.min(1, audioLevel ?? trackVolume));

  useEffect(() => {
    const previousState = previousStateRef.current;
    previousStateRef.current = state;
    const stateTransition =
      previousState === "speaking" && state !== "speaking"
        ? SPEAKING_EXIT_TRANSITION
        : DEFAULT_TRANSITION;

    switch (state) {
      case "idle":
      case "failed":
      case "disconnected":
        setSpeed(10);
        animateScale(0.2, stateTransition);
        animateAmplitude(1.2, stateTransition);
        animateFrequency(0.4, stateTransition);
        animateBrightness(1.0, stateTransition);
        return;
      case "listening":
      case "pre-connect-buffering":
        setSpeed(20);
        animateScale(
          0.3,
          previousState === "speaking"
            ? stateTransition
            : { type: "spring", duration: 1.0, bounce: 0.35 },
        );
        animateAmplitude(1.0, stateTransition);
        animateFrequency(0.7, stateTransition);
        animateBrightness([1.5, 2.0], DEFAULT_PULSE_TRANSITION);
        return;
      case "thinking":
      case "connecting":
      case "initializing":
        setSpeed(30);
        animateScale(0.3, stateTransition);
        animateAmplitude(0.5, stateTransition);
        animateFrequency(1, stateTransition);
        animateBrightness([0.5, 2.5], DEFAULT_PULSE_TRANSITION);
        return;
      case "speaking":
        setSpeed(70);
        animateScale(0.3, DEFAULT_TRANSITION);
        animateAmplitude(0.75, DEFAULT_TRANSITION);
        animateFrequency(1.25, DEFAULT_TRANSITION);
        animateBrightness(1.5, DEFAULT_TRANSITION);
        return;
    }
  }, [
    state,
    animateScale,
    animateAmplitude,
    animateFrequency,
    animateBrightness,
  ]);

  useEffect(() => {
    if (state === "listening" || state === "speaking") {
      const baseScale = state === "speaking" ? 0.2 : 0.24;
      const scaleRange = state === "speaking" ? 0.2 : 0.16;
      setScale(baseScale + scaleRange * Math.pow(volume, 0.9));
    }
  }, [
    state,
    volume,
    setScale,
  ]);

  return {
    speed,
    scale,
    amplitude,
    frequency,
    brightness,
  };
}
