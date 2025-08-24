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

// BUY ON BUILTBYBIT
