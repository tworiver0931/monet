/**
 * Audio recorder using Web Audio API and AudioWorklet.
 * Port of bidi-demo's audio-recorder.js.
 *
 * Captures microphone audio at 16kHz mono, converts Float32 to Int16 PCM.
 */

export class AudioRecorder {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private monitorNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private onData: ((pcmBuffer: ArrayBuffer) => void) | null = null;
  private onLevel: ((level: number) => void) | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private analyserFrameId: number | null = null;
  private throttleInterval: ReturnType<typeof setInterval> | null = null;

  async start(
    onData: (pcmBuffer: ArrayBuffer) => void,
    onLevel?: (level: number) => void,
  ): Promise<void> {
    this.onData = onData;
    this.onLevel = onLevel ?? null;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });

    await this.audioContext.audioWorklet.addModule(
      "/worklets/pcm-recorder-processor.js",
    );

    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.12;
    this.analyserData = new Uint8Array<ArrayBuffer>(
      new ArrayBuffer(this.analyserNode.frequencyBinCount),
    );
    this.workletNode = new AudioWorkletNode(
      this.audioContext,
      "pcm-recorder-processor",
    );
    this.monitorNode = this.audioContext.createGain();
    this.monitorNode.gain.value = 0;

    this.workletNode.port.onmessage = (event: MessageEvent) => {
      const float32Data = event.data as Float32Array;
      const int16Data = this.float32ToInt16(float32Data);
      const pcmBuffer = new ArrayBuffer(int16Data.byteLength);
      new Int16Array(pcmBuffer).set(int16Data);
      this.onData?.(pcmBuffer);
    };

    this.source.connect(this.analyserNode);
    this.source.connect(this.workletNode);
    this.workletNode.connect(this.monitorNode);
    this.monitorNode.connect(this.audioContext.destination);
    await this.audioContext.resume();
    this.startLevelMonitoring();
  }

  stop(): void {
    if (this.throttleInterval !== null) {
      clearInterval(this.throttleInterval);
      this.throttleInterval = null;
    }
    if (this.analyserFrameId !== null) {
      cancelAnimationFrame(this.analyserFrameId);
      this.analyserFrameId = null;
    }
    this.onLevel?.(0);
    this.workletNode?.disconnect();
    this.monitorNode?.disconnect();
    this.analyserNode?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());

    if (this.audioContext?.state !== "closed") {
      void this.audioContext?.close();
    }

    this.workletNode = null;
    this.monitorNode = null;
    this.analyserNode = null;
    this.analyserData = null;
    this.source = null;
    this.stream = null;
    this.audioContext = null;
    this.onData = null;
    this.onLevel = null;
  }

  private float32ToInt16(float32: Float32Array): Int16Array {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  }

  get isRecording(): boolean {
    return this.audioContext !== null && this.audioContext.state === "running";
  }

  private startLevelMonitoring(): void {
    if (!this.analyserNode || !this.analyserData) return;

    let idleFrameCount = 0;
    const IDLE_THRESHOLD = 30;

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

          if (this.analyserFrameId !== null) {
            cancelAnimationFrame(this.analyserFrameId);
            this.analyserFrameId = null;
          }

          if (this.throttleInterval !== null) {
            return;
          }

          this.throttleInterval = setInterval(() => {
            computeLevel("interval");
          }, 100);
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
