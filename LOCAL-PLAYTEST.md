# Local playtest

Keep the local Node server running and use the same address in every session: **http://localhost:3000**. The Codex preview is a separate browser session, so it can be your host.

## Four separate players on one computer

1. In the Codex preview, enter `Host`, click **Create a private room**, and copy its invite link.
2. Open that invite in a normal Chrome window. Join as `Alex`.
3. Open the invite in a Chrome Incognito window. Join as `Sam`.
4. Open the invite in a normal Edge window. Join as `Jo`.

These are four independent cookie stores. Four ordinary Chrome tabs are one player. Multiple Chrome Incognito windows also share a player while that private session is open. If you prefer not to use the Codex preview, use Edge InPrivate for the fourth independent session.

Confirm the host's room shows four different names before starting. Every browser must show **Connected · let's play**. Use distinct avatars to make switching windows easier.

## One complete round

1. As host, choose categories and **Start the round**.
2. In each session, **Reveal my card**, remember the word or imposter role, then **I'm ready**. In a real game, each friend checks only their own card. For this solo check, note who is the imposter so you can exercise the final guess deliberately.
3. All four sessions should show the same speaker. Say a clue aloud; in that speaker's session, click **Done with my clue**. Repeat until discussion. The host can test pause/resume or advance a stalled turn.
4. As host, choose **Start private voting**. Have the three insiders select the imposter. The imposter must select someone else. Click **Lock in my vote** in each session. Until the last vote, check that only the participation count appears, with no other players' choices.
5. In the imposter session, submit one final guess. Results should match across all four sessions and reveal the word, imposter and votes. Choose **Next round** as host to test a rematch. You can test a correct and incorrect guess in successive rounds.

## Recovery and host transfer

Do the longer interruption checks in the lobby, where voting/readiness/guess deadlines cannot end your round first.

- **Refresh:** reload a joined player's page. The same name, room and seat should return. During a round, the role is preserved but the private card is concealed.
- **Brief interruption:** close one normal Chrome player's only game tab, keeping that browser profile open. The other sessions should show the player reconnecting. Reopen the exact invite in the same profile within two minutes. Closing every Incognito window destroys its cookies, so that is not a valid seat-recovery test.
- **Host departure:** close the host's game tab. Once the server detects loss, host control transfers immediately. Reopen with the same browser session within two minutes: the original seat returns, but the replacement host keeps control.
- **Grace expiry:** leave a non-host session disconnected for more than two minutes after peers display it as reconnecting. Its seat is then removed. If it was an active round participant, the round ends without a winner. **Leave room** is immediate and does not use the grace period.

The seat window is **120 seconds (2 minutes) after the server detects disconnection**, plus up to approximately one second for the expiry sweep. Network heartbeat detection can add time before the window starts. Reveal readiness has its own 120-second deadline, each ballot 90 seconds, and the final guess 60 seconds. These deadlines keep running while someone is away.

## If the preview says reconnecting

Check [the health endpoint](http://localhost:3000/api/health). If it returns `{"ok":true}`, the server is reachable. If the page says **Reload to reconnect**, use its reload link: the session expired or was rejected, and automatic socket retries cannot recover it. An old already-open page may still contain obsolete messages; reload it to load the current interface.

If the health endpoint cannot connect, start the app from this repository with `npm start`, keeping the terminal open. Use `npm run dev` only while editing; its restarts erase rooms. If the start command reports `EADDRINUSE`, another server already owns port 3000; check the existing health endpoint instead of starting more copies. Background-server logs and PID, when started by Codex, are under ignored `artifacts/`.

A server restart clears all room/session memory. Reloading restores connectivity but cannot restore the lost game. Create a new room and share its new invite. This is different from a temporary player network interruption on a continuously running server.

## Phones and friends

For phones on the same Wi-Fi, use `http://YOUR-COMPUTER-LAN-IP:3000` everywhere and create the room at that address. Your computer must stay awake and allow port 3000 through its firewall. `localhost` on a phone means the phone itself. Do not mix localhost and LAN URLs within a player session: cookies belong to each host separately.

Friends outside your network will need the proposed hosted HTTPS service. No repository publication, hosting purchase, or deployment is part of this local test. See [DEPLOYMENT.md](DEPLOYMENT.md) for the prepared setup and verified prices.

Physical phone lock-screen/Discord switching, Safari/Firefox and real public hosting remain separate playtest checks. Existing Chromium viewport checks and socket tests do not prove those behaviors. The future PWA and store-app route is documented in [FUTURE-MOBILE.md](FUTURE-MOBILE.md).
