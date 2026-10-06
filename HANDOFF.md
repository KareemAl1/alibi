# Alibi development handoff

Prepared October 6, 2026 for continuing development with Claude. This handoff changes documentation only; preserve the existing game, artwork, and working behavior.

## Start here

- Local project folder: `C:\Users\karee_4m899us\Documents\Projects\alibi`
- Private GitHub repository: https://github.com/KareemAl1/alibi
- Development branch: `codex/alibi`. Continue from this branch and its latest commit, not from an unrelated project.
- The last implementation commit before this documentation handoff is `f3853fa` (reconnect feedback and local-playtest preparation). `git log -5 --oneline` shows the subsequent handoff commit.
- Read this file, [PROGRESS.md](PROGRESS.md), and [LOCAL-PLAYTEST.md](LOCAL-PLAYTEST.md) first. See [DEPLOYMENT.md](DEPLOYMENT.md) before hosting work.
- On October 6 the local server was **not running**: `http://localhost:3000/api/health` refused connection. The previous room codes and process IDs are historical. Start a server using the commands below and create a new room.
- No public game URL, Render deployment, hosting purchase, PWA, or native app exists. Private source publication is separate from deploying the game.

## Product and scope

Alibi is a real-time secret-word party game for **4–10 friends** talking on Discord or another external voice call. The website handles rooms, secrets, speaking order, votes and results. It does not capture audio or accept typed clues.

Keep its late-night interrogation identity: dark ink background, warm cream case-file panels, orange accents, illustrated suspects, and expressive local SVG avatars. Since October 6 the lobby and vote are styled as a police lineup (height chart, name placards, Big Shoulders Display headings, Archivo body); see the visual direction entry in PROGRESS.md. Playful category titles also show plain-language categories. Phone layouts have larger touch targets, safe-area padding and a reachable main action.

Do not rebuild the project or add modes, accounts, payments, public matchmaking, AI-generated words, extra roles, built-in voice, or mobile implementation without a new user request. The next product milestone is a small real-friends browser playtest.

## Game rules

1. Create a private room with a nickname/avatar and invite friends using its six-character code or `/?room=CODE` link. The host chooses one or more categories and starts with at least four connected players.
2. The server chooses one imposter, a secret word, and an independently randomized speaking order. Insiders receive the word; the imposter knows their role and receives only the category. Private cards begin concealed. Everyone checks their card and marks ready.
3. Each player gives a clue aloud and presses **Done with my clue** on their turn. The host can pause/resume or advance a stalled turn.
4. After one lap, discuss aloud. The host can request one extra clue lap or begin private voting.
5. Every eligible player votes for someone else. While voting is open, show only participation, never choices or running totals. Reveal the completed ballot together. A highest-vote tie causes one runoff among the tied candidates; another tie lets the imposter escape.
6. An innocent accusation gives the imposter a win. A caught imposter gets one final guess without receiving the secret word. A correct guess wins for the imposter; an incorrect guess or guess timeout wins for the group. Matching normalizes case, whitespace and basic punctuation and accepts curated aliases.
7. Results reveal the word, imposter, votes and outcome. **Next round** reuses the room with everyone participating again, fresh role assignment and a new word. Previously used words do not repeat until the selected pool is exhausted. There is no ongoing elimination.

The starter collection contains **120 curated words across six categories**. Keep the word collection and accepted aliases on the server.

### Interruption policy

| Rule                        | Current behavior                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seat recovery               | 120 seconds after the server detects the last connection for that player closing; heartbeat detection may precede this, and the sweep runs every second.                    |
| Host loss                   | Transfer immediately to the earliest connected member; returning original host keeps their seat but does not reclaim host control.                                          |
| Refresh/multiple tabs       | Same cookie restores the same player and private role while the session/seat remain valid. Tabs in one browser profile share a seat; the last connection controls presence. |
| Explicit Leave              | Immediate seat removal; no reconnect grace.                                                                                                                                 |
| Participant leave/expiry    | Abandon an active round with a visible explanation and no winner. Never invent missing votes or change the electorate silently.                                             |
| Late arrival                | Wait for the next round; receive no current private role, word or category.                                                                                                 |
| Readiness deadline          | 120 seconds; incomplete readiness abandons the round.                                                                                                                       |
| Ballot deadline             | 90 seconds per ballot; incomplete voting abandons the round.                                                                                                                |
| Final guess deadline        | 60 seconds; timeout gives the group a win unless departure/seat expiry has already abandoned the round.                                                                     |
| Session / empty room expiry | Sessions last 24 hours; empty rooms expire after 30 minutes.                                                                                                                |
| Server restart              | All rooms and sessions are lost. A browser refresh creates a fresh session but cannot recover the old room.                                                                 |

