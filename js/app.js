import {joinRoom} from 'https://cdn.jsdelivr.net/npm/trystero@0.27.0/+esm'
import {AudioEngine, SAMPLE_RATE} from './audio.js'
import {MidiEngine, INSTRUMENTS} from './midi.js'

const APP_ID = 'github.com/HugoFreitass/online-jam'
// Extra data channels negotiated directly on Trystero's RTCPeerConnection.
// Fixed ids so both sides open the same channel without renegotiating.
const AUDIO_CHANNEL_ID = 500
const MIDI_CHANNEL_ID = 501
const MAX_BUFFERED = 8 * 1024 // drop audio instead of queueing behind congestion
const QUANTUM_MS = 128 / SAMPLE_RATE * 1000

const $ = sel => document.querySelector(sel)
const audio = new AudioEngine()
let midi = null
let room = null
let profile = null
const peers = new Map() // peerId -> {userId, audioCh, midiCh, card, rtt, stats, volume, muted}

const store = {
  get: k => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch {} }
}

// ---------- join ----------

const params = new URLSearchParams(location.search)
$('#room').value = params.get('sala') || ''
$('#name').value = store.get('jam:name') || ''

$('#join-form').addEventListener('submit', async e => {
  e.preventDefault()
  const name = $('#name').value.trim() || 'Anônimo'
  const roomName = $('#room').value.trim()
  const password = $('#password').value
  if (!roomName) return
  store.set('jam:name', name)
  $('#join-btn').disabled = true
  try {
    await audio.start()
    midi = new MidiEngine(audio.ctx)
    await setupInputs()
    enterRoom(name, roomName, password)
  } catch (err) {
    console.error(err)
    $('#join-error').textContent = 'Erro ao iniciar: ' + err.message
    $('#join-btn').disabled = false
  }
})

function enterRoom(name, roomName, password) {
  room = joinRoom({appId: APP_ID, identity: 'none', ...(password && {password})}, roomName)
  profile = room.makeUserState('profile', {name, instrument: null, role: ''})
  profile.onChange(() => renderPeers())
  profile.set({name, instrument: null, role: ''}) // the initial value isn't published until set

  room.onPeerJoin(({peerId, userId}) => connectPeer(peerId, userId))
  room.onPeerLeave(({peerId}) => disconnectPeer(peerId))
  room.onError(err => setStatus('Erro: ' + (err.message || err.code)))

  history.replaceState(null, '', '?sala=' + encodeURIComponent(roomName))
  $('#room-name').textContent = roomName
  $('#join').hidden = true
  $('#studio').hidden = false
  setStatus('Procurando outros músicos na sala…')
  setInterval(pingPeers, 2000)
  setInterval(renderLocalInfo, 1000)
  renderLocalInfo()
}

// ---------- local inputs ----------

async function setupInputs() {
  // Ask permission once so device labels are visible.
  try {
    const s = await navigator.mediaDevices.getUserMedia({audio: true})
    s.getTracks().forEach(t => t.stop())
  } catch {}
  const inputs = await AudioEngine.listInputs()
  const sel = $('#audio-input')
  sel.innerHTML = '<option value="">Nenhum (não enviar áudio)</option>' +
    inputs.map(d => `<option value="${d.deviceId}">${esc(d.label || 'Entrada ' + d.deviceId.slice(0, 6))}</option>`).join('')

  const midiInputs = await midi.init().catch(() => [])
  const midiSel = $('#midi-input')
  midiSel.innerHTML = '<option value="">Nenhum</option>' +
    midiInputs.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')
  if (!navigator.requestMIDIAccess) midiSel.innerHTML = '<option value="">Navegador sem Web MIDI</option>'

  $('#midi-instrument').innerHTML = INSTRUMENTS.map(i => `<option value="${i.id}">${i.label}</option>`).join('')

  audio.onPacket = packet => {
    for (const p of peers.values()) {
      const ch = p.audioCh
      if (ch?.readyState === 'open' && ch.bufferedAmount < MAX_BUFFERED) ch.send(packet)
    }
  }
  audio.onLevel = level => {
    $('#level').style.width = Math.min(100, level * 100) + '%'
    $('#level').classList.toggle('clip', level >= 0.99)
  }

  midi.onMessage = (status, d1, d2) => {
    const instrument = $('#midi-instrument').value
    if ($('#midi-local').checked) midi.play(instrument, status, d1, d2)
    const msg = new Uint8Array([INSTRUMENTS.findIndex(i => i.id === instrument), status, d1, d2])
    for (const p of peers.values()) {
      if (p.midiCh?.readyState === 'open') p.midiCh.send(msg)
    }
  }
}

$('#audio-input').addEventListener('change', async e => {
  try {
    await audio.setInput(e.target.value, $('#audio-channel').value)
    audio.setMonitor($('#monitor').checked)
  } catch (err) {
    setStatus('Não consegui abrir a entrada: ' + err.message)
  }
})
$('#audio-channel').addEventListener('change', e => audio.setChannel(e.target.value))
$('#audio-role').addEventListener('change', e => profile?.set(prev => ({...prev, role: e.target.value})))
$('#monitor').addEventListener('change', e => audio.setMonitor(e.target.checked))

