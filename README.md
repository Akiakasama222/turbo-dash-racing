# Turbo Dash Racing – Vercel deploy

Files: `index.html` (the game), `api/race.js` (shared race state), `package.json`.

## Deploy
1. Put this folder in a GitHub repo (or run `npx vercel` in this folder).
2. Vercel dashboard -> New Project -> import the repo -> Deploy.
3. In the project: **Storage -> Create Database / Marketplace -> Upstash Redis** -> connect it to the project
   (it adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically).
4. **Redeploy** (Deployments -> ... -> Redeploy) so the env vars are picked up.
5. (Optional) Settings -> Environment Variables -> add `REFEREE_PIN` (e.g. 1234) so only the referee can start/reset. Redeploy again.

Open the site: Referee tab on one device, Racers tab on the others.
