# Alibi

A private multiplayer secret-word party game for 4–10 friends. Talk on Discord; Alibi handles private cards, speaking order, votes, and the reveal. No accounts or voice access are needed.

## Run locally

Install Node.js 22 or newer, then run these commands in this folder:

```sh
npm install
npm start
```

Open **http://localhost:3000**. Create a room, choose a nickname and avatar, and share the invite link. The host chooses categories and starts when at least four players are connected. `npm run dev` restarts the server when server files change; restarting clears all rooms.

Each player needs an independent browser session. Tabs in the same browser profile intentionally share one player. For local testing, use separate browser profiles or different browsers; multiple private windows may still share their private session. To play on different devices on your local network, open `http://YOUR-COMPUTER-LAN-IP:3000` on each device and create the room from that address so its invite link is reachable. Your firewall must allow the server's port. A `localhost` invite only works on the computer that opened it.

Follow [LOCAL-PLAYTEST.md](LOCAL-PLAYTEST.md) for a four-player walkthrough, recovery checks, and troubleshooting a stuck preview. [PUBLICATION.md](PUBLICATION.md) records the repository audit and steps needed before publishing.

`PORT` changes the listening port, and `HOST` changes the listening interface (default `0.0.0.0`). For example, in PowerShell:

```powershell
$env:PORT = '3001'
npm start
```

## How to play

1. The host chooses one or more categories. The server selects a word, exactly one imposter, and an independent random speaking order.
2. Privately reveal your card and press Ready. Insiders see the secret word; the imposter sees only the category. Cards start concealed.
3. On your turn, say a short clue aloud on Discord, then press Done. The host can pause or advance a stalled turn.
4. After the lap, discuss your suspicions. The host can add one extra lap or start voting.
5. Vote privately for someone else. Everyone sees participation, but choices appear together only when the ballot closes. The highest total selects the accused. Ties cause one runoff among tied players; a second tie gives the imposter the win.
6. Accusing an insider gives the imposter the win. A caught imposter gets one final guess: a correct guess wins for the imposter, and an incorrect guess wins for the group. Guess matching ignores case, whitespace, and basic punctuation, with curated aliases for selected words.
7. Results reveal the word, the imposter, and the ballots. Start another round in the same room. Everyone participates again, with new roles and a word not yet used from the chosen pool. The pool resets only after its available words are exhausted.

The starter collection is curated locally and includes 120 words across six approachable categories. Words and accepted answer variants live only on the server.

## Reconnects and interruptions

- Refreshing restores your player, room, and role through a random HttpOnly session cookie. Losing or clearing that cookie loses access to that seat. Multiple tabs share one seat; presence drops only when its last connection closes.
- A disconnected player has **120 seconds** after detected connection loss to reconnect. The host role transfers immediately to the earliest connected member and does not automatically transfer back. During grace, the host can advance a stalled clue turn. This gives short trips to Discord more time; readiness, voting and guess deadlines still run while a phone is away.
- If a round participant leaves explicitly or fails to reconnect within grace, the round is abandoned with a visible explanation and no winner. Alibi does not change the electorate or invent missing votes.
- Reveal readiness expires after **120 seconds**; an incomplete reveal abandons the round. Voting expires after **90 seconds** per ballot; an incomplete ballot abandons the round. A caught imposter has **60 seconds** to guess; no guess awards the group a win. If that imposter's disconnect grace expires first, the round is abandoned instead.
- Late arrivals wait for the next round and receive no current-round role, word, or category. They can see the public room state and the final result.
- Sessions expire after **24 hours**. Empty rooms expire after **30 minutes**. Server restarts clear all rooms and sessions.
- Returning to a visible page requests a fresh, personalized server snapshot before enabling actions. It does not send Leave, extend deadlines, or replay offline clicks. Temporary transport loss reconnects automatically. A rejected or expired session shows **Reload to reconnect** with a persistent explanation; the reload link creates a new session. After a server restart, all rooms are gone and players must create a new room.

## Architecture and security boundaries

This is a single Node.js process with Express and Socket.IO. Express serves the frontend and creates opaque 256-bit session cookies. Socket.IO authenticates only from that cookie; a client-supplied player ID cannot choose a seat or grant host privileges. HTTP session creation and socket connections require a matching Origin. Production cookies are Secure; all session cookies are HttpOnly and SameSite=Lax.

