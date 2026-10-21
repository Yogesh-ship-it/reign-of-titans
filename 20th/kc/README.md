# Kingdom Catch v1.5 Final

Player + Admin tournament website with the Kingdom Catch landing page, navigation, leaderboard, rules, players, matches, and admin tools.

- 10 kingdoms
- 30 player slots (3 per kingdom)
- 15 territories per kingdom = 150 total territories
- Interactive territory flags rendered as 3x5 grids for each kingdom
- Titan’s Keep is central and has no territory flags
- Territory challenge, blinking pending state, fighting-currently panel, battle resolution, and live ownership color changes
- Five matches per player per personal two-hour period, with a live reset countdown
- Fifteen-minute defender response timer
- Admin ID: kamleshhhh
- Admin password: kamlesh078


## Admin player location map

The authenticated Admin > Personal Information page includes an approximate IP-geolocation map. When a player registers or reconnects, the server records the connection IP and requests approximate city/region/country coordinates from ipapi.co over HTTPS. Location lookup is best-effort; private/local IPs, unavailable lookups, VPNs, mobile carriers, and hosting proxies may prevent or distort results. The map uses Leaflet with OpenStreetMap tiles and requires an internet connection in the admin browser.

Only the authenticated admin state exposes IP and location data. Tell players that connection IPs are collected for tournament security, limit access to trusted admins, and retain this data only as long as needed. Do not treat IP location as a precise physical location or proof of identity.

If your host sits behind a reverse proxy, configure `TRUST_PROXY=true` only when the hosting proxy is trusted and overwrites `X-Forwarded-For`. Otherwise the server deliberately uses the direct socket address to avoid trusting spoofable forwarding headers.


## Tournament rules implemented in this build

- Unlimited registration submissions; registrations are saved immediately as pending.
- Administrator can approve up to 30 players. Only approved players can be assigned to kingdoms and participate.
- Tournament must be started by an administrator. Challenges and matches are blocked before the start and after the 48-hour period ends.
- Challenge acceptance window: 15 minutes. Once accepted, both players get a separate 5-minute check-in window. The match unlocks only after both check in.
- Multiple simultaneous matches are allowed across different territory/opponent pairings. A player cannot be in two active matches at once.
- An attacking kingdom must challenge a different opposing kingdom before challenging its previous opponent again. Multiple matches may run simultaneously; defending against the same kingdom repeatedly is allowed. Defending against the same kingdom remains allowed.
- Each player can start 5 matches per personal two-hour period.
- Each territory starts with 3 Defense Points; an unanswered/declined challenge removes one point from that territory. At zero Defense Points, an unanswered/declined challenge can cause automatic occupation. Territory Defense Points regenerate by one point per hour during the active tournament, up to 3.
- State is persisted in data.json using atomic file replacement. Set DATA_FILE to a path on persistent storage when deploying to a host that uses ephemeral filesystems; do not replace that database file when deploying website code updates.
