class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input)
      for (const value of input) {
        this.buffer[this.offset++] = value;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer);
          this.buffer = new Float32Array(1024);
          this.offset = 0;
        }
      }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
