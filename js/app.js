import {joinRoom} from 'https://cdn.jsdelivr.net/npm/trystero@0.27.0/+esm'
import {AudioEngine, SAMPLE_RATE, isVirtualCable} from './audio.js'
import {MidiEngine, INSTRUMENTS} from './midi.js'

const APP_ID = 'github.com/HugoFreitass/online-jam'
// Extra data channels negotiated directly on Trystero's RTCPeerConnection.
// Fixed ids so both sides open the same channel without renegotiating.
const AUDIO_CHANNEL_ID = 500
const MIDI_CHANNEL_ID = 501
// Drop audio instead of queueing behind congestion: at most ~6 packets (16 ms).
const MAX_BUFFERED = 6 * (4 + 128 * 2)
const QUANTUM_MS = 128 / SAMPLE_RATE * 1000
const LED_MS = 90

const ROLE_ICONS = {Guitarra: '🎸', 'Violão': '🎸', Baixo: '🎸', Voz: '🎤', Bateria: '🥁', Teclado: '🎹', Outro: '🎵'}
const MIDI_ICONS = {piano: '🎹', epiano: '🎹', drums: '🥁'}

const $ = sel => document.querySelector(sel)
const audio = new AudioEngine()
let midi = null
let room = null
let profile = null
let myName = ''
let myUserId = ''
const peers = new Map() // peerId -> {userId, audioCh, midiCh, el, rtt, stats, volume, muted, meter, led}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('jam:' + k)) } catch { return null } },
  set(k, v) { try { localStorage.setItem('jam:' + k, JSON.stringify(v)) } catch {} }
}
const settings = {channel: 'mix', role: '', midiInstrument: 'piano', marginMs: 2, monitor: false, inputLabel: '', ...store.get('settings')}
const saveSettings = patch => { Object.assign(settings, patch); store.set('settings', settings) }

// ---------- level meters & MIDI LEDs (one rAF loop for everything) ----------

const meters = new Set() // {el, level, shown}
const leds = new Set() // {el, hit, on}

function makeMeter(el) {
  const m = {el, level: 0, shown: -1}
  meters.add(m)
  return m
}
function makeLed(el) {
  const l = {el, hit: 0, on: false}
  leds.add(l)
  return l
}

// Peak (0..1) -> meter position on a -60..0 dB scale.
const toMeter = peak => peak <= 0.001 ? 0 : Math.min(1, 1 + Math.log10(peak) / 3)

function animate(now) {
  for (const m of meters) {
    const target = toMeter(m.level)
    const next = target > m.shown ? target : m.shown * 0.9 + target * 0.1
    m.level = 0
    if (Math.abs(next - m.shown) > 0.004) {
      m.shown = next
      m.el.style.transform = `scaleX(${1 - next})`
    }
  }
  for (const l of leds) {
    const on = now - l.hit < LED_MS
    if (on !== l.on) l.el.classList.toggle('on', l.on = on)
  }
  requestAnimationFrame(animate)
}

const myMeter = makeMeter($('#level'))
const myLed = makeLed($('#me-led'))

// ---------- join ----------

const params = new URLSearchParams(location.search)
$('#room').value = params.get('sala') || ''
$('#name').value = store.get('name') || ''

$('#join-form').addEventListener('submit', async e => {
  e.preventDefault()
  myName = $('#name').value.trim() || 'Anônimo'
  const roomName = $('#room').value.trim()
  const password = $('#password').value
  if (!roomName) return
  store.set('name', myName)
  $('#join-btn').disabled = true
  $('#join-btn').textContent = 'Preparando áudio…'
  try {
    await audio.start()
    midi = new MidiEngine(audio.ctx)
    await setupInputs()
    await enterRoom(roomName, password)
  } catch (err) {
    console.error(err)
    $('#join-error').textContent = 'Erro ao iniciar: ' + err.message
    $('#join-btn').disabled = false
    $('#join-btn').textContent = 'Entrar na sala'
  }
})

