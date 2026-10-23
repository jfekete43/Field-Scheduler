# Jackson Holbrook Little League — Field Scheduler

A scheduling site for JHLL's four locations, their fields, and the indoor batting cages.

**Anyone can view the schedule without signing in.** Only league admins sign in, and only to make
changes.

---

## What it does

**For families (no login):**

- Day, week and "next 60 days" views of every game, practice and cage session
- Filter by location, field, event type, division, or a search for a team name
- A **Directions** button for every site that opens Google Maps
- A **Field Map** button that shows an uploaded site map with a label on each field
- Subscribe the schedule to Google Calendar / Apple Calendar, or download an `.ics` file —
  filtered to just one location, field or division if you want
- A printable schedule, and a shareable link that keeps whatever filters are applied
- Works on a phone

**For admins (after signing in at `/admin`):**

- Add, edit and delete events; repeat one weekly for a whole season in a single step
- **Double-booking protection** — it refuses to put two things on the same field at the same time,
  shows what the clash is, and lets you override deliberately if you really mean to
- **Rain out a day** — mark every event at one location (or everywhere) as rained out at once;
  the events stay visible so families can see what was called off
- Edit addresses, upload a field map per site and click to place labels on it
- Upload the league logo, set the season label, and post an announcement banner
- Add and remove admin accounts, reset passwords
- An activity log of every change and who made it

---

## Locations and fields (already loaded)

| Location     | Fields |
|--------------|--------------------------------------------------|
| **Holbrook** | Farm, AA, AAA, Majors, 60/90, **Indoor Cages**   |
| **Justice**  | Grass A, Grass B, Turf 1, Turf 2, Softball       |
| **Bartley**  | Field 1, Field 2                                 |
| **527**      | Minors, Majors, 60/90                            |

Holbrook and 527 both have a "Majors" and a "60/90". They are tracked as separate fields, so
booking one never blocks the other, and every screen shows the location next to the field name.

---

## Trying it out without installing anything

GitHub does not host this app on its own — GitHub Pages only serves static files,
and this is a Node server with a database. To get a working link straight from
GitHub, use a **Codespace**, which runs it on a temporary machine and gives you a
URL you can open on your phone or send to a board member.

1. Open the repository on github.com and switch to the
   `claude/jhll-scheduling-site-x0uepa` branch (the **Branch** dropdown, above the file list).
2. Click the green **Code** button → the **Codespaces** tab → **Create codespace on
   claude/jhll-scheduling-site-x0uepa**.
3. Wait a minute or two. It installs everything and starts the site for you.
4. A box pops up in the bottom-right saying the application is running on port 3000.
   Click **Open in Browser**. If you miss it, open the **PORTS** tab next to the
   terminal and click the globe icon on port 3000.
5. The first time, visit `/admin` on that URL and it will walk you through creating
   your admin account.

The link is private to you by default. To let someone else open it, go to the
**PORTS** tab, right-click port 3000 → **Port Visibility** → **Public**.

Two things to know: the Codespace shuts down after about 30 minutes of inactivity
(reopen it from the same Code → Codespaces menu, and your schedule is still there),
and deleting the Codespace deletes the test data with it. Personal GitHub accounts
include a monthly allowance of free Codespace hours. When you are ready for a real
address that stays up, see **Deploying it** below.

---

## Running it