`server/game.js` owns the state machine, role assignment, word pool, round roster, ballots, deadlines, and outcomes. Every action validates membership, room identity, permissions, phase, and applicable round, turn, or ballot identifiers. Action IDs make retries idempotent; the server remembers the most recent 512 successful IDs per player for up to 24 hours. Room and phase identifiers also reject stale gameplay actions, including requests delayed in an old browser tab after switching rooms. `server/index.js` owns sessions, connection counts, same-origin enforcement, request limits, deadline sweeps, and personalized broadcasts. `public/` contains the browser interface and artwork; the server directory is not served as static content.

Each snapshot is projected for its recipient. The imposter receives no secret word before results, including while making the final guess. Hosts do not receive other players' roles. Open ballots expose a submission count, never vote choices or candidate totals. Completed ballots are public; the full round result is public after it ends. This protects against inspecting network traffic for unauthorized information, but cannot prevent friends from voluntarily sharing their private cards outside the app.

The detailed transition contract is in [PLAN.md](PLAN.md). Work completed, verification, and remaining tasks are recorded in [PROGRESS.md](PROGRESS.md).

`shared/protocol.js` holds platform-neutral public timing constants, a versioned action-envelope typedef/builder, basic shape validation and room-code normalization. The server and browser both use it. The word collection and all authoritative checks remain server-only. [FUTURE-MOBILE.md](FUTURE-MOBILE.md) describes an installable web app first, then shared-room store apps after playtesting; no mobile project or service worker has been added.

The original interrogation-table illustration is generated artwork. The avatar set is a small local SVG system. All visual assets ship with the app; it needs no font service, image CDN, voice integration, or AI service at runtime. Client preferences store only nickname/avatar locally; roles and words are never persisted in browser storage. `npm run format` formats the source for maintenance. Official API references used for the implementation: [Socket.IO server options](https://socket.io/docs/v4/server-options/), [Socket.IO client options](https://socket.io/docs/v4/client-options/), and [Express API](https://expressjs.com/en/5x/api/).

## Tests

```sh
npm test
```

The Node tests cover meaningful engine rules and run real HTTP/Socket.IO clients with four independent cookie sessions. Integration checks cover all three accusation/guess outcomes, tied ballots and runoff, secret-field privacy, late arrivals, stale/duplicate turns, session identity spoofing, cross-origin rejection, refresh/reconnect, multiple tabs, host transfer/departure, grace expiry, and phase deadlines. Test clocks accelerate deadlines; synchronization and authentication use actual local sockets.

```sh
npm run test:browser
```

The browser smoke check requires Google Chrome installed on the machine and uses Playwright's `chrome` channel in headless mode. It drives actual UI actions in four independent Chrome cookie sessions, observes their real network messages, and saves screenshots plus `browser-report.json` under `artifacts/review/`. It covers complete rounds/rematches, private partial ballots, refresh, Chrome offline/online reconnect, and host tab closure/reopening/departure. This is browser automation, separate from Node engine/socket tests; it does not prove physical-phone suspension behavior. Consult `PROGRESS.md` for actual outcomes.

## Hosting requirements and current limits

The exact architecture has a prepared [Render configuration](render.yaml) and [deployment guide](DEPLOYMENT.md), including current account/cost requirements and pre-publication checks. Nothing has been published. The proposed single service currently starts at $7/month base plus possible usage, and needs Render billing and Git repository access before deployment.

For friends on different networks, this version needs a long-running Node.js host, a public HTTPS address, and a reverse proxy or platform that supports WebSockets. Serve the browser and API from the same origin. Configure these environment variables before starting:

```text
NODE_ENV=production
PUBLIC_ORIGIN=https://your-alibi.example
PORT=3000
```

`PUBLIC_ORIGIN` must be the exact public origin (scheme and host, plus a port if applicable), without a path or trailing slash. Production startup requires an HTTPS origin and sets Secure session cookies. The proxy should terminate TLS, forward HTTP and WebSocket upgrades to Node, and permit connections lasting longer than the Socket.IO heartbeat. `/api/health` is a simple health endpoint. Avoid serverless request-only functions that cannot keep a persistent process and WebSocket connections alive.

Rooms and sessions are **in memory on one process**. Deploy exactly one instance. Replicas, process restarts, crashes, and deploys cannot preserve an active room; sticky sessions alone do not provide shared state or persistence. Host transfer works inside a running process, not across failed servers. Basic rate and size limits reduce accidental or simple abuse; this first version has no production load test, durable recovery, moderation system, analytics, or public matchmaking. Room codes and invite links are bearer invitations: anyone given one can attempt to join.

No external deployment is performed by this project setup. A sensible next milestone is a small playtest with real friends on desktop and phones, followed by durable room/session storage and deployment hardening if the game will be hosted continuously.
