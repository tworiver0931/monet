/**
 * AudioWorklet processor for playing PCM audio.
 * Port of bidi-demo's pcm-player-processor.js.
 *
 * Maintains a ring buffer of Int16 samples received via port messages.
 * Converts Int16 to Float32 for output. Plays at 24kHz sample rate.
 */
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer: 24kHz * 180 seconds max
    this.bufferSize = 24000 * 180;
    this.startThreshold = Math.floor(24000 * 0.18);
    this.resumeThreshold = Math.floor(24000 * 0.12);
    this.buffer = new Int16Array(this.bufferSize);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.samplesAvailable = 0;
    this.isPlaying = false;
    this.hasStarted = false;
    this.lastReportedState = null;

    this.port.onmessage = (event) => {
      if (event.data === "endOfAudio") {
        this.writeIndex = 0;
        this.readIndex = 0;
        this.samplesAvailable = 0;
        this.isPlaying = false;
        this.hasStarted = false;
        this.reportPlaybackState(true);
        return;
      }

      const samples = event.data;
      for (let i = 0; i < samples.length; i++) {
        this.buffer[this.writeIndex] = samples[i];
        this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
      }
      this.samplesAvailable += samples.length;
      if (this.samplesAvailable > this.bufferSize) {
        this.samplesAvailable = this.bufferSize;
      }
    };
  }

  reportPlaybackState(force = false) {
    if (!force && this.lastReportedState === this.isPlaying) {
      return;
    }

    this.lastReportedState = this.isPlaying;
    this.port.postMessage({
      type: "playback-state",
      isPlaying: this.isPlaying,
    });
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel0 = output[0];
    channel0.fill(0);

    if (!this.isPlaying) {
      const threshold = this.hasStarted
        ? this.resumeThreshold
        : this.startThreshold;
      if (this.samplesAvailable < threshold) {
        if (output.length > 1) {
          output[1].set(channel0);
        }
        this.reportPlaybackState();
        return true;
      }

      this.isPlaying = true;
      this.hasStarted = true;
      this.reportPlaybackState();
    }

    for (let i = 0; i < channel0.length; i++) {
      if (this.samplesAvailable > 0) {
        channel0[i] = this.buffer[this.readIndex] / 32768;
        this.readIndex = (this.readIndex + 1) % this.bufferSize;
        this.samplesAvailable--;
      } else {
        this.isPlaying = false;
        this.reportPlaybackState();
        break;
      }
    }
    // Duplicate mono to stereo for robust playback across hardware
    if (output.length > 1) {
      output[1].set(channel0);
    }
    return true;
  }
}

registerProcessor("pcm-player-processor", PCMPlayerProcessor);
