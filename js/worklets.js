// AudioWorklet processors. Run on the audio thread.
// Packet format: [uint32 seq][int16 samples...], mono, 48 kHz.

class JamCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.seq = 0
    this.channel = 'mix' // 'left' | 'right' | 'mix'
    this.peak = 0
    this.quanta = 0
    this.port.onmessage = e => {
      if (e.data.channel) this.channel = e.data.channel
    }
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const left = input[0]
    const right = input[1] || left
    const n = left.length
    const packet = new ArrayBuffer(4 + n * 2)
    new DataView(packet).setUint32(0, this.seq++ >>> 0)
    const samples = new Int16Array(packet, 4)
    for (let i = 0; i < n; i++) {
      let v =
        this.channel === 'left' ? left[i] :
        this.channel === 'right' ? right[i] :
        (left[i] + right[i]) * 0.5
      if (v > 1) v = 1
      else if (v < -1) v = -1
      samples[i] = v * 32767
      const a = v < 0 ? -v : v
      if (a > this.peak) this.peak = a
    }
    this.port.postMessage(packet, [packet])
    if (++this.quanta >= 8) { // ~21 ms, for the level meter
      this.port.postMessage({level: this.peak})
      this.peak = 0
      this.quanta = 0
    }
    return true
  }
}

// One per remote peer: minimal jitter buffer feeding the output.
class JamPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.cap = 48000
    this.buf = new Float32Array(this.cap)
    this.read = 0
    this.write = 0
    this.size = 0
    this.target = 480 // samples to accumulate before (re)starting playback
    this.playing = false
    this.lastSeq = -1
    this.underruns = 0
    this.drops = 0
    this.lost = 0
    this.quanta = 0
    this.peak = 0
    this.port.onmessage = e => {
      if (e.data instanceof ArrayBuffer) this.push(e.data)
      else if (e.data.target !== undefined) this.target = e.data.target
    }
  }

  push(packet) {
    const seq = new DataView(packet).getUint32(0)
    if (this.lastSeq >= 0) {
      const delta = (seq - this.lastSeq) >>> 0
      if (delta === 0 || delta > 0x80000000) return // duplicate or late
      this.lost += delta - 1
    }
    this.lastSeq = seq
    const samples = new Int16Array(packet, 4)
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.write] = samples[i] / 32768
      this.write = (this.write + 1) % this.cap
    }
    this.size += samples.length
    if (this.size > this.cap) {
      this.read = this.write
      this.size = this.cap
    }
  }

  skip(n) {
    this.read = (this.read + n) % this.cap
    this.size -= n
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    const n = out.length

    if (!this.playing && this.size >= Math.max(this.target, n)) this.playing = true

    if (this.playing) {
      // Clock drift or a burst after a stall: cut back to the target.
      const max = this.target + Math.max(this.target, 4 * n)
      if (this.size > max) {
        this.skip(this.size - this.target)
        this.drops++
      }
      if (this.size >= n) {
        for (let i = 0; i < n; i++) {
          const v = this.buf[this.read]
          out[i] = v
          const a = v < 0 ? -v : v
          if (a > this.peak) this.peak = a
          this.read = (this.read + 1) % this.cap
        }
        this.size -= n
      } else {
        this.playing = false
        this.underruns++
      }
    }

    if (++this.quanta % 8 === 0) { // ~21 ms, for the level meter
      this.port.postMessage({level: this.peak})
      this.peak = 0
    }
    if (this.quanta >= 192) { // ~0.5 s
      this.port.postMessage({
        buffered: this.size,
        underruns: this.underruns,
        drops: this.drops,
        lost: this.lost
      })
      this.quanta = 0
    }
    return true
  }
}

registerProcessor('jam-capture', JamCapture)
registerProcessor('jam-player', JamPlayer)
