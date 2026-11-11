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
const admin = require("firebase-admin");

const PORT = process.env.PORT || 8080;

// --- "Pozovi ostale" (push obavijest preko Firebase Cloud Messaging) -------------------
// Treba FIREBASE_SERVICE_ACCOUNT environment varijablu na hostingu (Render -> Environment),
// s CIJELIM sadržajem JSON ključa servisnog računa iz Firebase Console (Project settings ->
// Service accounts -> Generate new private key). NIKAD ne commitati taj JSON u git - samo
// kao env varijablu na serveru. Vidi PRVI_KORACI_FIREBASE.md u korijenu projekta.
const CALL_TOPIC = "walkie_pozivi";
let firebaseReady = false;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseReady = true;
    console.log("Firebase Admin spreman - /call endpoint će raditi.");
  } else {
    console.warn(
      "FIREBASE_SERVICE_ACCOUNT nije postavljen - /call endpoint neće slati poziv " +
        "(ostatak servera, uključivo walkie-talkie zvuk preko WebSocketa, radi normalno)."
    );
  }
} catch (e) {
  console.error("Firebase Admin init greška - provjeri FIREBASE_SERVICE_ACCOUNT:", e.message);
}
// Najviše 8 uređaja po kanalu (kao kod pravog walkie-talkieja s 8 fiksnih kanala) -
// deveti koji pokuša spojiti se na već pun kanal bude odbijen (vidi "soba je puna" ispod).
const MAX_CLIENTS_PER_ROOM = 8;
// Ako klijent ništa ne pošalje (ni audio ni ping) ovoliko dugo, smatramo ga
// mrtvim i zatvaramo vezu - inače bi "zombie" veze ostale otvorene zauvijek
// (npr. telefon je izgubio signal bez urednog zatvaranja utičnice).
const IDLE_TIMEOUT_MS = 60_000;

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/call") {
    handleCallRequest(req, res);
    return;
  }
  // Jednostavan "health check" endpoint - korisno za hosting platforme koje
  // provjeravaju je li servis živ, i za ručnu provjeru u pregledniku.
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Letimo Odgovorno walkie-talkie relay radi.\n");
});

/** POST /call {"callerName": "...", "channel": "..."} - šalje push obavijest svim
 * uređajima pretplaćenima na [CALL_TOPIC] (vidi Android WalkieCallMessagingService). */
function handleCallRequest(req, res) {
  if (!firebaseReady) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Firebase nije postavljen na serveru." }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4096) req.destroy(); // zaštita od prevelikog tijela zahtjeva
  });

  req.on("end", async () => {
    let callerName = "Netko";
    let channel = "";
    try {
      const parsed = JSON.parse(body || "{}");
      if (typeof parsed.callerName === "string" && parsed.callerName.trim()) {
        callerName = parsed.callerName.trim().slice(0, 64);
      }
      if (typeof parsed.channel === "string") {
        channel = parsed.channel.trim().slice(0, 64);
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Neispravan JSON." }));
      return;
    }

    try {
      await admin.messaging().send({
        topic: CALL_TOPIC,
        // Samo "data" poruka (ne "notification") - Android app sam gradi obavijest u
        // WalkieCallMessagingService, tako da radi identično na svim verzijama Androida
        // i dok je app zatvorena.
        data: { callerName, channel },
        android: { priority: "high" }
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error("Greška kod slanja FCM poziva:", e.message);
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Slanje push poruke nije uspjelo." }));
    }
  });
}

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
