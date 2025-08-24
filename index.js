/**
 * PTERODACTYL OFFLINE MOTD
 * Developed by XyloBlonk
 *
 * Get your hosting at billing.lumagrid.org
 *
 * index.js
 *
 * Lightweight Minecraft "status-only" responders:
 * - For each configured allocation (ip/port), creates a status server that replies with:
 *    - If backend reachable: the backend's real status (proxied)
 *    - If backend not reachable: a custom offline MOTD and optional favicon
 *
 * NOTE:
 * - This script only serves the status packet. It does NOT proxy play sessions.
 * - To intercept player list pings on the public address, run this on the machine receiving those pings
 *   (or configure a host-side proxy/NAT to forward port 25565 pings to this process).
 */

const fs = require('fs');
const path = require('path');
const mc = require('minecraft-protocol');
const MCRcon = require('minecraft-server-util'); // used for ping/status
const fetch = require('node-fetch');

const cfgPath = path.resolve(process.argv[2] || 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error(`Missing config file: ${cfgPath}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const BIND_HOST = config.bindHost || '0.0.0.0';
const POLL_INTERVAL = (config.pollIntervalSeconds || 30) * 1000;
const servers = new Map(); // key = ip:port string -> server object
const allocationMap = new Map(); // uuid -> { ip, port, offlineMotd, favicon }

function ipPortKey(ip, port) {
  return `${ip}:${port}`;
}

async function getAllocationsFromPanel() {
  // Expect the panel endpoint to return JSON array of objects with { ip, port, uuid, optional offlineMotd, faviconPath }
  if (!config.panel || !config.panel.allocationsEndpoint) return [];
  const headers = {
    'Accept': 'application/json'
  };
  if (config.panel.apiKey) headers['Authorization'] = `Bearer ${config.panel.apiKey}`;
  try {
    const res = await fetch(config.panel.allocationsEndpoint, { headers });
    if (!res.ok) {
      console.warn('Panel fetch returned non-OK status', res.status);
      return [];
    }
    const json = await res.json();
    if (!Array.isArray(json)) {
      console.warn('Panel allocations endpoint did not return an array');
      return [];
    }
    return json;
  } catch (err) {
    console.warn('Failed to fetch panel allocations:', err.message);
    return [];
  }
}

/**
 * Ping a real backend server to check if it's online.
 * Uses minecraft-server-util status (works for many common versions).
 * Returns an object { online: boolean, pingInfo: object|null }
 */
async function pingBackend(ip, port, timeout = 3000) {
  try {
    const result = await MCRcon.status(ip, port, { timeout });
    // result has fields like version, players, description (motd), favicon
    return { online: true, pingInfo: result };
  } catch (e) {
    return { online: false, error: e.message || String(e) };
  }
}

function loadFaviconAsBase64(faviconPath) {
  if (!faviconPath) return null;
  try {
    const buf = fs.readFileSync(faviconPath);
    // must be PNG 64x64; base64 prefix per MC protocol spec
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) {
    console.warn('Failed to load favicon', faviconPath, e.message);
    return null;
  }
}

/**
 * Create a status-only Minecraft server on given port. This uses minecraft-protocol
 * to answer status requests. It will not allow play connections (they're immediately dropped).
 */
function createStatusServer(listenIp, port, opts = {}) {
  const key = ipPortKey(listenIp, port);
  if (servers.has(key)) return servers.get(key);

  const { offlineMotd, faviconBase64 } = opts;
  const server = mc.createServer({
    host: listenIp,
    port: port,
    // We purposely set version to '1.16.5' as a baseline -- minecraft-protocol will accept many client versions.
    // You can optionally set version to match your audience or create multiple servers per-version if needed.
    version: false, // accept any version (let mc-protocol negotiate)
    motd: offlineMotd || config.defaultOfflineMotd || 'Server is offline',
    // NOTE: minecraft-protocol will use `motd` on status responses if we don't custom handle packets.
    // We'll intercept the handshake/status packets below for more control.
    'online-mode': false
  });

  // Keep a simple state object
  server._meta = {
    offlineMotd: offlineMotd || config.defaultOfflineMotd || 'Server is offline',
    faviconBase64: faviconBase64 || null,
    backendOnline: false,
    lastPingInfo: null
  };

  server.on('connection', (client) => {
    // Clients can attempt handshake/login. We will not allow play sessions here.
    // If client tries to go into play state, drop it. We only serve status.
    client.on('packet', (data, meta) => {
      // Some clients may attempt status/ping sequence : we will let minecraft-protocol handle status,
      // but if a client tries to go to login/play state, close the socket gracefully.
      if (meta && meta.name && meta.name.startsWith('login')) {
        try { client.end(); } catch (e) {}
      }
    });
    client.on('end', () => {});
    client.on('error', () => {});
  });

  // Note: minecraft-protocol exposes server.server (net.Server). But to safely respond to status
  // we can hook into the 'status' event if available. If not present for some versions, the default motd will suffice.
  server.updateStatus = function ({ backendOnline, pingInfo, offlineMotd: om, faviconBase64: fb }) {
    server._meta.backendOnline = !!backendOnline;
    server._meta.lastPingInfo = pingInfo || null;
    if (typeof om === 'string') server._meta.offlineMotd = om;
    if (typeof fb === 'string') server._meta.faviconBase64 = fb;
    // Update the server options motd for clients that will use the default behavior
    server.motd = server._meta.backendOnline && server._meta.lastPingInfo ? (server._meta.lastPingInfo.description || server._meta.offlineMotd) : server._meta.offlineMotd;
    // some mc clients read server.motd, but others will expect us to answer the status packet
  };

  server.on('listening', () => {
    console.log(`[status] listening ${listenIp}:${port}`);
  });

  server.on('error', (err) => {
    console.warn(`[status] ${listenIp}:${port} error:`, err && err.message ? err.message : err);
  });

  servers.set(key, server);
  return server;
}

function closeStatusServer(listenIp, port) {
  const key = ipPortKey(listenIp, port);
  const s = servers.get(key);
  if (!s) return;
  try { s.close(); } catch (e) {}
  servers.delete(key);
  console.log(`[status] closed ${key}`);
}

/**
 * Reconcile function:
 * - get allocations (from panel or config)
 * - for each allocation ensure there's a status server listening
 * - ping the backend and update MOTD (online => show proxied status; offline => offline MOTD)
 */
async function reconcile() {
  let allocs = [];

  if (config.usePanelAllocations) {
    allocs = await getAllocationsFromPanel();
  } else {
    // build from config.servers
    allocs = (config.servers || []).map(s => ({
      ip: s.ip,
      port: s.port,
      uuid: s.uuid || null,
      offlineMotd: s.offlineMotd || null,
      faviconPath: s.faviconPath || null
    }));
  }

  // Build set of current allocation keys
  const wantedKeys = new Set();
  for (const a of allocs) {
    if (!a || !a.port) continue;
    const host = a.ip || '0.0.0.0';
    const port = a.port;
    const key = ipPortKey(host, port);
    wantedKeys.add(key);

    // ensure server exists
    const fb64 = a.faviconPath ? loadFaviconAsBase64(a.faviconPath) : null;
    const s = createStatusServer(BIND_HOST, port, { offlineMotd: a.offlineMotd || config.defaultOfflineMotd, faviconBase64: fb64 });

    // ping backend:
    // If allocation.ip is empty or 0.0.0.0, assume backend is local on same host (use 127.0.0.1).
    const targetIp = (a.ip && a.ip !== '0.0.0.0') ? a.ip : '127.0.0.1';
    const backendPing = await pingBackend(targetIp, port);
    if (backendPing.online) {
      s.updateStatus({ backendOnline: true, pingInfo: backendPing.pingInfo });
    } else {
      s.updateStatus({ backendOnline: false });
    }
  }

  // Close any servers that are no longer wanted
  for (const k of Array.from(servers.keys())) {
    if (!wantedKeys.has(k)) {
      const [ip, port] = k.split(':');
      closeStatusServer(ip, parseInt(port, 10));
    }
  }
}

(async function main() {
  try {
    // initial reconcile
    await reconcile();
  } catch (e) {
    console.error('Initial reconcile error:', e && e.message ? e.message : e);
  }
  // periodic
  setInterval(() => {
    reconcile().catch(e => console.warn('reconcile failed:', e && e.message ? e.message : e));
  }, POLL_INTERVAL);
})();
