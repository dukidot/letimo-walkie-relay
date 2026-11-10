# Walkie-talkie relay server (za "dalji kanal")

Mali Node.js server koji samo prosljeđuje binarne zvučne pakete između
telefona spojenih na isti "kanal" preko WebSocketa. Ne sprema ništa, ne treba
bazu podataka - zato je besplatan/jeftin za hostati.

**Testiran lokalno** (simulirana 2 klijenta u istoj sobi + 1 u drugoj sobi) -
poruke se ispravno prosljeđuju svima u sobi osim pošiljatelju, druga soba ih
ne vidi, a tekstualne poruke (koriste se samo kao "ping" da veza ne umre) se
ispravno ne prosljeđuju.

## Pokretanje lokalno (za testiranje)

```bash
cd walkie-server
npm install
npm start
```

Server sluša na portu iz `PORT` env varijable (zadano 8080). Otvori
`http://localhost:8080/` u pregledniku - treba pisati "Letimo Odgovorno
walkie-talkie relay radi." ako je sve OK.

## Hostanje (besplatno/jeftino) - preporuka: Render.com

Render.com ima besplatan plan za male Node servise koji podržava WebSockete
(mnogi besplatni hosting servisi NE podržavaju WebSocket, pa pazi na to ako
biraš drugog pružatelja):

1. Napravi (besplatan) račun na [render.com](https://render.com).
2. **New** → **Web Service** → spoji svoj GitHub (stavi ovu `walkie-server`
   mapu u svoj GitHub repo, ili odaberi "Deploy from a Git repository" i
   uploadaj ručno).
3. Postavke: Build Command `npm install`, Start Command `npm start`.
4. Nakon deploya dobiješ URL oblika `https://tvoj-servis.onrender.com`.
   Adresa za WebSocket u aplikaciji je **ista domena, ali `wss://` umjesto
   `https://`**, npr. `wss://tvoj-servis.onrender.com/ws`.
5. Taj URL upiši u Android aplikaciju - u
   `app/src/main/java/hr/letimoodgovorno/app/data/WalkieTalkieConfig.kt`,
   konstanta `RELAY_SERVER_URL`.

Napomena: besplatni plan na Renderu "uspava" servis nakon ~15 min
neaktivnosti, pa prvo spajanje nakon duže stanke može kasniti par sekundi dok
se server probudi - za walkie-talkie na terenu to znači da prva poruka nakon
duže pauze može kasniti, a sve nakon toga radi normalno. Ako to smeta,
plaćeni plan (ili bilo koji drugi Node hosting s "always on") to uklanja.

Alternative koje isto podržavaju WebSocket: Railway.app, Fly.io, ili vlastiti
VPS (npr. najjeftiniji DigitalOcean/Hetzner droplet s `pm2` ili `systemd`
servisom koji drži `node server.js` pokrenutim).

## Sigurnost / privatnost

- Server ne razumije ni sprema zvuk, samo ga prosljeđuje uživo - nema snimki
  koje negdje ostaju.
- Ime "kanala" (sobe) je jedina "lozinka" - tko god zna ime kanala može
  slušati. Za udrugu je najjednostavnije dogovoriti jedno zajedničko ime
  kanala (zadano u aplikaciji je `opci-kanal`) i po potrebi ga promijeniti
  ako se želi privatnija grupa (npr. za jedan trening/događaj).
- Veza telefon↔server ide preko `wss://` (TLS), isto kao `https://` - sadržaj
  nije vidljiv nikome tko prisluškuje mrežu usput.