async function enterRoom(roomName, password) {
  room = joinRoom({appId: APP_ID, identity: 'none', ...(password && {password})}, roomName)
  const initial = {name: myName, instrument: null, role: settings.role}
  profile = room.makeUserState('profile', initial)
  profile.onChange(() => { for (const id of peers.keys()) renderPeerInfo(id) })
  profile.set(initial) // the initial value isn't published until set
  updateInstrument()

  room.onPeerJoin(({peerId, userId}) => connectPeer(peerId, userId))
  room.onPeerLeave(({peerId}) => disconnectPeer(peerId))
  room.onError(err => toast('Erro: ' + (err.message || err.code)))

  myUserId = (await room.getSelf()).userId
  history.replaceState(null, '', '?sala=' + encodeURIComponent(roomName))
  $('#room-name').textContent = roomName
  $('#join').hidden = true
  $('#studio').hidden = false
  renderMe()
  renderRoomState()
  setInterval(pingPeers, 2000)
  setInterval(renderLocalLatency, 2000)
  renderLocalLatency()
  requestAnimationFrame(animate)
}

// ---------- local inputs ----------

async function setupInputs() {
  // Ask permission once so device labels are visible.
  try {
    const s = await navigator.mediaDevices.getUserMedia({audio: true})
    s.getTracks().forEach(t => t.stop())
  } catch {}
  await refreshInputs()
  navigator.mediaDevices.addEventListener('devicechange', refreshInputs)

  const midiInputs = await midi.init().catch(() => [])
  const midiSel = $('#midi-input')
  if (!navigator.requestMIDIAccess) {
    midiSel.innerHTML = '<option value="">Navegador sem Web MIDI</option>'
  } else {
    midiSel.innerHTML = '<option value="">Nenhum</option>' +
      midiInputs.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('')
    $('#midi-info').textContent = midiInputs.length ? '' : 'Nenhum controlador MIDI encontrado. Conecte e recarregue a página.'
  }
  $('#midi-instrument').innerHTML = INSTRUMENTS.map(i => `<option value="${i.id}">${i.label}</option>`).join('')
  $('#midi-instrument').value = settings.midiInstrument

  $('#audio-role').value = settings.role
  $('#audio-channel').value = settings.channel
  $('#monitor').checked = settings.monitor
  $('#buffer').value = settings.marginMs
  setMargin(settings.marginMs)

  audio.onPacket = packet => {
    for (const p of peers.values()) {
      const ch = p.audioCh
      if (ch.readyState === 'open' && ch.bufferedAmount < MAX_BUFFERED) ch.send(packet)
    }
  }
  audio.onLevel = level => { if (level > myMeter.level) myMeter.level = level }

  midi.onMessage = (status, d1, d2) => {
    const instrument = $('#midi-instrument').value
    if ($('#midi-local').checked) midi.play(instrument, status, d1, d2)
    if ((status & 0xf0) === 0x90 && d2 > 0) myLed.hit = performance.now()
    const msg = new Uint8Array([INSTRUMENTS.findIndex(i => i.id === instrument), status, d1, d2])
    for (const p of peers.values()) {
      if (p.midiCh.readyState === 'open') p.midiCh.send(msg)
    }
  }

  // Reopen the input used last time.
  const sel = $('#audio-input')
  const saved = [...sel.options].find(o => o.value && o.dataset.label === settings.inputLabel)
  if (saved) {
    sel.value = saved.value
    await openInput()
  }
}

async function refreshInputs() {
  const inputs = await AudioEngine.listInputs()
  const sel = $('#audio-input')
  const current = sel.value
  sel.innerHTML = '<option value="">Nenhum (não enviar áudio)</option>' +
    inputs.map(d => {
      const label = d.label || 'Entrada ' + d.deviceId.slice(0, 6)
      return `<option value="${esc(d.deviceId)}" data-label="${esc(d.label)}">${d.virtual ? '🎛 ' : ''}${esc(label)}</option>`
    }).join('')
  if ([...sel.options].some(o => o.value === current)) sel.value = current

  const cable = findCable(inputs)
  $('#rig-box').hidden = !cable
  if (cable) $('#rig-device').textContent = cable.label
}

