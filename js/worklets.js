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

// One per remote peer: adaptive jitter buffer feeding the output.
// Packets are placed by sequence number, so reordered packets still fit and
// lost ones are concealed instead of shortening the stream. An underrun is
// concealed too and never waits for a refill. Every second the buffer looks
// at its lowest level and keeps it near the safety margin: a large excess is
// cut with a crossfade, a small one (and clock drift between the machines) is
// absorbed by resampling at most 0.05 % (under 1 cent, inaudible).
const CAP = 1 << 15 // ring size in samples (~680 ms)
const WINDOW = 375 // quanta per control step (~1 s)
const HISTORY = 3 // control steps whose minimum level is remembered
const MAX_RATE = 0.0005
const RESTART = 16 // late packets in a row: the sender restarted its count

class JamPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(CAP)
    this.last = new Float32Array(128) // newest packet, for loss concealment
    this.tail = new Float32Array(128) // last block played, for underruns
    this.margin = 96 // spare samples to keep at the worst moment (2 ms)
    this.underruns = 0
    this.lost = 0
    this.late = 0
    this.lateRun = 0
    this.trims = 0
    this.quanta = 0
    this.peak = 0
    this.reset()
    this.port.onmessage = e => {
      if (e.data instanceof ArrayBuffer) this.push(e.data)
      else if (e.data.margin !== undefined) this.margin = e.data.margin
    }
  }

  reset() {
    this.started = false
    this.lateRun = 0
    this.playing = false
    this.headSeq = 0
    this.head = 0 // absolute index just past the newest packet
    this.pos = 0 // absolute, fractional read position
    this.rate = 1
    this.skip = 0
    this.starve = 0
    this.hold = 0
    this.mins = []
    this.minSpare = Infinity
    this.sumLevel = 0
    this.counted = 0
  }

  push(packet) {
    const seq = new DataView(packet).getUint32(0)
    const samples = new Int16Array(packet, 4)
    const n = samples.length
    if (!this.started) {
      this.started = true
      this.headSeq = seq
      this.head = this.pos + n
      this.write(this.head - n, samples, true)
      return
    }
    const d = (seq - this.headSeq) | 0
    if (d > 0) {
      this.lateRun = 0
      if (this.head + d * n - this.pos > CAP - 2 * n) {
        this.reset()
        return this.push(packet)
      }
      if (d > 1) {
        this.conceal(this.head, (d - 1) * n)
        this.lost += d - 1
      }
      this.head += d * n
      this.headSeq = seq
      this.write(this.head - n, samples, true)
    } else if (d < 0) {
      // Arrived out of order: fill its slot if it hasn't been played yet.
      const at = this.head + (d - 1) * n
      if (at > this.pos + 4) {
        this.write(at, samples, false)
        this.lost--
        this.lateRun = 0
      } else if (++this.lateRun >= RESTART) {
        this.reset()
        this.push(packet)
      } else {
        this.late++
      }
    }
  }

  write(at, samples, newest) {
    const b = this.buf
    for (let i = 0; i < samples.length; i++) b[(at + i) % CAP] = samples[i] / 32768
    if (newest) for (let i = 0; i < 128; i++) this.last[i] = b[(at + i) % CAP]
  }

  // Missing packets: the previous packet mirrored in time (no jump at the
  // joint), faded out, then silence.
  conceal(at, len) {
    const b = this.buf
    for (let i = 0; i < len; i++) {
      b[(at + i) % CAP] = i < 128 ? this.last[127 - i] * (1 - i / 128) : 0
    }
  }

  // 4-point Hermite interpolation at absolute position x.
  sample(x) {
    const b = this.buf
    const i = Math.floor(x)
    const f = x - i
    if (f === 0) return b[i % CAP]
    const y0 = b[(i + CAP - 1) % CAP]
    const y1 = b[i % CAP]
    const y2 = b[(i + 1) % CAP]
    const y3 = b[(i + 2) % CAP]
    const c1 = 0.5 * (y2 - y0)
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
    return ((c3 * f + c2) * f + c1) * f + y1
  }

  render(out, n, spare) {
    const r = this.rate
    let p = this.pos
    const skip = Math.min(this.skip, Math.max(0, Math.floor(spare)))
    if (skip > 0) {
      // Jump ahead, crossfading the old and the new position over the block.
      let q = p + skip
      for (let i = 0; i < n; i++) {
        const w = (i + 1) / n
        out[i] = this.sample(p) * (1 - w) + this.sample(q) * w
        p += r
        q += r
      }
      p = q
      for (let k = 0; k < this.mins.length; k++) this.mins[k] -= skip
      this.minSpare -= skip
      this.trims++
    } else {
      for (let i = 0; i < n; i++) {
        out[i] = this.sample(p)
        p += r
      }
    }
    this.skip = 0
    this.pos = p
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    const n = out.length
    const level = this.head - this.pos

    if (!this.playing && this.started && level >= n + 3 + this.margin) {
      this.playing = true
      this.starve = 0
    }

    if (this.playing) {
      const spare = level - (n * this.rate + 3)
      if (spare >= 0) {
        this.render(out, n, spare)
        this.starve = 0
        if (spare < this.minSpare) this.minSpare = spare
        this.sumLevel += level
        this.counted++
      } else {
        // Nothing to play: conceal and let the incoming packets build up
        // a slightly bigger buffer, instead of going silent until a refill.
        if (this.starve === 0) {
          this.underruns++
          for (let i = 0; i < n; i++) out[i] = this.tail[n - 1 - i] * (1 - i / n)
        } else {
          out.fill(0)
        }
        this.minSpare = Math.min(this.minSpare, spare)
        this.hold = 3
        if (++this.starve > 40) this.playing = false // ~100 ms: sender stopped
      }
      this.tail.set(out)
    } else {
      out.fill(0)
    }

    for (let i = 0; i < n; i++) {
      const a = out[i] < 0 ? -out[i] : out[i]
      if (a > this.peak) this.peak = a
    }
    if (++this.quanta % 8 === 0) { // ~21 ms, for the level meter
      this.port.postMessage({level: this.peak})
      this.peak = 0
    }
    if (this.quanta >= WINDOW) this.control()
    return true
  }

  control() {
    this.quanta = 0
    if (this.counted > 0) {
      this.port.postMessage({
        buffered: this.sumLevel / this.counted,
        underruns: this.underruns,
        lost: Math.max(0, this.lost),
        late: this.late,
        trims: this.trims
      })
    }
    if (this.playing && this.minSpare !== Infinity) {
      this.mins.push(this.minSpare)
      if (this.mins.length > HISTORY) this.mins.shift()
      const excess = Math.min(...this.mins) - this.margin
      if (this.hold > 0) {
        this.hold--
        this.rate = excess < 0 ? 1 + Math.max(excess / (4 * sampleRate), -MAX_RATE) : 1
      } else if (excess > 256 && this.mins.length === HISTORY) {
        this.skip = Math.floor(excess)
        this.rate = 1
      } else {
        // Drain or build up the difference over ~4 s.
        this.rate = 1 + Math.max(-MAX_RATE, Math.min(MAX_RATE, excess / (4 * sampleRate)))
      }
    }
    this.minSpare = Infinity
    this.sumLevel = 0
    this.counted = 0
  }
}

registerProcessor('jam-capture', JamCapture)
registerProcessor('jam-player', JamPlayer)
