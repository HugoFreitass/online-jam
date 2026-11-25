# online-jam

Jam session online para ~5 músicos, direto no navegador, hospedado só no GitHub Pages (sem servidor próprio).

Cenário alvo: até 5 pessoas no mesmo estado (≤ ~30 km), tocando piano, bateria, guitarra e violão, via MIDI ou placa de som, só ao vivo.

## Como funciona

- **Conexão P2P (malha)**: cada pessoa conecta direto com as outras via WebRTC. A descoberta usa a lib [Trystero](https://github.com/dmotz/trystero), que faz o "aperto de mão" por relays Nostr públicos. O GitHub Pages só serve os arquivos.
- **Áudio sem codec**: PCM 16-bit, mono, 48 kHz, em pacotes de 128 amostras (2,7 ms), enviados num DataChannel **não confiável e fora de ordem**. Assim pulamos o jitter buffer do WebRTC tradicional (que sozinho costuma dar 40–80 ms). Custa ~1 Mbps por pessoa, em cada direção.
- **Jitter buffer próprio** (AudioWorklet) com alvo ajustável na tela (padrão 10 ms).
- **MIDI**: só as notas trafegam (4 bytes por evento). Cada navegador toca o som localmente com samples ([smplr](https://github.com/danigb/smplr)): piano de cauda, piano elétrico, bateria TR-808, violão (nylon/aço) e guitarra (limpa/overdrive/distorcida). O atraso do MIDI é praticamente só o da rede.

## Arquivos

- `index.html`, `style.css`: interface
- `js/app.js`: sala, peers, canais de dados, UI
- `js/audio.js`: captura e reprodução (Web Audio)
- `js/worklets.js`: AudioWorklets (empacotamento e jitter buffer)
- `js/midi.js`: Web MIDI e instrumentos

## Rodar localmente

```sh
python3 -m http.server 8000
# abra http://localhost:8000/?sala=teste em duas janelas (uma anônima)
```

## Dicas para tocar

- Fones de ouvido obrigatórios (não há cancelamento de eco).
- Cabo de rede > Wi-Fi.
- Use Chrome ou Edge (Web MIDI e AudioWorklet mais maduros).
- Guitarra/violão: ligue na placa de som e escolha o canal (entrada 1 ou 2). Faça o monitoramento direto pela placa, não pelo navegador.
- **Guitar Rig + cabo virtual**: o site detecta VB-Cable / Voicemeeter / BlackHole e mostra o botão **Usar Guitar Rig**, que já configura tudo. Deixe o cabo virtual e o Guitar Rig em **48000 Hz** (o site avisa se não estiver). O passo a passo está no painel "Como ligar o Guitar Rig".
- As escolhas (entrada, canal, instrumento, buffer) ficam salvas no navegador.
- Bateria eletrônica: dá pra mandar por MIDI (som TR-808) ou o áudio do módulo pela placa de som (som do seu kit).

## Limites reais

- Atraso zero não existe. Meta: **< ~30 ms** ponta a ponta. O valor "atraso ≈" de cada músico soma rede + buffer + saída de áudio do seu computador.
- A latência de saída do sistema operacional pesa bastante. No Linux, PipeWire com quantum baixo ajuda. No Windows, o navegador não usa ASIO.
- Algumas redes (NAT simétrico / 4G) não conectam P2P sem servidor TURN.

## Roadmap

- [x] v0: sala, áudio PCM P2P, MIDI com instrumentos, mixer básico, ping e estimativa de atraso
- [ ] Testar com a banda e medir o atraso real
- [ ] Buffer adaptativo e ocultação de perda (evitar estalos)
- [ ] Metrônomo sincronizado
- [ ] Mais instrumentos MIDI (kit acústico, órgão, baixo)
- [x] Guitarra e violão no MIDI; campo "o que você toca" para quem manda áudio
- [x] Guitar Rig + cabo virtual: detecção, configuração em um clique, aviso de 48 kHz
- [x] Interface nova: canais com medidor de nível, LED de MIDI, atraso colorido
- [ ] Opção Opus (WebCodecs) para conexões mais fracas