// Prefer Voicemeeter's B1 bus, then VB-Cable's output, then any virtual device.
function findCable(inputs) {
  // Skip Windows' "Default"/"Communications" aliases when the real device is listed.
  const virtual = inputs.filter(d => d.virtual && d.deviceId !== 'default' && d.deviceId !== 'communications')
  return virtual.find(d => /voicemeeter.*b1|out b1/i.test(d.label)) ||
    virtual.find(d => /cable output/i.test(d.label)) ||
    virtual[0]
}

async function openInput() {
  const sel = $('#audio-input')
  const option = sel.selectedOptions[0]
  const label = option?.dataset.label || ''
  saveSettings({inputLabel: sel.value ? label : ''})
  const info = $('#input-info')
  info.textContent = ''
  info.className = 'hint'
  try {
    const s = await audio.setInput(sel.value, $('#audio-channel').value)
    audio.setMonitor($('#monitor').checked)
    profile?.set(prev => ({...prev, inputMs: audio.inputLatency * 1000}))
    if (!s) return
    const parts = []
    if (s.sampleRate) parts.push(`${s.sampleRate} Hz`)
    if (s.channelCount) parts.push(s.channelCount === 1 ? 'mono' : `${s.channelCount} canais`)
    info.textContent = 'Entrada: ' + parts.join(', ')
    if (s.sampleRate && s.sampleRate !== SAMPLE_RATE) {
      info.textContent += `. Coloque este dispositivo${isVirtualCable(label) ? ' (e o Guitar Rig)' : ''} em 48000 Hz para evitar atraso extra.`
      info.classList.add('warn')
    }
  } catch (err) {
    info.textContent = 'Não consegui abrir a entrada: ' + err.message
    info.classList.add('warn')
  }
}

$('#audio-input').addEventListener('change', openInput)
$('#audio-channel').addEventListener('change', e => {
  saveSettings({channel: e.target.value})
  audio.setChannel(e.target.value)
})
$('#monitor').addEventListener('change', e => {
  saveSettings({monitor: e.target.checked})
  audio.setMonitor(e.target.checked)
})
$('#audio-role').addEventListener('change', e => {
  saveSettings({role: e.target.value})
  profile?.set(prev => ({...prev, role: e.target.value}))
  renderMe()
})

$('#rig-btn').addEventListener('click', async () => {
  const inputs = await AudioEngine.listInputs()
  const cable = findCable(inputs)
  if (!cable) return
  const sel = $('#audio-input')
  sel.value = cable.deviceId
  // Guitar Rig already outputs a finished stereo mix.
  $('#audio-channel').value = 'mix'
  saveSettings({channel: 'mix'})
  // VB-Cable alone: you can only hear yourself through the browser.
  // Voicemeeter: it already monitors to your headphones.
  const monitor = !/voicemeeter/i.test(cable.label)
  $('#monitor').checked = monitor
  saveSettings({monitor})
  if (!$('#audio-role').value) {
    $('#audio-role').value = 'Guitarra'
    $('#audio-role').dispatchEvent(new Event('change'))
  }
  await openInput()
  toast('Guitar Rig conectado via ' + cable.label)
})

$('#midi-input').addEventListener('change', e => {
  midi.setInput(e.target.value)
  updateInstrument()
})
$('#midi-instrument').addEventListener('change', e => {
  saveSettings({midiInstrument: e.target.value})
  updateInstrument()
})

function updateInstrument() {
  const instrument = $('#midi-input').value ? $('#midi-instrument').value : null
  if (instrument) loadSynth(instrument, $('#midi-info'))
  profile?.set(prev => ({...prev, instrument}))
  renderMe()
}

function loadSynth(id, infoEl) {
  const s = midi.synth(id)
  if (!infoEl) return
  const label = INSTRUMENTS.find(i => i.id === id)?.label
  infoEl.textContent = `Carregando ${label}…`
  s.ready.then(() => { infoEl.textContent = `${label} pronto.` }, () => { infoEl.textContent = `Falha ao carregar ${label}.` })
}

