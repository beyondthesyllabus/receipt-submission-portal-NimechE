# Receipt Portal

Students enter their **name** and **registration number**, then upload photos or PDFs of their
payment receipts. You get an **admin page** that lists everyone in a table and exports one
printable PDF: the register table first, then every receipt on its own page (with the student's
name and reg. number at the top of each page).

## Run it on your computer

1. Install Node.js 18 or newer from https://nodejs.org
2. In this folder:

   ```
   npm install
   ADMIN_PASSWORD="choose-a-strong-password" npm start
   ```

   On Windows (PowerShell):

   ```
   $env:ADMIN_PASSWORD="choose-a-strong-password"; npm start
   ```

3. Students use:  http://localhost:3000
   Admin page:    http://localhost:3000/admin

## Put it online

Students need a public address, so host it on a Node.js host. Two easy routes:

**Render.com (simplest)**
1. Push this folder to a GitHub repository.
2. On Render: New > Web Service > pick the repo. Build command `npm install`, start command `npm start`.
3. Environment variables: `ADMIN_PASSWORD` (required), `DATA_DIR=/var/data`.
4. Add a **Disk** (Render paid plan) mounted at `/var/data`. Without a persistent disk, uploaded
   receipts are wiped every time the service restarts or redeploys.

**Any VPS (DigitalOcean, Hetzner, etc.)**
Install Node 18+, copy the folder, run `npm install`, then keep it alive with
`npm i -g pm2 && ADMIN_PASSWORD=... pm2 start server.js --name receipts`. Put Nginx or Caddy in
front for HTTPS.

Always serve it over HTTPS: the admin password and receipts travel over the connection.

## Settings (environment variables)

| Variable | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Password for /admin | `Mech001` (change it!) |
| `SESSION_SECRET` | Signs admin login cookies (any long random text) | derived from password |
| `DATA_DIR` | Where the database and receipts are stored | `./data` |
| `PORT` | Port to listen on | `3000` |
| `SITE_TITLE` | Title printed at the top of the PDF | Payment Receipts Register |

## How it behaves

- Each registration number appears once. If the same student submits again, the new receipts are
  added to their existing row (the first name entered is kept).
- Accepted files: JPG, PNG, WEBP, PDF. Up to 5 files of 10 MB each per submission. Photos are
  auto-rotated and resized so the PDF stays a sensible size.
- Receipts are only viewable by the admin; they are not publicly reachable by URL.
- Admin page: search, tick rows to export only those students, view or delete receipts, print one
  student, download the full PDF, the register-only PDF, or a CSV.

## Backups

Everything lives in `DATA_DIR` (`portal.db` plus the `uploads` folder). Copy that folder to back up.