You need [Node.js](https://nodejs.org) 18.17 or newer.

```bash
npm install          # install dependencies
npm run seed         # load the four locations and their fields (safe to re-run)
npm start            # start the server
```

`npm run seed` only ever *adds* what is missing. Once you have renamed a field or reordered a
location, re-running it leaves your edits alone, so it is safe on every deploy.

Run `npm test` any time to check the scheduling rules still behave.

Then open **http://localhost:3000**.

The first time, go to **http://localhost:3000/admin** and it will walk you through creating the
first admin account. That setup page closes itself permanently once an account exists.

Prefer the command line?

```bash
npm run create-admin -- --username jim --password 'ChooseSomethingStrong1' --name 'Jim Fekete' --owner
```

Locked out later:

```bash
npm run reset-password -- --username jim --password 'ANewPassword123'
```

---

## Everyday tasks

### Putting the season on the schedule

**Schedule → + Add Event.** Pick the location and field, the date and times, and the type
(game, practice, cage session, tournament, clinic, maintenance, closed).

For something that happens every week — a standing practice or a weekly cage slot — set
**Repeat → Number of weeks** to however many weeks it runs. It creates them all at once and tells
you if any individual date had to be skipped because the field was already taken.

### When a field is already booked

The save is refused and you are shown exactly what is in the way. Either change the time, or
choose **Save Anyway** if you genuinely want two things on the field at once.

### Rain

**Schedule → Rain Out a Day.** Pick the date, optionally narrow it to one location, and apply.
Everything that day is marked rained out and shows struck through on the public site, so families
can tell the difference between "canceled" and "never scheduled".

To call off a single event instead, edit it and set its **Status**.

### Taking a field out of use

Under **Locations & Maps**, untick **Shown** for that field and save. It disappears from the public
schedule along with any events booked on it, and from the list of fields you can book. You still see
it in the admin console, greyed out, so you can tick it back on whenever you want. Nothing is
deleted.

### Field maps

**Locations & Maps → Upload Field Map.** Any photo, drawing or screenshot works.

Then choose **Label Fields**: click anywhere on the map to drop a label, type what it is
("Majors", "Cages", "Parking", "Snack Bar"), drag it where you want it, and pick a colour. Labels
can be linked to a field. Save, and the labelled map is what families see behind the
**Field Map** button.

### Directions

Each location has an address and a "directions search text". The Directions button feeds that to
Google Maps. If a site has no street address, type something Maps can find — a park name, a cross
street. If you want it to be exact, fill in the latitude and longitude and those win.

> **Check these first.** The addresses are seeded as placeholders good enough for Maps to find the
> general area. Open **Locations & Maps** and set the real ones before sharing the site.

### Adding an admin

**Admins → + Add Admin.** Use **Suggest a Password**, give it to them, and ask them to change it
under **My Password**. *Owner* can also manage accounts; *Admin* can manage the schedule. One
active account always has to remain, so nobody can lock everyone out.

---

## Deploying it

The whole app is one Node process and one SQLite file. Anywhere that runs Node works.

Set these environment variables in production:

| Variable         | What it does |
|------------------|--------------|
| `NODE_ENV`       | Set to `production` — turns on secure cookies |
| `SESSION_SECRET` | A long random string. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT`           | Port to listen on (default `3000`; most hosts set this for you) |
| `DATA_DIR`       | Where the database and uploads live (default `./data`) |
| `TRUST_PROXY_HOPS` | Number of proxies in front of the app. **Defaults to `0`** (trust nothing). Set it to `1` behind nginx, Render or Fly — the included configs already do. |

**Serve it over HTTPS.** Passwords and session cookies go over this connection, and secure cookies
will not be sent over plain HTTP.

**Set `TRUST_PROXY_HOPS` to match your setup.** It defaults to `0`, meaning the app reads the real
socket address and ignores `X-Forwarded-For`. Behind a reverse proxy set it to `1` or the app sees
every visitor as the proxy. Setting it higher than the number of proxies you actually run lets a
visitor forge their own IP address, which is what the login lockout is keyed on.

### Render / Railway / Fly.io

Build `npm install`, start `npm start`. Attach a **persistent disk** and point `DATA_DIR` at it —
`/data` is the usual mount path. Without a persistent disk the schedule is wiped on every deploy.

`render.yaml` and `fly.toml` are included as starting points.

### Your own server

```bash
git clone <this repo> && cd Field-Scheduler
npm install --omit=dev
npm run seed
SESSION_SECRET=... NODE_ENV=production node src/server.js
```

Run it under systemd or pm2 and put nginx or Caddy in front for HTTPS. A sample systemd unit is in
`deploy/jhll-scheduler.service`.

### Backups

Everything is in `data/`. Copy that folder and you have copied the league's schedule, the uploaded
logo and field maps, and the admin accounts.

```bash
sqlite3 data/scheduler.db ".backup 'backup-$(date +%F).db'"
```

---

## Project layout

```
src/
  server.js        express setup, pages, auth endpoints, security headers
  auth.js          sessions, bcrypt passwords, login throttling, CSRF
  db.js            SQLite schema, settings, audit log
  schedule.js      event validation, double-booking checks, repeating series
  ics.js           calendar feed, wall-clock to UTC conversion
  routes/
    public.js      the read-only API anyone can use
    admin.js       the write API behind the login
public/
  index.html       the public schedule
  admin.html       the admin console
  login.html       sign in
  setup.html       first-run account creation
  css/styles.css   all styling
  js/              front-end code, no build step
scripts/
  seed.js          loads the four locations and their fields
  create-admin.js  create an account from the command line
  reset-password.js
data/               created at runtime — database and uploads (never committed)
```

No build step, no bundler. Edit a file, restart, done.

---

## Security notes

- Passwords are hashed with bcrypt (cost 12) and never stored or logged in the clear
- Sessions are HTTP-only cookies, `SameSite=Lax`, marked `Secure` in production, kept in SQLite
  so a restart does not sign everyone out
- Every write is protected by a CSRF token compared in constant time
- Repeated failed logins lock that username/IP pair for 10 minutes, and a second counter locks the
  account for 15 minutes regardless of source address, so guesses cannot be spread across many IPs
- Changing or resetting a password signs that account out everywhere else
- A strict Content-Security-Policy; uploads are served with `nosniff` and their own locked-down CSP
- Uploads are limited to images, capped at 6 MB, and stored under random filenames
- Every admin action is written to the activity log

If an admin leaves the league, disable or delete their account under **Admins** — and if they knew
a shared password, change it.
