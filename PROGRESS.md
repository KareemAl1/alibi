# Alibi progress

Updated September 30, 2026. The playable first version is complete and running locally at http://localhost:3000.

## Completed

- Inspected the empty workspace and applicable instructions; preserved the Git repository and configured identity. Wrote `PLAN.md` before implementation.
- Built a genuine server-owned 4–10 player game using Node.js 22, Express and Socket.IO, with no simulated players.
- Completed private rooms/invite links, nickname/avatar selection, categories, concealed role cards, readiness, independent speaking order, pause/advance, optional second lap, discussion, private voting, one runoff, final guesses, results and next round.
- Added 120 curated words across six categories, accepted variants, normalized guesses and session word rotation.
- Added opaque cookie sessions, private snapshots, membership/host/phase validation, room/round/turn/ballot stale-action guards, bounded idempotency, same-origin checks, rate/payload limits and security headers.
- Implemented disconnect grace, host transfer, refresh recovery, multi-tab seat sharing, late arrivals, deadlines and explicit abandonment without invented votes.
- Created the ink/cream/orange design, original generated illustration, local SVG avatars, responsive layouts, keyboard focus preservation, screen-reader status messages and reduced-motion support.
- Added README setup/rules/architecture/hosting documentation, `.env.example` and source formatting command.

## Actual verification

- `npm test`: **37/37 passed** (24 engine rules tests and 13 real HTTP/Socket.IO integration tests).
- `npm run test:browser`: passed in installed Google Chrome with **four independent browser contexts** and separate cookies; a fifth verified late joining. Actions used the actual UI and server, without test-only gameplay endpoints.
- Browser rounds covered innocent accusation, caught imposter with incorrect guess, normalized correct guess, and tied vote plus tied runoff. All four clients reached matching results.
- Browser verified pause/resume, extra clue lap, refresh retaining the same role with card concealed, late arrival without secrets, and explicit host departure/transfer. No JS page errors.
- Inspected imposter incoming snapshots/transport payloads throughout rounds: **no secret word before results**. Open ballots exposed only participation. Tests rejected unauthorized host actions, self-votes, identity spoofing, wrong origins, missing sessions and attempts to retrieve server word files.
- Socket tests covered last-tab disconnect, host transfer, duplicate/stale actions, stale ballots, cross-room stale actions, grace expiry and phase deadlines. A focused connection-cap check admitted eight tabs and rejected four excess connections.
- Browser tested action IDs with `crypto.randomUUID` unavailable, matching the HTTP LAN constraint. It also checked avatar/reveal/category keyboard focus, preserved category details and disabled next-round action with an empty pool.
- No horizontal overflow at desktop, 390px and 320px widths. Reduced motion was enabled. Visually inspected desktop entry/lobby/results and phone-sized entry/clue screenshots. Screenshots are ignored local artifacts, supplementing actual synchronization assertions.
- Dependency installation audit reported **0 vulnerabilities** at this run's resolution.
- `/api/health` returned `{ "ok": true }`; server error log was empty. Codex queued the requested local browser preview tab.

## Decisions and recovery

- Local only: no external deployment, accounts, payments, voice integration or runtime AI service.
- A 256-bit opaque HttpOnly/SameSite=Lax cookie identifies a seat; production adds Secure. Browser tabs share the seat, independent profiles do not.
- Disconnect grace is 60 seconds after the server detects loss; heartbeat detection can add several seconds. Host transfers immediately on detected loss, without automatically transferring back.
- Active participant departure/grace expiry abandons the round with no winner. Waiting spectators do not change the electorate. Readiness/incomplete-ballot deadlines abandon; connected imposter guess timeout awards the group a win.
- Latest 512 successful action IDs per player are retained for up to 24 hours. Room/round/turn/ballot guards independently reject obsolete progression actions.
- Empty rooms expire after 30 minutes; sessions after 24 hours. Selected word pools reset only after exhaustion.

## Local handoff

- Open **http://localhost:3000**. Create a room; use four independent browser profiles/browsers to play on this computer.
- For same-network devices, open `http://YOUR-COMPUTER-LAN-IP:3000` and create the room from that address. Your firewall must allow port 3000. Localhost invites cannot reach other computers.
- Restart later with `npm start`; `npm run dev` watches server changes. Every server restart clears room/session memory.
- Background server PID is recorded in `artifacts/server.pid`; logs are `artifacts/server.log` and `artifacts/server-error.log`. This run's PID was 38408; verify process identity before stopping a potentially reused PID later.
- Source is saved on local branch `codex/alibi`, with separate server/rules and interface/handoff commits. Nothing was pushed or published externally.

## Remaining limitations / unverified checks

- Rooms/sessions are in memory on one process. Restarts/crashes/deploys lose active games; replicas are unsupported.
- Physical phones, Safari/Firefox, real multi-device LAN/firewall connectivity, and real Discord conversation were **not verified**. Phone layouts used Chromium viewports.
- Full accessibility/screen-reader audit, load/soak testing, production HTTPS/proxy hosting and public-internet operation remain **unverified**.
- Long timer tests used accelerated clocks; this run did not wait through every full real-time deadline.
- No open blocking defects identified by completed checks.

## Recommended next milestone

Playtest with 4–6 real friends on desktop and phones, tune timing/category quality, then add durable room/session recovery before arranging an always-on HTTPS host.
