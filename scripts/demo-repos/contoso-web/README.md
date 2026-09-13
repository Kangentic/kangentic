# contoso-web

The Contoso customer portal: a React front end (`src/`) served by Vite, and an Express API
(`server/`) that handles login, subscriptions, and invoices.

## Scripts

- `npm run dev` starts the Vite dev server on port 5173.
- `npm run server` starts the API on port 4000.
- `npm test` runs the Vitest suite.
- `npm run typecheck` runs the TypeScript compiler with no emit.

## Layout

- `src/lib/websocket.ts` keeps the live-updates socket for the dashboard.
- `src/lib/http-client.ts` wraps fetch with retries.
- `server/routes.ts` registers every API route.
- `server/lib/jwt.ts` signs and verifies the session tokens.
- `server/rate-limit.ts` is the per-user rate limiter.
