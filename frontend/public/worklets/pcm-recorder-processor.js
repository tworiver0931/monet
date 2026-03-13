/**
 * AudioWorklet processor for recording PCM audio.
 * Port of bidi-demo's pcm-recorder-processor.js.
 *
 * Reads Float32 samples from the microphone input and buffers them
 * into ~100ms chunks (1600 samples at 16kHz) before posting to the
 * main thread for conversion to Int16 PCM.
 */
class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 1600; // ~100ms at 16kHz
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const samples = input[0];
      for (let i = 0; i < samples.length; i++) {
        this.buffer[this.writeIndex++] = samples[i];
        if (this.writeIndex >= this.bufferSize) {
          this.port.postMessage(this.buffer.slice(0));
          this.writeIndex = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-recorder-processor", PCMRecorderProcessor);
