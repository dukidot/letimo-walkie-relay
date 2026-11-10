// Letimo Odgovorno - walkie-talkie "dalji kanal" relay server.
//
// Vrlo jednostavan WebSocket relay: svaki klijent se spoji na /ws?channel=<ime>,
// server ga stavi u "sobu" s tim imenom, i svaku poruku koju jedan klijent pošalje -
// BINARNU (sirovi zvučni paket) ili TEKSTUALNU (npr. "P|Ime" - povremena najava
// prisutnosti pilota, da ostali znaju tko je na kanalu) - odmah proslijedi SVIM
// OSTALIM klijentima u istoj sobi (ne i pošiljatelju natrag). Server ne sprema, ne
// dekodira i ne razumije ni zvuk ni tekst sadržaj - samo prosljeđuje poruke, zato je
// jednostavan i jeftin za hostati (ne treba baza, ne treba puno RAM-a/CPU-a).
//
// Namjerno NEMA autentifikacije/enkripcije sadržaja (osim same WSS/TLS veze
// koju daje hosting) - za pravu udrugu dovoljno je da ime kanala bude "tajna"
// (npr. dogovoreno ime), ali ZNAJ da bilo tko tko zna/pogodi ime kanala može
// slušati. Ako zatreba jača zaštita, najlakše je dodati jednostavnu lozinku
// kao query parametar i provjeriti je ispod (vidi TODO).

const http = require("http");
const { WebSocketServer } = require("ws");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;
// Spriječi da jedna soba naraste beskonačno (zaštita od greške/zlouporabe).
const MAX_CLIENTS_PER_ROOM = 8;
// Ako klijent ništa ne pošalje (ni audio ni ping) ovoliko dugo, smatramo ga
// mrtvim i zatvaramo vezu - inače bi "zombie" veze ostale otvorene zauvijek
// (npr. telefon je izgubio signal bez urednog zatvaranja utičnice).
const IDLE_TIMEOUT_MS = 60_000;

const server = http.createServer((req, res) => {
  // Jednostavan "health check" endpoint - korisno za hosting platforme koje
  // provjeravaju je li servis živ, i za ručnu provjeru u pregledniku.
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Letimo Odgovorno walkie-talkie relay radi.\n");
});

const wss = new WebSocketServer({ server, path: "/ws" });

/** @type {Map<string, Set<import("ws").WebSocket>>} */
const rooms = new Map();

function roomFor(name) {
  let room = rooms.get(name);
  if (!room) {
    room = new Set();
    rooms.set(name, room);
  }
  return room;
}

function leaveRoom(ws) {
  const room = ws.__room;
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) {
    rooms.delete(ws.__roomName);
  }
}

wss.on("connection", (ws, req) => {
  let channel;
  try {
    const url = new URL(req.url, "http://localhost");
    channel = (url.searchParams.get("channel") || "").trim();
    // TODO (opcionalno): ako udruga želi lozinku na kanalu, provjeri je ovdje,
    // npr. `const pass = url.searchParams.get("pass"); if (pass !== OČEKIVANO) { ws.close(4001, "pogrešna lozinka"); return; }`
  } catch {
    channel = "";
  }
  if (!channel) channel = "opci-kanal";
  // Ograniči duljinu/znakove imena kanala (samo kozmetika/sigurnost od zlouporabe).
  channel = channel.slice(0, 64);

  const room = roomFor(channel);
  if (room.size >= MAX_CLIENTS_PER_ROOM) {
    ws.close(4002, "soba je puna");
    return;
  }
  room.add(ws);
  ws.__room = room;
  ws.__roomName = channel;
  ws.__lastActive = Date.now();

  ws.on("message", (data, isBinary) => {
    ws.__lastActive = Date.now();
    // I binarne (audio) i tekstualne (npr. "P|Ime" - prisutnost/ime pilota) poruke se
    // jednako prosljeđuju svima ostalima u sobi - server ih ne razumije, samo prenosi.
    for (const peer of room) {
      if (peer !== ws && peer.readyState === peer.OPEN) {
        peer.send(data, { binary: isBinary });
      }
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

// Periodički očisti neaktivne veze.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const ws of room) {
      if (now - ws.__lastActive > IDLE_TIMEOUT_MS) {
        ws.terminate();
      }
    }
  }
}, 15_000);

server.listen(PORT, () => {
  console.log(`Walkie-talkie relay sluša na portu ${PORT}`);
});
