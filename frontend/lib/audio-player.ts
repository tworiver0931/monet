/**
 * Audio player using Web Audio API and AudioWorklet.
 * Port of bidi-demo's audio-player.js.
 *
 * Plays PCM audio received from the server at 24kHz mono.
 * Receives Int16 samples and feeds them to the pcm-player-processor worklet.
 */

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private initialized = false;
  private onLevel: ((level: number) => void) | null = null;
  private onPlaybackState: ((isPlaying: boolean) => void) | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private analyserFrameId: number | null = null;
  private throttleInterval: ReturnType<typeof setInterval> | null = null;

  async init(
    onLevel?: (level: number) => void,
    onPlaybackState?: (isPlaying: boolean) => void,
  ): Promise<void> {
    this.onLevel = onLevel ?? this.onLevel;
    this.onPlaybackState = onPlaybackState ?? this.onPlaybackState;
    if (this.initialized) return;

    this.audioContext = new AudioContext({ sampleRate: 24000 });

    await this.audioContext.audioWorklet.addModule(
      "/worklets/pcm-player-processor.js",
    );

    this.workletNode = new AudioWorkletNode(
      this.audioContext,
      "pcm-player-processor",
    );
    this.workletNode.port.onmessage = (event: MessageEvent) => {
      if (
        event.data &&
        typeof event.data === "object" &&
        event.data.type === "playback-state"
      ) {
        this.onPlaybackState?.(Boolean(event.data.isPlaying));
      }
    };
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.6;
    this.analyserData = new Uint8Array<ArrayBuffer>(
      new ArrayBuffer(this.analyserNode.frequencyBinCount),
    );
    this.workletNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioContext.destination);
    this.startLevelMonitoring();
    this.onPlaybackState?.(false);
    this.initialized = true;
  }

  async play(pcmData: ArrayBuffer): Promise<void> {
    if (!this.workletNode || !this.audioContext) return;

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // Restart level monitoring if it was stopped
    if (this.analyserFrameId === null && this.throttleInterval === null) {
      this.startLevelMonitoring();
    }

    const int16Data = new Int16Array(pcmData);
    this.workletNode.port.postMessage(int16Data);
  }

  stop(): void {
    this.stopLevelMonitoring();
    if (this.workletNode) {
      this.workletNode.port.postMessage("endOfAudio");
    }
    this.onLevel?.(0);
    this.onPlaybackState?.(false);
  }

  async close(): Promise<void> {
    this.stop();
    this.analyserNode?.disconnect();
    this.workletNode?.disconnect();
    if (this.audioContext?.state !== "closed") {
      await this.audioContext?.close();
    }
    this.workletNode = null;
    this.analyserNode = null;
    this.analyserData = null;
    this.audioContext = null;
    this.onLevel = null;
    this.onPlaybackState = null;
    this.initialized = false;
  }

  private stopLevelMonitoring(): void {
    if (this.throttleInterval !== null) {
      clearInterval(this.throttleInterval);
      this.throttleInterval = null;
    }
    if (this.analyserFrameId !== null) {
      cancelAnimationFrame(this.analyserFrameId);
      this.analyserFrameId = null;
    }
  }

  private startLevelMonitoring(): void {
    if (!this.analyserNode || !this.analyserData) return;

    let idleFrameCount = 0;
    const IDLE_THRESHOLD = 30; // ~0.5s at 60fps before throttling

    const scheduleAnimationFrame = () => {
      if (this.analyserFrameId !== null) {
        return;
      }

      this.analyserFrameId = requestAnimationFrame(() => {
        this.analyserFrameId = null;
        computeLevel("frame");
      });
    };

    const computeLevel = (source: "frame" | "interval") => {
      if (!this.analyserNode || !this.analyserData) return;

      this.analyserNode.getByteFrequencyData(this.analyserData);
      let sum = 0;
      for (let i = 0; i < this.analyserData.length; i++) {
        const value = this.analyserData[i] ?? 0;
        sum += value * value;
      }

      const level = Math.sqrt(sum / this.analyserData.length) / 255;
      this.onLevel?.(level);

      if (level < 0.005) {
        idleFrameCount++;
        if (idleFrameCount > IDLE_THRESHOLD) {
          if (source === "interval") {
            return;
          }

          // Switch to throttled polling when idle.
          if (this.analyserFrameId !== null) {
            cancelAnimationFrame(this.analyserFrameId);
            this.analyserFrameId = null;
          }

          if (this.throttleInterval !== null) {
            return;
          }

          this.throttleInterval = setInterval(() => {
            computeLevel("interval");
          }, 100); // 10fps when idle
          return;
        }
      } else {
        idleFrameCount = 0;
        if (this.throttleInterval) {
          clearInterval(this.throttleInterval);
          this.throttleInterval = null;
        }
      }

      scheduleAnimationFrame();
    };

    scheduleAnimationFrame();
  }
}