Phase deadlines continue during a reserved seat's grace period. Changing tabs, going to Discord or locking a phone must never send an explicit Leave. On return the browser conceals the private card, reconnects/resynchronizes, and waits for a fresh snapshot before enabling game actions.

## Architecture and invariants

The app is plain JavaScript ES modules, running on **one Node.js 22 process** with Express 5 and Socket.IO 4. GSAP 3.15 is a pinned runtime dependency served by the app at `/vendor/gsap.min.js` (no CDN). There is no frontend build pipeline, database, external runtime API, React project, or TypeScript compilation step. `package-lock.json` pins installed dependencies.

- **Authoritative engine:** `GameStore` in `server/game.js` owns rooms, membership, randomness, roles, fixed round rosters, phases, deadlines, speaking order, votes and outcomes. It has no browser dependency. Its injected clock/randomness support tests. Only its personalized `view(playerId)` is safe to send to a player.
- **HTTP and transport:** `server/index.js` serves the frontend, bootstraps cookie sessions, authenticates socket connections, counts player connections, sweeps deadlines, applies rate/payload limits and broadcasts personalized state. State and sessions are in memory.
- **Public contract:** `shared/protocol.js` defines protocol version 1, public timing values, connection error codes, the action-envelope typedef/builder, basic shape validation, and room-code normalization. These helpers are platform-neutral; they are not a complete per-message schema or a substitute for server authorization.
- **Web interface:** `public/app.js` renders server snapshots and sends player intentions. Selected votes, card reveal state and form values are local UI state. Only nickname/avatar preferences are stored locally; never persist private snapshots, words or session tokens in local storage.

HTTP routes are `GET /api/health`, `POST /api/session`, public static assets, and the explicit public `/shared/protocol.js` route. The server source and word pool are not static assets. Client socket events are `room:create`, `room:join`, `action`, and `state:sync`; server events are `catalog` and personalized `state`. Acknowledgements use `ok` and optional `error`.

The opaque session cookie uses 256 random bits, HttpOnly and SameSite=Lax, with Secure in production. Socket identity comes from that cookie, never a supplied player ID. Session creation and socket connections require matching Origin. Keep those checks when changing hosting or adding a later client adapter.

Every gameplay action checks membership, permissions, phase and applicable room/round/turn/ballot identifiers. Unique action IDs make successful retries idempotent; the latest 512 are retained per player for up to 24 hours. Never replay stale/offline clicks blindly. An imposter must not receive the word before results, including during their final guess; the host has no access to other players' private roles.

The latest connection fix distinguishes automatic transport reconnect from an authentication rejection that stops Socket.IO retries. Rejected sessions keep **Reload to reconnect** visible with an explicit explanation. Reload is deliberate; creating new credentials cannot silently recover a lost seat.

## Important files

