# Put Alibi online

Deployment configuration and official pricing were last checked September 30, 2026. Handoff status updated October 6: source repository [KareemAl1/alibi](https://github.com/KareemAl1/alibi) is private; no game deployment or hosting purchase has occurred. Recheck the cost figures below before a paid-plan decision. The paid plan in `render.yaml` is a proposal, not an approved purchase; importing it and choosing Deploy would create a billable service.

The simplest fit for this version is **one paid Render Node web service**. It runs the existing Express server, browser files, and Socket.IO endpoint together at one HTTPS address. Friends open that address, create a room, and share its invite link. No separate frontend host, database, Docker image, or mobile app is required for this playtest. Render supports public WebSockets without a fixed connection duration; disconnects can still occur during deploys, maintenance, or network changes. [Render WebSockets](https://render.com/docs/websocket)

## Accounts and cost before deployment

- A Render account with a payment method and permission to create a paid web service.
- Permission for Render to read the private [KareemAl1/alibi](https://github.com/KareemAl1/alibi) repository, selecting the `codex/alibi` branch. The source repository is prepared; Render has not been connected or deployed by this project work.
- Agreement to the paid service: the **0.5c-512mb** plan is **US$7/month** for 0.5 CPU and 512 MB RAM, on a **US$0/month Hobby workspace**. This plan used to be called Starter. The supplied configuration creates exactly one service and no paid database or disk. A paid Pro workspace is not required. Compute billing is prorated to the second. [Pricing](https://render.com/pricing), [current plan names](https://render.com/docs/compute-plans)
- The $7 is the base compute price, not a hard bill cap. Hobby currently includes 5 GB of monthly outbound bandwidth, then $0.15/GB, and 500 standard build minutes, then $5 per 1,000 minutes. Review the estimate and billing settings in the account before creating the service. No custom domain purchase is necessary; use Render's supplied HTTPS address. [Pricing](https://render.com/pricing)

These figures describe a new Hobby workspace and one service. Existing services share the workspace's included usage. If the chosen account has a legacy workspace plan, confirm its actual plan and remaining allowances on its Billing page before deciding; no account or billing changes are needed for the local playtest. [Workspace plan changes](https://render.com/docs/new-workspace-plans)

Render Free can demonstrate the app, but it sleeps after 15 minutes without inbound HTTP traffic or WebSocket messages and takes about a minute to wake. Its process restart clears Alibi's rooms and sessions. The paid configuration avoids this idle sleep, which makes it a better fit for a link shared with friends. Paid instances can still restart; they do not make rooms durable. [Free service limitations](https://render.com/docs/free)

## What the prepared configuration does

[`render.yaml`](render.yaml) uses Render's native Node runtime, installs only locked production dependencies, and starts `node server/index.js`. [`.node-version`](.node-version) selects the latest available Node 22 patch instead of allowing the platform to silently move to a new major version. There is no frontend build step. [Node version selection](https://render.com/docs/node-version)

The service has one instance in Virginia, listens on `0.0.0.0` using Render's supplied `PORT`, and checks `/api/health`. `NODE_ENV=production` enables Secure session cookies. `PUBLIC_ORIGIN` references this service's own `RENDER_EXTERNAL_URL`, so the initial generated hostname is correct without guessing it. The current app rejects session creation and socket connections from a different origin. [Blueprint specification](https://render.com/docs/blueprint-spec), [Render environment variables](https://render.com/docs/environment-variables)

Code auto-deploys are off. This avoids ordinary code pushes interrupting games. Blueprint **Auto Sync is a separate dashboard setting**: after creating the Blueprint, set **Auto Sync to No** as well. Otherwise a pushed `render.yaml` change can still redeploy the service. Schedule manual deploys when no one is playing. [Blueprint sync behavior](https://render.com/docs/infrastructure-as-code)

## Deployment steps once account access and cost are approved

1. Confirm the tested handoff is on the private repository's `codex/alibi` branch. Include `package-lock.json`, `render.yaml`, `.node-version`, `server/`, `shared/`, and `public/`. Select this tested branch when linking Render.
2. Sign in to Render, connect that repository, and choose **New > Blueprint**. Select its branch and the root `render.yaml` file. Review the proposed single web service and its price before choosing **Deploy Blueprint**. [Blueprint setup](https://render.com/docs/infrastructure-as-code)
3. Set the Blueprint's **Auto Sync to No**. Confirm the service also shows code auto-deploys off and exactly one instance. Keep autoscaling disabled.
4. Wait for the health check to pass. Open the generated `https://…onrender.com` address and verify `/api/health` returns `{"ok":true}`. The log currently prints an internal `localhost` listening address; share the public HTTPS URL shown by Render instead.
5. Run the public checks below before distributing the link widely. Invite friends with the room link generated on the public address.

If the Render service is renamed in the YAML, change both occurrences of `name: alibi` so the origin reference still points to itself. If choosing a region other than Virginia, change it before creating the service.

For a later custom domain, replace the `PUBLIC_ORIGIN` reference in `render.yaml` with the exact public HTTPS origin, with no path or trailing slash, after setting up its domain and certificate. Use that one address consistently. Cookies are scoped to their host, so switching hostnames creates a different browser session and does not transfer an existing seat. Do not merely change the dashboard variable while leaving a conflicting Blueprint definition.

## Requirements confirmed by reading the backend

- `server/index.js` attaches Socket.IO to the same HTTP server that serves `public/`. A persistent Node process is necessary; static hosting or request-only serverless functions cannot run this server unchanged.
- Production startup requires an HTTPS `PUBLIC_ORIGIN`. The origin check compares incoming `Origin` to that value. The session cookie is opaque, HttpOnly, SameSite=Lax, and Secure in production; the browser does not need access to a token. TLS can terminate at Render's proxy because the app sets its Secure cookie explicitly.
- `PORT` and `HOST` are configurable. `/api/health` does not require a session. HTTP requests and WebSocket upgrades use the same public service port.
- Rooms, sessions, presence, and game state live in process memory. **Keep one Node process and one instance.** Do not add a cluster manager, replicas, or autoscaling. Sticky routing alone cannot make this data shared or durable.
- **Restarting, deploying, or replacing the process loses every room and session.** A platform's zero-downtime HTTP deployment does not preserve an active game. A persistent disk alone would not help because this app does not write its state to disk.
- The session endpoint currently limits creation/refresh requests by the TCP peer address (60/minute). Behind a reverse proxy, clients can share that bucket. This is acceptable for a small friend playtest, not a verified public-scale limit; proxy-aware rate limiting should be addressed before a broad launch.

## Public verification still required

The configuration is prepared locally. No Render build, HTTPS cookie flow, external WebSocket connection, hosting capacity, or physical mobile connection has been tested. Local automated tests and local browser playthroughs do not establish those results. The milestone's actual browser evidence is recorded separately in [`PROGRESS.md`](PROGRESS.md).

After the first deploy:

1. Use four independent sessions, including at least one phone on cellular data. Create a room, open its invite, and complete private reveal, ready, speaking turns, discussion, private voting, final guess, results, and rematch.
2. Check the HTTPS session cookie and successful WebSocket connection in browser network tools. Confirm that an imposter never receives the word before results.
3. Refresh and temporarily interrupt a connection; confirm the existing seat returns within its grace window. Check host departure and the next host's controls.
4. Switch between Alibi and Discord, lock/unlock a physical phone, and return after both a short and a longer absence. Check the visible recovery message and server deadline behavior. Responsive desktop emulation cannot verify OS background suspension.
5. With only a disposable test room open, restart the service. Confirm the UI explains that the previous room is gone and that players can start a fresh room.

## Future app compatibility

This hosting arrangement can serve the authoritative game to future browser and app clients. Keep `server/game.js` responsible for rules and outcomes, and keep room codes, stable player identity, action identifiers, deadlines, and reconnect rules independent of screen layout. The later mobile milestone can reuse the protocol and validation contract; it should not copy authority into an app.

After playtesting, an installable web app can add a manifest, icons, and an update/offline shell without caching private role snapshots, `/api/session`, or Socket.IO traffic. A native wrapper or a separate mobile interface can be evaluated later. A native client needs an explicitly designed authentication and origin policy, secure local credential storage, app/browser invite links, and recovery after suspension. Do not weaken the current browser origin checks as a shortcut. No PWA service worker, native project, or app-store deployment is included in this milestone.
