# Render permanent database setup

The application code is ready to use Render PostgreSQL, but a database cannot be created inside the live Render account from this ZIP alone. The Render account owner must create a PostgreSQL database and set the existing web service's `DATABASE_URL` environment variable to that database's **Internal Database URL**, then redeploy.

The server creates the `tournament_state` table automatically and stores the complete tournament state in PostgreSQL. When `DATABASE_URL` is missing on Render, the app refuses to start rather than silently accepting registrations into temporary JSON storage. `/api/health` reports whether PostgreSQL is ready.

Do not deploy this update to the live Render service until its `DATABASE_URL` is set. After deployment, open `/api/health` and confirm `"storage":"postgresql"` and `"databaseReady":true` before asking players to register.
