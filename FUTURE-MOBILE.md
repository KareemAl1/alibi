# Alibi: browser now, shared rooms on mobile later

The current milestone is the browser game. No mobile project, native dependency, service worker, store submission, or alternate game mode is part of this work. Browser and future app players can use the same rooms by connecting to the same authoritative Alibi service; the server rules do not need to move into an app.

## Boundaries to preserve

| Responsibility                                                         | Current owner                           | Future reuse                                                                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules, randomness, deadlines, roles, votes, outcomes                   | `server/game.js`                        | Keep one authoritative engine for every client. It has no DOM or browser-storage dependency.                                                                    |
| Membership, reconnect grace, host transfer, fixed round roster         | `GameStore`                             | Keep these keyed by the server's stable player identity, never by a tab, device screen, or Socket.IO connection ID.                                             |
| Credentials, connection counts, request limits, personalized snapshots | `server/index.js`                       | Adapt authentication and transport when a native client is actually selected. Every adapter must call the same engine and recipient-specific `view()` boundary. |
| Rendering, hidden/revealed card, selected suspect, text entry          | `public/app.js`                         | A client presents authoritative snapshots and sends intentions. UI state never decides a result or changes membership.                                          |
| Invite presentation                                                    | Browser URL `/?room=CODE` and clipboard | A room code is a transport-independent invitation. Parsing/opening a link belongs in each platform's thin navigation adapter.                                   |

The complete word pool, accepted guess variants, hidden role assignment, and open-ballot choices remain server-only. Each player receives only the private fields their role permits, followed by the public result when the round ends. Public shared modules must never import the word pool or serialize full room state. A host is another participant and gets no special access to other private cards.

The current `shared/protocol.js` contains a protocol version, public timing constants, an action-envelope typedef and builder, basic envelope validation, and room-code normalization. These helpers have no dependency on `window`, `document`, `location`, cookies, or local storage. Server checks of membership, permissions, phase, round, turn, and ballot remain mandatory after shape validation. Public category metadata, public snapshot types, acknowledgement/error shapes, and full per-message schemas can extend this contract when a second interface needs them; JSDoc or TypeScript types alone are not runtime validation.

Preserve unique action IDs and the existing room/round/turn/ballot identifiers. Retry an uncertain operation only with its original action ID after resynchronizing; do not blindly replay button presses after a background interval. A future published mobile client may stay installed through several server releases, so define a supported protocol-version range, additive field changes, and a clear upgrade-required response before releasing it.

## Backgrounding is an interruption, not a leave action

