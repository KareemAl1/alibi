# Alibi progress

Updated September 30, 2026. The browser multiplayer verification and focused usability milestone is complete and running locally at http://localhost:3000. Deployment is prepared but not performed.

## Completed

- Inspected the empty workspace and applicable instructions; preserved the Git repository and configured identity. Wrote `PLAN.md` before implementation.
- Built a genuine server-owned 4–10 player game using Node.js 22, Express and Socket.IO, with no simulated players.
- Completed private rooms/invite links, nickname/avatar selection, categories, concealed role cards, readiness, independent speaking order, pause/advance, optional second lap, discussion, private voting, one runoff, final guesses, results and next round.
- Added 120 curated words across six categories, accepted variants, normalized guesses and session word rotation.
- Added opaque cookie sessions, private snapshots, membership/host/phase validation, room/round/turn/ballot stale-action guards, bounded idempotency, same-origin checks, rate/payload limits and security headers.
- Implemented disconnect grace, host transfer, refresh recovery, multi-tab seat sharing, late arrivals, deadlines and explicit abandonment without invented votes.
- Created the ink/cream/orange design, original generated illustration, local SVG avatars, responsive layouts, keyboard focus preservation, screen-reader status messages and reduced-motion support.
- Added README setup/rules/architecture/hosting documentation, `.env.example` and source formatting command.
- Re-ran the four-session browser baseline **before** the usability changes; retained the original suspects, cream panels and orange identity.
- Increased category/room text, kept category descriptions visible on phones, and paired playful titles with explicit plain-language categories. Enlarged players/current speaker and strengthened the active-row highlight.
- Added a 52px-high phone action bar with safe-area padding, kept the real form/action handlers, and moved the private card before readiness on phones.
- Added public `shared/protocol.js` helpers, a two-minute seat grace, authenticated `state:sync`, and fresh-snapshot gating after reconnect/foreground return. Server rules and membership remain authoritative.
- Prepared `render.yaml`, `.node-version`, `DEPLOYMENT.md` and `FUTURE-MOBILE.md`. No mobile project, new game mode, service worker, repository publication or external deployment.

## Actual verification

- `npm test`: **40/40 passed** (25 engine rules tests and 15 real HTTP/Socket.IO integration tests). Most deadline tests use accelerated clocks; the additional real-time check is listed below.
- `npm run test:browser`: passed before styling and again after changes in **real Chrome 154 driven by Playwright**, with four independent browser contexts and separate cookies; a fifth verified late joining. This is automated browser interaction, distinct from Node tests and from a human/device playtest. Actions used the actual UI and server, without test-only gameplay endpoints.
- Browser rounds covered innocent accusation, caught imposter with incorrect guess, normalized correct guess, and tied vote plus tied runoff. All four clients reached matching results.
- Browser verified pause/resume, extra clue lap, refresh retaining the same role with card concealed, actual Chrome offline/online transport recovery, host tab close/reopen preserving the seat while the replacement host remained, late arrival without secrets, and explicit host departure/transfer. Offline action controls were disabled. No JS page errors.
- Inspected imposter incoming snapshots/transport payloads throughout rounds: **no secret word before results**. Open ballots exposed only participation. Tests rejected unauthorized host actions, self-votes, identity spoofing, wrong origins, missing sessions and attempts to retrieve server word files.
- Socket tests covered last-tab disconnect, host transfer, duplicate/stale actions, stale ballots, cross-room stale actions, grace expiry and phase deadlines. A focused connection-cap check admitted eight tabs and rejected four excess connections.
- Browser tested action IDs with `crypto.randomUUID` unavailable, matching the HTTP LAN constraint. It also checked avatar/reveal/category keyboard focus, preserved category details and disabled next-round action with an empty pool.
- No horizontal overflow at desktop, 390px and 320px widths. Reduced motion was enabled. Six main in-room controls stayed visible from the top at 390×844 and measured 354×52px. The browser actually submitted both final guesses and rematches from the phone action bar. Entry form submission remains within its form, reachable by scrolling.
- Visually inspected active-turn, voting, results and phone action-bar screenshots. Final screenshots and a machine-readable browser report are in `artifacts/review/`; pre-change screenshots are in `artifacts/baseline/`. These supplement network/state assertions, not substitute for them.
- The server tests verified recovery after 90 simulated seconds within the 120-second grace, personalized sync without state mutation, and continued ballot/guess deadlines while a seat is reserved. Foreground sync itself is transport-tested, not physically OS-tested.
- Dependency installation audit reported **0 vulnerabilities** at this run's resolution.
- `/api/health` returned `{ "ok": true }`; the shared protocol route returned 200 and server error log was empty after restarting the local server for this milestone.
- Render configuration parsed locally and passed formatting checks. Official pricing, single-instance WebSocket hosting requirements and environment references were reviewed. Render schema acceptance/build/public TLS have not been executed.

## Decisions and recovery

- Local only: no external deployment, accounts, payments, voice integration or runtime AI service.
- A 256-bit opaque HttpOnly/SameSite=Lax cookie identifies a seat; production adds Secure. Browser tabs share the seat, independent profiles do not.
- Disconnect grace is now **120 seconds** after the server detects loss; heartbeat detection can add several seconds. Host transfers immediately on detected loss, without automatically transferring back. Readiness120/voting90/guess60 deadlines remain independent of seat grace.
- Active participant departure/grace expiry abandons the round with no winner. Waiting spectators do not change the electorate. Readiness/incomplete-ballot deadlines abandon; connected imposter guess timeout awards the group a win.
- Latest 512 successful action IDs per player are retained for up to 24 hours. Room/round/turn/ballot guards independently reject obsolete progression actions.
- Empty rooms expire after 30 minutes; sessions after 24 hours. Selected word pools reset only after exhaustion.