function setMargin(ms) {
  $('#buffer-value').textContent = ms + ' ms'
  audio.setMarginMs(ms)
}
$('#buffer').addEventListener('input', e => {
  const ms = Number(e.target.value)
  saveSettings({marginMs: ms})
  setMargin(ms)
})

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(location.href)
    toast('Link copiado! Mande pra banda.')
  } catch {
    toast(location.href)
  }
}
$('#invite').addEventListener('click', copyInvite)
$('#invite-empty').addEventListener('click', copyInvite)

// ---------- peers ----------

async function connectPeer(peerId, userId) {
  disconnectPeer(peerId)
  const pc = await waitForConnection(peerId)
  if (!pc) {
    toast('Sem conexão direta com um músico (rede bloqueando P2P?)')
    return
  }

  const audioCh = pc.createDataChannel('jam-audio', {
    negotiated: true, id: AUDIO_CHANNEL_ID, ordered: false, maxRetransmits: 0
  })
  const midiCh = pc.createDataChannel('jam-midi', {
    negotiated: true, id: MIDI_CHANNEL_ID, ordered: false
  })
  audioCh.binaryType = midiCh.binaryType = 'arraybuffer'

  const peer = {userId, audioCh, midiCh, rtt: null, stats: null, volume: 1, muted: false}
  peer.el = createStrip(peerId, peer)
  peer.meter = makeMeter(peer.el.querySelector('.meter-mask'))
  peer.led = makeLed(peer.el.querySelector('.led'))
  peers.set(peerId, peer)

  audio.addPeer(peerId, data => {
    if (data.level !== undefined) {
      if (data.level > peer.meter.level) peer.meter.level = data.level
    } else {
      peer.stats = data
      renderPeerStats(peerId)
    }
  })
  audioCh.onmessage = e => audio.receive(peerId, e.data)
  midiCh.onmessage = e => {
    const [idx, status, d1, d2] = new Uint8Array(e.data)
    const instrument = INSTRUMENTS[idx]?.id
    if (!instrument) return
    if ((status & 0xf0) === 0x90 && d2 > 0) peer.led.hit = performance.now()
    if (!peer.muted) midi.play(instrument, status, d1, d2, peer.volume)
  }
  audioCh.onopen = audioCh.onclose = () => renderPeerStats(peerId)

  renderPeerInfo(peerId)
  renderRoomState()
}

