# pterodactyl-offline-motd
Gives your minecraft server run inside docker via pterodactyl wings an offline motd

# Important constraints & notes (please read):

- This does not and cannot magically intercept traffic for servers that the host OS has already bound elsewhere. To return a custom MOTD for public players, this script must run on a host which actually receives the server list ping traffic (either because it is the machine bound to those ports, or because you redirect traffic to it using a proxy / iptables / NAT rules).

- If you run this on a Wings node that you control and you also run a host-side proxy (Velocity / Bungee / builtbybit offline-motd or iptables redirect) that forwards pings to this script, it will work as intended.

- This script purposely only responds to server-list pings (status requests). It will not allow players to join; if a player attempts to actually log in to a status-only listener the connection is rejected. That keeps it safe and simple.

- You can optionally use your Pterodactyl panel endpoint to provide a list of allocations (IP + port + server uuid). The script expects that endpoint to return JSON with entries like `{ "ip": "1.2.3.4", "port": 25565, "uuid": "..." }`

- I'd highly recommend running this on the host (Your machine) and not docker as it complicates the networking as docker is an isolated environment so communication and proxying is difficult without exposing traffic to the public network unless you have private networking.

## How to use / deploy

1. Create and edit config.json; set usePanelAllocations: true and panel.allocationsEndpoint to a lightweight endpoint that returns a JSON array of { ip, port, uuid, offlineMotd?, faviconPath? }. If you do not want to expose your panel API, you can create a small HTTP endpoint that returns this list and is called by this script.

2. Place any custom favicon.png files and point to them in faviconPath.

3. Run:
```
npm install
node index.js config.json
```

Make sure the machine receives the status ping traffic for the ports you want to control. If you're running this on a Wings node and want it to answer public pings for a port, you must ensure the host's firewall/proxy forwards the server-list ping packets to this script. BuiltByBit-style offline-motd solutions typically put a host-side proxy (Velocity) in front of game servers and route status pings to a responder; this script is the responder.

## Security & hardening suggestions

- Run this as a non-root user and only bind to the addresses/ports you intend to control. If you need to bind privileged ports, use firewall/NAT rules instead of running as root.

- If you integrate with Pterodactyl Panel, prefer an endpoint with read-only, scoped data (don’t feed admin keys).

- Log and monitor what IPs/ports the script is opening (rotate logs).

- If you want wake-on-join behavior (spin up the actual container via Pterodactyl), that can be added but be careful and use scoped API keys and rate-limits to avoid abuse.