$('#midi-input').addEventListener('change', e => {
  midi.setInput(e.target.value)
  updateInstrument()
})
$('#midi-instrument').addEventListener('change', updateInstrument)

function updateInstrument() {
  const instrument = $('#midi-input').value ? $('#midi-instrument').value : null
  if (instrument) midi.synth(instrument)
  profile?.set(prev => ({...prev, instrument}))
}

$('#buffer').addEventListener('input', e => {
  const ms = Number(e.target.value)
  $('#buffer-value').textContent = ms + ' ms'
  audio.setTargetMs(ms)
})

$('#invite').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href)
    setStatus('Link copiado!')
  } catch {
    setStatus('Link: ' + location.href)
  }
})

// ---------- peers ----------

async function connectPeer(peerId, userId) {
  disconnectPeer(peerId)
  const pc = await waitForConnection(peerId)
  if (!pc) {
    setStatus('Sem conexão direta com um músico (rede bloqueando P2P?)')
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
  peers.set(peerId, peer)

  audio.addPeer(peerId, stats => { peer.stats = stats; renderPeer(peerId) })
  audioCh.onmessage = e => audio.receive(peerId, e.data)
  midiCh.onmessage = e => {
    const [idx, status, d1, d2] = new Uint8Array(e.data)
    const instrument = INSTRUMENTS[idx]?.id
    if (instrument && !peer.muted) midi.play(instrument, status, d1, d2, peer.volume)
  }

  renderPeers()
  setStatus('')
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
  peers.delete(peerId)
  renderPeers()
}

async function pingPeers() {
  for (const [peerId, p] of peers) {
    room.ping(peerId).then(rtt => { p.rtt = rtt; renderPeer(peerId) }).catch(() => {})
  }
}

// ---------- rendering ----------

function renderPeers() {
  const list = $('#peers')
  const all = profile?.getAll() || {}
  if (peers.size === 0) {
    list.innerHTML = '<p class="empty">Ninguém aqui ainda. Mande o link da sala.</p>'
    return
  }
  list.innerHTML = ''
  for (const [peerId, p] of peers) {
    const info = all[p.userId] || {}
    const card = document.createElement('div')
    card.className = 'peer'
    card.id = 'peer-' + peerId
    card.innerHTML = `
      <div class="peer-head">
        <strong>${esc(info.name || 'Conectando…')}</strong>
        <span class="tag">${esc(peerTag(info))}</span>
      </div>
      <div class="peer-stats"></div>
      <div class="peer-controls">
        <input type="range" min="0" max="1.5" step="0.01" value="${p.volume}" aria-label="Volume">
        <button type="button" class="mute">${p.muted ? 'Ativar som' : 'Mutar'}</button>
      </div>`
    card.querySelector('input').addEventListener('input', e => {
      p.volume = Number(e.target.value)
      audio.setPeerVolume(peerId, p.muted ? 0 : p.volume)
    })
    card.querySelector('.mute').addEventListener('click', e => {
      p.muted = !p.muted
      audio.setPeerVolume(peerId, p.muted ? 0 : p.volume)
      e.target.textContent = p.muted ? 'Ativar som' : 'Mutar'
    })
    list.append(card)
    if (info.instrument) midi.synth(info.instrument)
    renderPeer(peerId)
  }
}

function peerTag(info) {
  const midiLabel = INSTRUMENTS.find(i => i.id === info.instrument)?.label
  return [info.role, midiLabel && 'MIDI: ' + midiLabel].filter(Boolean).join(' · ')
}

function renderPeer(peerId) {
  const p = peers.get(peerId)
  const el = document.querySelector(`#peer-${CSS.escape(peerId)} .peer-stats`)
  if (!p || !el) return
  const parts = []
  if (p.rtt != null) parts.push(`ping ${p.rtt.toFixed(1)} ms`)
  if (p.stats) {
    const bufferMs = p.stats.buffered / SAMPLE_RATE * 1000
    parts.push(`buffer ${bufferMs.toFixed(1)} ms`)
    if (p.rtt != null) {
      const total = p.rtt / 2 + QUANTUM_MS + bufferMs + audio.localLatency * 1000
      parts.push(`<b>atraso ≈ ${total.toFixed(0)} ms</b>`)
    }
    parts.push(`falhas ${p.stats.underruns}`, `perdidos ${p.stats.lost}`)
  }
  parts.push(p.audioCh.readyState === 'open' ? 'conectado' : p.audioCh.readyState)
  el.innerHTML = parts.join(' · ')
}

function renderLocalInfo() {
  const ms = audio.localLatency * 1000
  $('#local-latency').textContent = `Latência de saída deste computador: ${ms.toFixed(1)} ms`
  if (peers.size === 0) renderPeers()
}

function setStatus(text) {
  $('#status').textContent = text
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]))
}
window.__dbg = () => ({all: profile.getAll(), peers: [...peers].map(([id, p]) => [id, p.userId]), users: room.getUsers()})