## Local handoff

- Open **http://localhost:3000**. Create a room; use four independent browser profiles/browsers to play on this computer.
- For same-network devices, open `http://YOUR-COMPUTER-LAN-IP:3000` and create the room from that address. Your firewall must allow port 3000. Localhost invites cannot reach other computers.
- Restart later with `npm start`; `npm run dev` watches server changes. Every server restart clears room/session memory.
- Background server PID is recorded in `artifacts/server.pid`; logs are `artifacts/server.log` and `artifacts/server-error.log`. Read the current PID file and verify process identity before stopping a potentially reused PID later.
- Source is saved on local branch `codex/alibi`, with separate server/rules and interface/handoff commits. Nothing was pushed or published externally.

## Remaining limitations / unverified checks

- Rooms/sessions are in memory on one process. Restarts/crashes/deploys lose active games; replicas are unsupported.
- Physical phones, Safari/Firefox, real multi-device LAN/firewall connectivity, voice quality, actual Discord switching, OS suspension/lock-screen behavior, hardware safe areas and virtual keyboards were **not verified**. Phone layouts used Chromium viewports. Headless Chrome tab switching left `visibilityState` visible, so that experiment is explicitly not evidence of background/foreground recovery.
- Full accessibility/screen-reader audit, load/soak testing, production HTTPS/proxy hosting and public-internet operation remain **unverified**.
- Most deadline tests use accelerated clocks. Seat grace was additionally checked for its full real-time duration using actual sockets, as recorded below; every phase deadline has not been timed in a browser.
- No open blocking defects identified by completed checks.

## Recommended next milestone

Review the supplied gameplay screenshots. With approval and access, publish the existing repository and create the prepared one-instance Render service (currently $7/month base plus usage). It needs a Render/payment account and Git repository access; there is currently no Git remote. Then playtest with 4–6 real friends on desktop/physical phones, including Discord switching. Add durable recovery before relying on uninterrupted rooms. Explore an installable web app, then choose a store-app approach after those playtests; both should share this server's rooms and rules.

## Preview recovery and publication preparation — September 30

- At the user's report of a stuck preview, the original local server was still running and `/api/health` returned `{"ok":true}`. The actual in-app browser contained the older 60-second interface. Reloading loaded the current app and immediately restored its connected state. The original stale session rejection was not captured in browser logs, so that specific initial trigger is inferred rather than directly logged.
- Found and corrected a real connection-state bug: socket authentication rejection stops automatic retries, while `render()` previously overwrote the error with “Reconnecting…”. The server now returns shared, explicit connection error codes. The browser persistently shows “Reload to reconnect” and the server's explanation, conceals any private card, and disables game actions. The reload control explicitly reloads the page. Ordinary transport loss still uses automatic reconnects and no offline game actions are queued.
- UI grace text derives from the server/shared timing value and explicitly says **2 minutes (120 seconds)**. Corrected the remaining obsolete 60-second constructor example in `PLAN.md`. The final guess remains 60 seconds; readiness120 and voting90 remain separate deadlines.
- **Real elapsed-time socket check:** four independent sessions on an isolated ephemeral server, with no fake clock. Two disconnected seats remained at 61.012 seconds; the former host recovered the same seat at 65.031 seconds without reclaiming host control. The other seat remained at 119.008 seconds and expired at 120.830 seconds after detection, matching the one-second sweep. Evidence and a reproducible script are in ignored `artifacts/recovery-real-time-report.json` and `artifacts/recovery-real-time.mjs`. This is socket evidence, not a browser or physical-phone check.
- **Actual preview check:** deliberately stopped/restarted the local server after loading the fix. Observed the two-minute room banner during loss and a persistent session/restart explanation after the healthy server returned. Activated the reload link using Tab/Enter, confirmed the connected state returned, and created a fresh host room through the actual form. Left that room open with the server running; proof is saved in `artifacts/preview-connected.png`. This reproduces the healthy-server/invalid-session condition rather than treating it as a server outage. No design, CSS, illustration, or game rules were changed.
- **Automated regression:** the new integration check restarts a real server, confirms health still passes, verifies rejection of the old session with `SESSION_EXPIRED` and inactive retries, then bootstraps a new session and connects successfully without claiming to restore the erased room. All 40 tests pass. The earlier full four-player Chrome rounds were not rerun for this connection-message fix; their separate evidence remains above.
- GitHub's authenticated `gh api user --jq .login` endpoint returned **KareemAl1**. Authentication was read-only; no tokens were displayed, account switched, remote created, or repository pushed.
- Added `.gitignore` protection and `PUBLICATION.md`: initial audit checked 26 tracked paths and all three pre-existing commits (56 text-file versions), finding no credential-pattern candidates or tracked local-output paths. This targeted scan is not a universal secret guarantee. Local logs/screenshots/browser evidence remain excluded.
- Added `LOCAL-PLAYTEST.md` with four independent browser sessions, the complete round/rematch walkthrough, refresh/host transfer/grace checks, and the difference between a temporary network interruption and a server restart.
- Official Render pricing rechecked: one 0.5c-512mb service is US$7/month on a $0 Hobby workspace, with possible bandwidth/build usage. `DEPLOYMENT.md` clearly identifies the paid YAML as a proposal pending the user's choice. No purchase, deploy, or publication occurred. The PWA/store-app path remains documented in `FUTURE-MOBILE.md` without starting mobile implementation.