| File                                                                      | Purpose                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/game.js`                                                          | Authoritative state machine, permissions, recovery and recipient snapshots.                                                                                                                                                                                                                                 |
| `server/index.js`                                                         | Express/Socket.IO server, session cookies, origins, limits, sweeps and startup.                                                                                                                                                                                                                             |
| `server/words.js`                                                         | Curated categories, words and aliases; guess normalization lives in server/game.js.                                                                                                                                                                                                                         |
| `shared/protocol.js`                                                      | Reusable public timing/error/action contract.                                                                                                                                                                                                                                                               |
| `public/app.js`                                                           | Browser rendering, controls, invite handling and connection lifecycle.                                                                                                                                                                                                                                      |
| `public/index.html`, `public/style.css`                                   | Page shell and current responsive styling. Preserve existing assets/theme files.                                                                                                                                                                                                                            |
| `public/avatars.js`, `public/art/interrogation.png`, `public/favicon.svg` | Existing visual identity and local assets.                                                                                                                                                                                                                                                                  |
| `public/lineup.css`, `public/fonts/`, `public/art/interrogation.webp`     | Lineup visual layer (October 6), self-hosted OFL fonts, and the compressed hero art served before the PNG fallback.                                                                                                                                                                                         |
| `public/motion.js`                                                        | Motion for the big moments (GSAP plus View Transitions). Presentational only; skipped entirely under reduced motion. See the motion entry in PROGRESS.md.                                                                                                                                                   |
| `design/capture.mjs`, `design/crowd.mjs`, `design/directions/`            | Design review tooling, not served. `capture.mjs` plays a real round and screenshots every phase (optionally with a direction study layered on) and fails on more than one big all-caps heading per screen. `crowd.mjs` runs a 10-player room on a 390px phone and measures action-dock overlap on the vote. |
| `design/record-vote.mjs`, `design/motion-perf.mjs`                        | Motion review: 30fps vote-reveal clips rendered on a virtual clock, and a real-time phone check at 4x CPU throttle (add `--reduced` to verify reduced motion).                                                                                                                                              |
| `test/game.test.js`                                                       | 25 engine tests.                                                                                                                                                                                                                                                                                            |
| `test/integration.test.js`                                                | 15 actual HTTP/Socket.IO tests, including restart/session recovery.                                                                                                                                                                                                                                         |
| `test/browser-smoke.js`                                                   | Four independent headless Chrome sessions, real UI actions, passive network assertions and screenshots.                                                                                                                                                                                                     |
| `package.json`, `package-lock.json`, `.node-version`                      | Commands, dependencies and Node version.                                                                                                                                                                                                                                                                    |
| `.env.example`, `.gitignore`                                              | Non-secret configuration examples and local/secret exclusions.                                                                                                                                                                                                                                              |
| `render.yaml`, `DEPLOYMENT.md`                                            | Proposed single-service hosting configuration; not deployed.                                                                                                                                                                                                                                                |
| `PLAN.md`, `PROGRESS.md`                                                  | State-machine specification, dated evidence, issues and next steps.                                                                                                                                                                                                                                         |
| `LOCAL-PLAYTEST.md`, `PUBLICATION.md`, `FUTURE-MOBILE.md`                 | Manual playthrough, publication audit and later mobile direction.                                                                                                                                                                                                                                           |

`artifacts/` contains local screenshots, browser reports, logs and a real-time recovery script/report. It is intentionally ignored and **will not be in a fresh clone**. Generate fresh browser evidence with the command below; do not force-add local sessions/logs to Git.

## Exact setup, run and test commands

Prerequisites: Node.js 22 (use a maintained 22.x patch; `.node-version` is `22`), npm, and Git. Google Chrome is also required for the browser smoke test. The handoff machine used Node 22.12.0 and npm 10.9.0. No app API key or paid service is required locally.

For this existing Windows checkout, in PowerShell:

```powershell
Set-Location 'C:\Users\karee_4m899us\Documents\Projects\alibi'
git status --short
npm ci
npm start
```

Open **http://localhost:3000**. Keep the server terminal open; Ctrl+C stops it. Do not run a second copy if port 3000 is already occupied. From another terminal, check health with:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

To clone elsewhere, authenticate GitHub CLI with an account authorized to read the private repository, then:

```sh
gh repo clone KareemAl1/alibi
cd alibi
git switch codex/alibi
npm ci
npm start
```

For editing with automatic server restarts, stop `npm start` first and run:

```sh
npm run dev
```

`npm run dev` runs `node --watch server/index.js`. Restarts clear rooms/sessions. The plain frontend has no hot-module reload: reload the browser after frontend changes.

Run checks in the repository:

```sh
npm test
npm run test:browser
npx prettier --check "public/*.{js,css,html}" "server/*.js" "shared/*.js" "test/*.js" "*.md" package.json render.yaml
git diff --check
```

`npm test` launches isolated local HTTP/Socket.IO servers; sandboxed assistants need permission for loopback sockets. A sandbox denial is not evidence of a game bug. `npm run test:browser` launches installed Chrome in headless mode and its own ephemeral server; it does not need or replace localhost:3000. It writes to ignored `artifacts/review/`. `npm run format` formats files in place; it is optional and modifies the working tree.

For a human four-player test on this PC, use the Codex preview, normal Chrome, Chrome Incognito and normal Edge, or substitute Edge InPrivate for the preview. Multiple tabs in one profile are one player. See [LOCAL-PLAYTEST.md](LOCAL-PLAYTEST.md) for the full sequence and LAN-phone instructions.

## Environment variables — names and non-secret examples only

The server does **not** load `.env` automatically. Set variables in the shell or host dashboard. No secret values belong in the repository.

| Variable               | Default / purpose                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `3000`; platform-supplied on Render.                                                                                                                                                         |
| `HOST`                 | `0.0.0.0`; HTTP listening interface.                                                                                                                                                         |
| `NODE_ENV`             | Unset locally; `production` enables Secure cookies and requires an HTTPS origin.                                                                                                             |
| `PUBLIC_ORIGIN`        | Unset locally; in production the exact public HTTPS origin, with no path or trailing slash.                                                                                                  |
| `TRUST_PROXY_HOPS`     | `0`; number of trusted reverse proxies appending to `X-Forwarded-For`, used only to find the client address for the new-session rate limit. `render.yaml` sets `1`; confirm on first deploy. |
| `BROWSER_CHANNEL`      | Browser-test only; defaults to `chrome`.                                                                                                                                                     |
| `BROWSER_PATH`         | Browser-test and design capture only; path to a specific Chromium build. Overrides `BROWSER_CHANNEL`.                                                                                        |
| `BROWSER_ARTIFACT_DIR` | Browser-test only; defaults to `artifacts/review`. Keep any alternative output directory out of Git.                                                                                         |

Optional alternate local port, in PowerShell:

```powershell
$env:PORT = '3001'
npm start
```

Production shape only, using a placeholder hostname:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=<hosting-platform-provided-port>
PUBLIC_ORIGIN=https://your-alibi.example
```

