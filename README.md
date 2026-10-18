# Kingdom Conquest v1.5 Final

Player + Admin tournament prototype.

- 7 kingdoms
- 21 player slots (3 per kingdom)
- 15 territories per kingdom = 105 total territories
- Interactive territory flags rendered as 3x5 grids for each kingdom
- Titan’s Keep is central and has no territory flags
- Territory challenge, blinking pending state, fighting-currently panel, battle resolution, and live ownership color changes
- Three initiated matches per player per shared clock-hour window, with public match usage and a live reset countdown
- Fifteen-minute defender response timer
- Admin ID: kamleshhhh
- Admin password: kamlesh078


## Admin player location map

The authenticated Admin > Personal Information page includes an approximate IP-geolocation map. When a player registers or reconnects, the server records the connection IP and requests approximate city/region/country coordinates from ipapi.co over HTTPS. Location lookup is best-effort; private/local IPs, unavailable lookups, VPNs, mobile carriers, and hosting proxies may prevent or distort results. The map uses Leaflet with OpenStreetMap tiles and requires an internet connection in the admin browser.

Only the authenticated admin state exposes IP and location data. Tell players that connection IPs are collected for tournament security, limit access to trusted admins, and retain this data only as long as needed. Do not treat IP location as a precise physical location or proof of identity.

If your host sits behind a reverse proxy, configure `TRUST_PROXY=true` only when the hosting proxy is trusted and overwrites `X-Forwarded-For`. Otherwise the server deliberately uses the direct socket address to avoid trusting spoofable forwarding headers.