async function waitForConnection(peerId) {
  for (let i = 0; i < 50; i++) {
    const pc = room.getPeers()[peerId]?.connection
    if (pc) return pc
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}

function disconnectPeer(peerId) {
  const p = peers.get(peerId)
  if (!p) return
  p.audioCh.close()
  p.midiCh.close()
  audio.removePeer(peerId)
  meters.delete(p.meter)
  leds.delete(p.led)
  p.el.remove()
  peers.delete(peerId)
  renderRoomState()
}

function pingPeers() {
  for (const [peerId, p] of peers) {
    room.ping(peerId).then(rtt => { p.rtt = rtt; renderPeerStats(peerId) }).catch(() => {})
  }
}

// ---------- rendering ----------

function createStrip(peerId, p) {
  const el = document.createElement('article')
  el.className = 'strip'
  el.style.setProperty('--hue', hue(p.userId))
  el.innerHTML = `
    <div class="strip-head">
      <div class="avatar" style="--hue:${hue(p.userId)}"><span class="initials"></span><span class="badge"></span></div>
      <div class="who"><strong class="name">Conectando…</strong><span class="tag"></span></div>
      <span class="led" title="Atividade MIDI"></span>
    </div>
    <div class="lat"><span class="lat-num">--</span><span class="lat-unit">ms</span><span class="lat-label">atraso</span></div>
    <div class="meter"><div class="meter-mask"></div></div>
    <div class="fader-row">
      <input type="range" min="0" max="1.5" step="0.01" value="1" aria-label="Volume">
      <button type="button" class="mute" aria-pressed="false">Mutar</button>
    </div>
    <div class="stats"></div>`
  el.querySelector('input').addEventListener('input', e => {
    p.volume = Number(e.target.value)
    audio.setPeerVolume(peerId, p.muted ? 0 : p.volume)
  })
  el.querySelector('.mute').addEventListener('click', e => {
    p.muted = !p.muted
    audio.setPeerVolume(peerId, p.muted ? 0 : p.volume)
    e.target.setAttribute('aria-pressed', p.muted)
    e.target.textContent = p.muted ? 'Mudo' : 'Mutar'
    el.classList.toggle('muted', p.muted)
  })
  $('#peers').append(el)
  return el
}

function renderPeerInfo(peerId) {
  const p = peers.get(peerId)
  if (!p) return
  const info = profile?.get(p.userId) || {}
  const name = info.name || 'Conectando…'
  p.el.querySelector('.name').textContent = name
  p.el.querySelector('.initials').textContent = initials(info.name)
  p.el.querySelector('.badge').textContent = icon(info)
  p.el.querySelector('.tag').textContent = tagText(info) || 'Sem instrumento'
  if (info.instrument) loadSynth(info.instrument)
}

function renderPeerStats(peerId) {
  const p = peers.get(peerId)
  if (!p) return
  const lat = p.el.querySelector('.lat')
  const stats = []
  if (p.rtt != null) stats.push(`ping ${p.rtt.toFixed(0)} ms`)
  if (p.stats) {
    const bufferMs = p.stats.buffered / SAMPLE_RATE * 1000
    stats.push(`buffer ${bufferMs.toFixed(1)} ms`)
    stats.push(`<span class="${p.stats.underruns ? 'warn' : ''}">falhas ${p.stats.underruns}</span>`)
    stats.push(`<span class="${p.stats.lost ? 'warn' : ''}">perdidos ${p.stats.lost}</span>`)
    if (p.stats.late) stats.push(`<span class="warn">atrasados ${p.stats.late}</span>`)
  }
  if (p.rtt != null) {
    // Their input + capture block + network one-way + jitter buffer + this machine's output.
    const inputMs = profile?.get(p.userId)?.inputMs || 0
    const bufferMs = p.stats ? p.stats.buffered / SAMPLE_RATE * 1000 : audio.marginMs + QUANTUM_MS
    const total = inputMs + QUANTUM_MS + p.rtt / 2 + bufferMs + audio.localLatency * 1000
    lat.querySelector('.lat-num').textContent = total.toFixed(0)
    lat.className = 'lat ' + (total < 25 ? 'ok' : total < 40 ? 'mid' : 'bad')
  }
  if (p.audioCh.readyState !== 'open') stats.push(p.audioCh.readyState === 'connecting' ? 'conectando…' : 'desconectado')
  p.el.querySelector('.stats').innerHTML = stats.map(s => `<span>${s}</span>`).join('')
}

function renderMe() {
  const info = {name: myName, role: $('#audio-role').value, instrument: $('#midi-input').value ? $('#midi-instrument').value : null}
  $('#me-name').textContent = myName
  $('#me-avatar').style.setProperty('--hue', hue(myUserId))
  $('#me-initials').textContent = initials(myName)
  $('#me-badge').textContent = icon(info)
  $('#me-tag').textContent = 'Você' + (tagText(info) ? ' · ' + tagText(info) : '')
}

function renderRoomState() {
  const n = peers.size + 1
  $('#peer-count').textContent = `${n} ${n === 1 ? 'músico' : 'músicos'}`
  $('#room-dot').classList.toggle('live', peers.size > 0)
  $('#empty').hidden = peers.size > 0
}

function renderLocalLatency() {
  const ms = audio.localLatency * 1000
  $('#local-latency').textContent = `Saída de áudio deste computador: ${ms.toFixed(1)} ms`
}

let toastTimer
function toast(text) {
  const el = $('#toast')
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500)
}

function tagText(info) {
  const midiLabel = INSTRUMENTS.find(i => i.id === info.instrument)?.label
  return [info.role, midiLabel && 'MIDI: ' + midiLabel].filter(Boolean).join(' · ')
}

function icon(info) {
  if (info.role) return ROLE_ICONS[info.role] || '🎵'
  if (info.instrument) return MIDI_ICONS[info.instrument] || '🎸'
  return ''
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

function hue(id) {
  let h = 0
  for (const c of id || '') h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 360
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]))
}