Render's `RENDER_EXTERNAL_URL` is referenced by `render.yaml` to populate `PUBLIC_ORIGIN`. Do not paste GitHub tokens, session cookies, private keys, or hosting credentials into configuration examples or chat.

## Verification and known limitations

- **October 6:** all 40 engine/integration tests passed; JavaScript syntax and existing source/config formatting checks passed. No gameplay code changed in this handoff. Localhost:3000 was stopped.
- **September 30 browser evidence:** actual Chrome 154 driven by Playwright, four independent cookie contexts plus a late spectator, completed rounds/rematches, all accusation/guess outcomes, tie/runoff, privacy, refresh/offline recovery and host departure. Desktop/390px/320px layouts were checked. These browser checks were not rerun for the documentation handoff.
- **September 30 actual preview:** observed offline and rejected-session states, recovered via the page's reload action, and created a new room after restarting the server.
- **September 30 real elapsed-time socket evidence:** seats retained after 61 seconds, same seat restored at 65 seconds, another retained at 119 seconds and expired at 120.830 seconds. Separate from browser tests; most automated deadline tests otherwise use accelerated clocks.
- Rooms/sessions are in-memory and single-process. Restart/crash/deploy loses games. Replicas/autoscaling and durable recovery are unsupported.
- The session limiter is proxy-aware since October 6: returning players are limited per session, new sessions per client address, and `TRUST_PROXY_HOPS` (default 0) controls how many `X-Forwarded-For` hops are trusted. `render.yaml` sets 1; confirm the real hop count on the first deploy (see DEPLOYMENT.md).
- Physical iOS/Android devices, actual Discord switching/OS suspension/lock screen, Safari/Firefox, LAN/firewall connectivity, public HTTPS/WebSocket/cookie flow, hosting capacity, full accessibility and load/soak tests remain unverified. Chromium viewport checks do not prove physical-phone behavior.
- No known blocking game defect is recorded by the completed checks; this is not a production-readiness guarantee.

## Deployment and next steps

The source repository is private. There is **no public playable deployment**. `render.yaml` proposes exactly one persistent Render Node service, installs `npm ci --omit=dev`, starts `node server/index.js`, uses `/api/health`, sets production/same-origin HTTPS configuration, and disables code auto-deploys. No database, separate frontend host or domain purchase is needed for this architecture. Do not use static-only hosting or request-only serverless functions for this server unchanged.

Hosting remains a later user decision: Render account/payment method, repository access and approval of a paid service are still needed. The $7/month base quote and usage allowances in `DEPLOYMENT.md` were last checked September 30; recheck current pricing before asking for a paid-plan choice. GitHub publication does not authorize buying hosting or deploying. Blueprint Auto Sync must separately be disabled if the proposed setup is eventually used.

Recommended order for the next developer:

1. Start the existing app, read the dated evidence, and do the separate-session local walkthrough. Preserve the current visual identity and complete multiplayer loop.
2. After the user's hosting decision, deploy the existing single-instance architecture and verify HTTPS cookies/WebSockets plus a full four-player round at the public URL.
3. Playtest with real friends on desktop and physical phones, especially Discord switching, network loss, lock/unlock, refresh and host departure. Record failures without conflating automated tests and actual device checks.
4. Prioritize concrete playtest findings. Plan durable state/session recovery before relying on uninterrupted public games.

## Future iOS/Android goal

The user wants browser and future **iOS/Android app players to join the same rooms**. This is architectural direction, not permission to start a mobile app now. Keep all rules and authoritative state on the server, shared contracts reusable, and membership/reconnect/invite semantics independent of the browser UI.

After browser playtesting, evaluate an installable web app with a manifest/icons and safe update behavior. If adding a service worker, cache only public assets; exclude APIs, sockets, credentials and all private game state. Later choose a wrapper such as Capacitor or a separate native interface based on playtest needs. A native client will need an explicit authentication adapter, secure credential storage, protocol compatibility, universal/app links and suspension recovery. Do not weaken browser Origin protections as a shortcut. [FUTURE-MOBILE.md](FUTURE-MOBILE.md) contains the detailed path; no mobile framework has been selected.
