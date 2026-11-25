// Audio engine: local capture -> packets, and per-peer playback nodes.

export const SAMPLE_RATE = 48000

// VB-Audio Virtual Cable, Voicemeeter, BlackHole (macOS), Loopback, etc.
export const isVirtualCable = label =>
  /cable|vb-audio|voicemeeter|blackhole|loopback|soundflower|virtual/i.test(label || '')

export class AudioEngine {
  constructor() {
    this.ctx = null
    this.stream = null
    this.source = null
    this.capture = null
    this.monitor = null
    this.players = new Map() // peerId -> {node, gain, stats}
    this.marginMs = 2
    this.onPacket = () => {}
    this.onLevel = () => {}
  }

  async start() {
    if (this.ctx) return
    this.ctx = new AudioContext({sampleRate: SAMPLE_RATE, latencyHint: 0})
    await this.ctx.audioWorklet.addModule(new URL('./worklets.js', import.meta.url))
    await this.ctx.resume()
    this.monitor = this.ctx.createGain()
    this.monitor.gain.value = 0
    this.monitor.connect(this.ctx.destination)
  }

  // Output latency of this machine (seconds), as reported by the browser.
  get localLatency() {
    if (!this.ctx) return 0
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)
  }

  // Input latency of this machine (seconds): the capture buffer the browser
  // reports for the open input, plus one render quantum.
  get inputLatency() {
    if (!this.stream || !this.ctx) return 0
    const settings = this.stream.getAudioTracks()[0]?.getSettings() || {}
    return (settings.latency || 0) + (this.ctx.baseLatency || 0)
  }

  // Audio inputs, virtual cables (Guitar Rig, DAWs…) first.
  static async listInputs() {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter(d => d.kind === 'audioinput')
      .map(d => ({deviceId: d.deviceId, label: d.label, virtual: isVirtualCable(d.label)}))
      .sort((a, b) => b.virtual - a.virtual)
  }

  async setInput(deviceId, channel) {
    this.stopInput()
    if (!deviceId) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: {exact: deviceId},
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: {ideal: 2},
        sampleRate: SAMPLE_RATE,
        latency: 0
      }
    })
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.capture = new AudioWorkletNode(this.ctx, 'jam-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit'
    })
    this.capture.port.onmessage = e => {
      if (e.data instanceof ArrayBuffer) this.onPacket(e.data)
      else this.onLevel(e.data.level)
    }
    this.setChannel(channel)
    this.source.connect(this.capture)
    this.source.connect(this.monitor)
    // Must reach the destination to be pulled; it only outputs silence.
    this.capture.connect(this.ctx.destination)
    return this.stream.getAudioTracks()[0].getSettings()
  }

  setChannel(channel) {
    this.capture?.port.postMessage({channel})
  }

  setMonitor(on) {
    if (this.monitor) this.monitor.gain.value = on ? 1 : 0
  }

  stopInput() {
    this.source?.disconnect()
    this.capture?.disconnect()
    this.capture?.port.close()
    this.stream?.getTracks().forEach(t => t.stop())
    this.source = this.capture = this.stream = null
  }

  addPeer(peerId, onStats) {
    if (this.players.has(peerId)) return this.players.get(peerId)
    const node = new AudioWorkletNode(this.ctx, 'jam-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    })
    const gain = this.ctx.createGain()
    node.connect(gain).connect(this.ctx.destination)
    node.port.postMessage({margin: Math.round(this.marginMs * SAMPLE_RATE / 1000)})
    node.port.onmessage = e => onStats(e.data)
    const player = {node, gain}
    this.players.set(peerId, player)
    return player
  }

  receive(peerId, packet) {
    this.players.get(peerId)?.node.port.postMessage(packet, [packet])
  }

  setPeerVolume(peerId, value) {
    const p = this.players.get(peerId)
    if (p) p.gain.gain.value = value
  }

  // Spare buffer each player keeps at its worst moment, on top of the jitter
  // it measures by itself.
  setMarginMs(ms) {
    this.marginMs = ms
    const margin = Math.round(ms * SAMPLE_RATE / 1000)
    for (const {node} of this.players.values()) node.port.postMessage({margin})
  }

  removePeer(peerId) {
    const p = this.players.get(peerId)
    if (!p) return
    p.node.disconnect()
    p.gain.disconnect()
    p.node.port.close()
    this.players.delete(peerId)
  }
}
