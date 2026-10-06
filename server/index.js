import express from "express";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server } from "socket.io";
import { GameStore } from "./game.js";
import { CATEGORIES } from "./words.js";
import { CONNECTION_ERRORS } from "../shared/protocol.js";

const DAY = 86_400_000;
const publicPath = fileURLToPath(new URL("../public", import.meta.url));

export async function createAlibiServer({
  store = new GameStore(),
  origin = process.env.PUBLIC_ORIGIN,
  secure = process.env.NODE_ENV === "production",
  trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0),
} = {}) {
  if (secure && (!origin || !origin.startsWith("https://")))
    throw new Error("Production requires an HTTPS PUBLIC_ORIGIN.");
  if (
    !Number.isInteger(trustProxyHops) ||
    trustProxyHops < 0 ||
    trustProxyHops > 5
  )
    throw new Error("TRUST_PROXY_HOPS must be a whole number from 0 to 5.");
  const app = express();
  const httpServer = createServer(app);
  const sessions = new Map();
  const connections = new Map();
  const requestBuckets = new Map();
  const previousStates = new WeakMap();
  app.disable("x-powered-by");
  const sameOrigin = (req) => {
    const supplied = req.headers.origin;
    if (!supplied) return false;
    try {
      return (
        new URL(supplied).origin ===
        (origin || `${secure ? "https" : "http"}://${req.headers.host}`)
      );
    } catch {
      return false;
    }
  };
  // The client address for rate limiting. With no trusted proxies this is the
  // TCP peer. Behind N trusted reverse proxies, each proxy appends the address
  // it received from to X-Forwarded-For, so the client is the entry N places
  // from the right of [...forwarded, peer]. Entries further left are supplied by
  // the client and never trusted.
  const clientAddress = (req) => {
    const peer = req.socket?.remoteAddress || "unknown";
    let chain = [peer];
    if (trustProxyHops > 0) {
      const forwarded = String(req.headers["x-forwarded-for"] || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      chain = [...forwarded, peer];
    }
    const address = chain[Math.max(0, chain.length - 1 - trustProxyHops)];
    return address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  };
  const limited = (map, key, max, windowMs) => {
    const now = Date.now();
    let bucket = map.get(key);
    if (!bucket || now > bucket.until) {
      bucket = { count: 0, until: now + windowMs };
      map.set(key, bucket);
    }
    return ++bucket.count > max;
  };
  const readSession = (req) => {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("alibi_session="))
      ?.slice(14);
    const session = token && sessions.get(token);
    if (!session || session.expires < Date.now()) return null;
    return { token, ...session };
  };
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "4kb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.post("/api/session", (req, res) => {
    if (!sameOrigin(req))
      return res
        .status(403)
        .json({ error: "Open Alibi from its own address to join." });
    // Returning players are limited per session, so friends sharing one
    // network or proxy address never share a bucket. New sessions are limited
    // per client address.
    let session = readSession(req);
    const bucket = session
      ? `session:${session.token}`
      : `address:${clientAddress(req)}`;
    if (limited(requestBuckets, bucket, session ? 30 : 60, 60_000))
      return res
        .status(429)
        .json({ error: "Too many requests. Please wait a minute." });
    if (!session) {
      if (sessions.size >= 5000)
        return res
          .status(503)
          .json({ error: "The server is full. Please try later." });
      session = {
        token: randomBytes(32).toString("hex"),
        playerId: randomUUID(),
        expires: Date.now() + DAY,
      };
    }
    session.expires = Date.now() + DAY;
    sessions.set(session.token, {
      playerId: session.playerId,
      expires: session.expires,
    });
    res.cookie("alibi_session", session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      maxAge: DAY,
      path: "/",
    });
    res.json({ playerId: session.playerId });
  });
  app.use(express.static(publicPath, { index: "index.html", maxAge: 0 }));
  // GSAP is a runtime dependency served from node_modules (pinned by the
  // lockfile) so the page loads no third-party scripts.
  app.get("/vendor/gsap.min.js", (_req, res) =>
    res.sendFile(
      fileURLToPath(
        new URL("../node_modules/gsap/dist/gsap.min.js", import.meta.url),
      ),
    ),
  );
  // Deliberately expose this one public contract, never the server source/word pool.
  app.get("/shared/protocol.js", (_req, res) =>
    res.sendFile(
      fileURLToPath(new URL("../shared/protocol.js", import.meta.url)),
    ),
  );
  app.use((err, _req, res, _next) =>
    res.status(err.status || 500).json({
      error:
        err.status === 413
          ? "That request is too large."
          : "The request could not be processed.",
    }),
  );

  const io = new Server(httpServer, {
    maxHttpBufferSize: 8192,
    allowRequest: (req, callback) => callback(null, sameOrigin(req)),
    pingInterval: 10_000,
    pingTimeout: 5_000,
  });
  io.use((socket, next) => {
    const session = readSession(socket.request);
    const reject = (code, message) => {
      const error = new Error(message);
      error.data = { code };
      next(error);
    };
    if (!session)
      return reject(
        CONNECTION_ERRORS.sessionExpired,
        "Your session expired or the server restarted. Reload to connect again. A server restart clears all rooms.",
      );
    socket.data.playerId = session.playerId;
    socket.data.token = session.token;
    const tabs = connections.get(session.playerId);
    if (tabs?.size >= 8)
      return reject(
        CONNECTION_ERRORS.tooManyTabs,
        "Too many Alibi tabs. Close one, then reload to reconnect.",
      );
    next();
  });
  const broadcast = () => {
    for (const socket of io.sockets.sockets.values()) {
      const state = store.view(socket.data.playerId);
      const serialized = JSON.stringify(state);
      if (serialized !== previousStates.get(socket)) {
        previousStates.set(socket, serialized);
        socket.emit("state", state);
      }
    }
  };
  io.on("connection", (socket) => {
    const id = socket.data.playerId;
    let tabs = connections.get(id);
    if (!tabs) {
      tabs = new Set();
      connections.set(id, tabs);
    }
    tabs.add(socket.id);
    store.connect(id);
    socket.emit(
      "catalog",
      CATEGORIES.map(({ id, label, plainLabel, description, icon }) => ({
        id,
        label,
        plainLabel,
        description,
        icon,
      })),
    );
    broadcast();
    const handle = (event, mutate) =>
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
          const session = sessions.get(socket.data.token);
          if (!session || session.expires < Date.now())
            throw new Error("Session expired. Refresh to continue.");
          if (limited(requestBuckets, `actions:${id}`, 80, 10_000))
            throw new Error("A little too fast. Try again in a moment.");
          if (!payload || typeof payload !== "object" || Array.isArray(payload))
            throw new Error("Invalid request.");
          if (event === "room:create" && store.rooms.size >= 1000)
            throw new Error("The server is full. Try again later.");
          mutate(payload);
          broadcast();
          reply({ ok: true });
        } catch (err) {
          reply({
            ok: false,
            error: err.message || "That action is unavailable.",
          });
        }
      });
    handle("room:create", (payload) => store.create(id, payload));
    handle("room:join", (payload) => store.join(id, payload));
    handle("action", (payload) => store.act(id, payload));
    handle("state:sync", () => previousStates.delete(socket));
    socket.on("disconnect", () => {
      tabs.delete(socket.id);
      if (!tabs.size) {
        connections.delete(id);
        store.disconnect(id);
      }
      broadcast();
    });
  });
  const timer = setInterval(() => {
    store.sweep();
    const now = Date.now();
    for (const [token, s] of sessions)
      if (s.expires < now) {
        sessions.delete(token);
        for (const socketId of connections.get(s.playerId) || [])
          io.sockets.sockets.get(socketId)?.disconnect(true);
      }
    for (const [key, b] of requestBuckets)
      if (b.until < now) requestBuckets.delete(key);
    broadcast();
  }, 1000);
  timer.unref();
  return {
    app,
    io,
    httpServer,
    store,
    listen: (port = 0, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve(httpServer.address().port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        io.close(() => {
          if (httpServer.listening) httpServer.close(resolve);
          else resolve();
        });
      }),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = await createAlibiServer();
  const port = await server.listen(
    Number(process.env.PORT || 3000),
    process.env.HOST || "0.0.0.0",
  );
  console.log(`Alibi is listening at http://localhost:${port}`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