Phone browsers can suspend JavaScript or discard a background page. A hidden page may never run a final unload callback, and frozen timers cannot maintain a connection. Installing a web app does not remove these platform constraints. The client should conceal a private card when hidden, reconnect or request a fresh authoritative snapshot when visible again, and enable game actions only after that synchronization. [Chrome page lifecycle guidance](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

Do not call `leave` on `blur`, `visibilitychange`, or page shutdown. A trip to Discord is not a decision to leave the room. Explicit Leave still removes the seat immediately. Transport loss starts the server's reconnect grace after it detects the last connection going away; host control transfers to a connected player immediately and does not automatically transfer back. A second tab in the same browser profile shares one seat and keeps it connected while its socket remains open.

The current seat-grace duration is **120 seconds after detected disconnect**, defined in `GAME_TIMING.disconnectGraceMs`. It gives a brief Discord switch more room than the previous minute, but it is a product policy, not a promise that an operating system keeps the app alive. Reveal, ballot, and final-guess deadlines continue on the server while any phone is hidden or offline. Their current limits are 120 seconds, 90 seconds, and 60 seconds respectively. A reserved seat does not extend those phase deadlines. During clues the host can advance a stalled speaker; disconnected players never acquire an invented clue, readiness, vote, or guess.

The round roster is fixed at start. An explicit departure or expired participating seat abandons an active round with no winner, preserving a clear result and allowing another round. Late arrivals wait for the next round. An incomplete readiness/ballot deadline also abandons; the final-guess deadline awards the group the win unless seat expiry or explicit departure has already abandoned the round. After seat expiry, returning to the invite can join a waiting seat, but cannot restore that round's private role.

Automatic Socket.IO reconnect covers ordinary transport loss. A server-initiated disconnect or authentication rejection requires deliberate recovery. An expired session should lead to a clear refresh/rejoin path; a fresh credential cannot silently recover a seat belonging to a lost or expired credential. [Socket.IO connection lifecycle](https://socket.io/docs/v4/client-socket-instance/)

Sessions and rooms currently exist in one server process. Restarting it loses both, even if the phone still has its cookie. Durable recovery is a backend milestone; a mobile wrapper or service worker cannot supply it. Only nickname/avatar preferences belong in ordinary client storage. Do not persist roles, secret words, private snapshots, or session credentials in local storage.

## Next: installable web experience after playtesting

1. Keep the existing HTTPS website and multiplayer service. Add a web manifest, stable app ID, icons, a standalone display mode, theme colors, and a room-neutral start URL. Preserve incoming invite links when opening an already installed app.
2. Check installation and launch on actual iOS and Android devices. Install UI differs by browser, so keep the ordinary browser invitation working. HTTPS and manifest metadata support installation; a service worker is a separate choice, not an excuse to add offline gameplay. [PWA installation guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
3. If a service worker is later useful, cache only versioned public assets and a simple offline explanation. Exclude `/api/`, Socket.IO traffic, credentials, and all room/private state. Apply client updates between rounds, then reconnect and resynchronize before enabling actions.
4. Playtest safe-area padding, small screens, touch targets, browser chrome, the on-screen keyboard, orientation changes, and primary actions. Include Discord switching, lock/unlock, Wi-Fi-to-cellular changes, refresh, and return before/after both seat and phase deadlines.

Use a home-screen install as a convenience, not a requirement to join. Do not assume that a standalone install, a browser tab, and a different device share the same cookie or identity. Joining the same room as another participant is supported by the architecture; moving an existing private seat between clients requires a separate, secure design.

## Later: choose a store app using playtest evidence

| Option                                       | What can be reused                                                       | Decision to make after playtesting                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capacitor container around the web interface | Most HTML/CSS/JavaScript, art, and protocol                              | Likely the shortest route if the web interaction already feels good. Add native lifecycle, links, and credential adapters deliberately. [Capacitor documentation](https://capacitorjs.com/docs)                       |
| React Native or platform-native interface    | Server engine, public contract, validation rules, assets where supported | Consider when native navigation/accessibility/interaction warrants another UI implementation. React Native uses native platform components. [React Native introduction](https://reactnative.dev/docs/getting-started) |

Both approaches should connect to the same HTTPS/Socket.IO backend as the browser. Do not embed the game engine, private word pool, or authority in the app. Do not introduce a separate mobile room population.

The current browser transport uses an HttpOnly, Secure-in-production, same-origin cookie and strict Origin checks. A bundled app has different networking and origin behavior, so simply pointing a webview at the API is not a completed authentication design. Introduce a narrow session adapter later: browser cookies stay protected; native credentials use the platform's secure storage and authenticated transport, with expiration/revocation, and resolve to the same server-side player identity. Never accept a client-supplied player ID as proof of membership, put credentials in invite URLs, or remove browser origin protections to make a wrapper connect. Joining a shared room does not require sharing a browser's credential with an app.

Retain ordinary HTTPS invites, then add verified iOS Universal Links and Android App Links for the chosen domain and app identifiers. An installed app can open the room; otherwise the same link should fall back to the browser. Keep manual room-code entry. [Apple Universal Links](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app), [Android App Links](https://developer.android.com/training/app-links)

Store distribution will require the user's developer accounts, signing/build setup, current store policy review, and separate approval of account fees and any build-service costs. No accounts or purchases are needed for this browser milestone. Choose a mobile approach and verify then-current requirements after the first real-device playtests.

## Evidence boundary

See `PROGRESS.md` for checks actually performed in the current run. Desktop Chromium with phone-sized viewports can verify responsive layout and scripted reconnect behavior, but does not prove iOS/Android background suspension, a notched display's safe areas, a real keyboard, installation, Universal Links/App Links, native credential handling, or store acceptance. Those remain future device/platform checks until explicitly recorded otherwise.
