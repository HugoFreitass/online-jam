# online-jam

Jam session online para ~5 músicos, direto no navegador, hospedado só no GitHub Pages (sem servidor próprio).

## Ideia

- **Áudio P2P via WebRTC** (malha: cada pessoa conecta direto com as outras 4).
- **Sinalização sem servidor**: usar a lib [Trystero](https://github.com/dmotz/trystero), que faz o "aperto de mão" WebRTC através de redes públicas (BitTorrent trackers / Nostr / MQTT). O GitHub Pages só serve o HTML/JS.
- **Configuração de baixa latência**: Opus, sem echo cancellation / noise suppression / auto gain, buffers mínimos, `jitterBufferTarget` baixo.

## Limites reais

- "Sem atraso" não existe pela internet: o objetivo é ficar **< ~30 ms** ponta a ponta, que é o limite pra tocar junto confortável. Isso depende muito da distância física e da conexão (cabo > Wi-Fi).
- Fones de ouvido obrigatórios (sem cancelamento de eco).
- Algumas redes (NAT simétrico / 4G) não conectam P2P sem um servidor TURN.

## Roadmap

- [ ] v0: página que entra numa sala e troca áudio entre 2 pessoas
- [ ] v1: malha com até 5 pessoas + mixer (volume/mute por pessoa)
- [ ] v2: medidor de latência (RTT) por pessoa
- [ ] v3: metrônomo sincronizado
- [ ] Ideias: modo MIDI, gravação local, modo "intervalo" estilo NINJAM
