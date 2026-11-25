// MIDI: read a local controller and play notes (local + remote) with sampled instruments.
import {SplendidGrandPiano, ElectricPiano, DrumMachine} from 'https://cdn.jsdelivr.net/npm/smplr@1.2.0/+esm'

export const INSTRUMENTS = [
  {id: 'piano', label: 'Piano de cauda'},
  {id: 'epiano', label: 'Piano elétrico'},
  {id: 'drums', label: 'Bateria (TR-808)'}
]

// General MIDI percussion note -> keywords to look for in the drum machine's group names.
const GM_DRUMS = {
  35: ['kick', 'bd'], 36: ['kick', 'bd'],
  37: ['rim', 'stick'], 38: ['snare', 'sd'], 40: ['snare', 'sd'], 39: ['clap'],
  42: ['hihat-close', 'closed', 'hh', 'hihat'], 44: ['hihat-close', 'closed', 'hh', 'hihat'],
  46: ['hihat-open', 'open', 'oh'],
  41: ['tom-low', 'lt', 'tom'], 43: ['tom-low', 'lt', 'tom'], 45: ['tom-mid', 'mt', 'tom'],
  47: ['tom-mid', 'mt', 'tom'], 48: ['tom-hi', 'ht', 'tom'], 50: ['tom-hi', 'ht', 'tom'],
  49: ['crash', 'cymbal', 'cy'], 57: ['crash', 'cymbal', 'cy'],
  51: ['ride', 'cymbal', 'cy'], 59: ['ride', 'cymbal', 'cy'],
  56: ['cowbell', 'cb'], 54: ['tamb', 'maraca', 'ma'], 75: ['clave', 'cl']
}

export class MidiEngine {
  constructor(ctx) {
    this.ctx = ctx
    this.synths = {}
    this.drumMap = null
    this.access = null
    this.input = null
    this.onMessage = () => {}
  }

  synth(id) {
    if (this.synths[id]) return this.synths[id]
    const ctx = this.ctx
    const s =
      id === 'epiano' ? ElectricPiano(ctx, {instrument: 'CP80'}) :
      id === 'drums' ? DrumMachine(ctx, {instrument: 'TR-808'}) :
      SplendidGrandPiano(ctx)
    this.synths[id] = s
    if (id === 'drums') s.ready.then(() => { this.drumMap = buildDrumMap(s.getGroupNames()) })
    return s
  }

  // Play a raw MIDI message [status, d1, d2] on the given instrument.
  play(instrument, status, d1, d2, volume = 1) {
    const s = this.synth(instrument)
    const cmd = status & 0xf0
    if (cmd === 0x90 && d2 > 0) {
      const velocity = Math.max(1, Math.round(d2 * volume))
      if (instrument === 'drums') {
        const group = this.drumMap?.[d1]
        if (group) s.start({note: group, velocity})
      } else {
        s.start({note: d1, velocity})
      }
    } else if (cmd === 0x80 || cmd === 0x90) {
      if (instrument !== 'drums') s.stop(d1)
    } else if (cmd === 0xb0) {
      s.setCC?.(d1, d2)
    }
  }

  async init() {
    if (!navigator.requestMIDIAccess) return []
    this.access = await navigator.requestMIDIAccess()
    return [...this.access.inputs.values()]
  }

  setInput(id) {
    if (this.input) this.input.onmidimessage = null
    this.input = id ? this.access?.inputs.get(id) : null
    if (!this.input) return
    this.input.onmidimessage = e => {
      const [status, d1 = 0, d2 = 0] = e.data
      const cmd = status & 0xf0
      if (cmd === 0x80 || cmd === 0x90 || cmd === 0xb0) this.onMessage(status, d1, d2)
    }
  }
}

function buildDrumMap(groups) {
  const map = {}
  for (const [note, keywords] of Object.entries(GM_DRUMS)) {
    for (const k of keywords) {
      const g = groups.find(g => g.toLowerCase().includes(k))
      if (g) { map[note] = g; break }
    }
  }
  return map
}
