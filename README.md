# The Daily Web

A news management, editing and publishing system. Reporters write articles, editors review and publish them, and readers browse the approved news. Final project for the *Web Application Development* course.

Built only with technologies taught in the course: **HTML5, CSS (Flexbox), Vanilla JavaScript (DOM + Ajax), Node.js, Express (MVC), EJS, MongoDB + Mongoose, authentication**, plus the two things the assignment names explicitly: **Chart.js** (analytics chart) and **OpenWeatherMap** (weather widget).

---

## 1. Installation and running

**Requirements:** Node.js 20.19 or newer (24 was used for development), and a MongoDB server (local, or a free MongoDB Atlas cluster).

```bash
# 1. install the dependencies
npm install

# 2. create your local settings file and edit it (see "Environment variables" below)
copy .env.example .env        # Windows
# cp .env.example .env        # macOS / Linux

# 3. fill the database with demo data (600 articles, users, comments, view statistics)
npm run seed

# 4. start the server
npm start
```

Open <http://localhost:3000>.

### Environment variables (`.env`)

| Variable | Meaning |
| --- | --- |
| `PORT` | Port of the web server (default 3000) |
| `MONGODB_URI` | MongoDB connection string, e.g. `mongodb://127.0.0.1:27017/daily-web` |
| `SESSION_SECRET` | Long random text used to sign cookies. **Keep it the same between restarts** so users stay logged in |
| `WEATHER_API_KEY` | Free OpenWeatherMap key (<https://openweathermap.org/api>, "Current Weather Data", no credit card) |
| `WEATHER_CITY` | City shown in the weather widget (default `Tel Aviv`) |
| `SEED_PASSWORD` | Password given to all demo users created by `npm run seed` |

`.env` is git-ignored: **never commit passwords, API keys or tokens.** Only `.env.example` (with empty/placeholder values) is committed.

### Demo accounts (created by `npm run seed`)

The password of every account is the value of `SEED_PASSWORD` in your `.env`.

| Role | Username |
| --- | --- |
| Editor | `editor` |
| Reporters | `reporter1` ... `reporter6` |

Readers (guests) need no account.

### Other commands

```bash
npm test        # unit tests (workflow rules, validation, diff, statistics, weather cache)
npm run seed    # WARNING: clears users, articles, comments and statistics, then re-creates the demo data
```

The seed prints the links of several articles that were updated many times after publication: they are the best ones to show in **Impact Analytics**.

---

## 2. Project structure

```
app.js                  Express app: middleware, sessions, routes, error handling
server.js               Starts the server, DB connection, graceful shutdown
config/                 env.js (validated settings), db.js (Mongoose connection), constants.js
models/                 M of MVC: User, Article, Comment, ViewStat (+ ViewedLog)
views/                  V of MVC: EJS templates (pages/, partials/, errors/)
controllers/            C of MVC: thin request handlers
routes/                 pages.js (HTML pages) and api.js (REST API, /api/v1)
services/               Business logic: workflowService (state machine), articleService,
                        commentService, statsService, viewService, weatherService,
                        authService, userService
middleware/             auth (sessions + roles), device cookie, central error handler
utils/                  logger, event bus, validators, diff, helpers
public/css, public/js   Browser code (Vanilla JS, no libraries) and styles (Flexbox)
scripts/seed.js         Demo data generator
test/                   Unit tests (node:test)
logs/                   app.log and error.log (created at runtime, git-ignored)
```

**MVC:** models know only about data; controllers read the request and call services; services hold the rules; views (EJS) only render. Business rules never live in the views or the browser.

---

## 3. Features (mapped to the assignment)

### Public (everyone)
- **Home feed** (`/`): only approved and published articles. Infinite scroll loads **20 more** articles when the reader nears the bottom (`IntersectionObserver` + keyset pagination, which stays fast on thousands of articles).
- **Search** (title and summary), **filter** by category and viewed / not viewed, **sort** by publish date or popularity.
- **Search, filter, sort and loading more all use Ajax** (`fetch`): no full page refresh. Stale responses are cancelled with `AbortController`, input is debounced, and the URL is updated so a search can be shared.
- Each card shows title, image, summary, category, reporter and publish date, and links to the article page.
- **Article page** (`/articles/:id`): rendered completely **on the server** (the full text is in the first HTML, so search engines can read it without JavaScript). Includes the comments list and a form; a new comment appears immediately without reloading the list. Comments written in other browsers show up on their own within about 5 seconds (the page polls the server with `fetch`; deleted comments disappear the same way).
- **Comment limit:** at most **3 comments per minute per device**, enforced by the server (HTTP 429 with a clear message). A signed cookie identifies the device; a higher per-IP ceiling also stops clients that discard cookies; the check and the insert run inside a lock so parallel requests cannot bypass it.
- **Views:** every article page load counts.
- **Weather widget** in the sidebar.

### Reporter (`/workspace`)
- Sees only their own articles and their state: *In preparation*, *Awaiting editor approval*, *Published*, *Returned for corrections*.
- Create an article, edit an article in preparation, submit it for approval, see the editor's note on a returned article, fix it and submit again, and edit an already published article.
- **Autosave:** every change is saved automatically (no save button), also when leaving the tab. Closing the browser, refreshing or opening the article on another computer shows the latest saved version.
- **Review history:** on the edit page the reporter sees every earlier submit, editor note and approval of the article, not only the latest note. The editor sees the same list on the review and edit pages.
- A reporter can never publish and can only touch their own articles.

### Editor (`/editor`)
- Sees all articles, filters them by state, searches by title.
- For an article awaiting approval: view the content, **edit it** (then **Save & publish** straight from the edit page), **approve and publish**, **return it with a note** explaining the corrections, or **delete** it.
- For an **update to a published article**, the review page shows the published version and the new version side by side, with removed / added words highlighted.
- **Impact Analytics** (`/editor/analytics`): choose an article and see a Chart.js line chart of views over time, with **clear markers at the moments an editor approved and published (or updated) the article**, dotted lines for the average views per hour before and after each update, and a text comparison ("Before: 9.5 views/hour -> After: 30 views/hour (+216%)").
- Management screens for **users** and **comments** (list, search, create / edit, delete).

### Workflow (state machine)
```
new article ──► In preparation ──submit──► Awaiting approval ──approve──► Published
                     ▲                           │
                     └──── fix and resubmit ─── Returned (editor note) ◄─ return
```
Any other transition is rejected by the server (`services/workflowService.js`, covered by unit tests).

**Editing a published article:** readers keep seeing the **last approved version** (`live`). The reporter's changes are stored as a separate **revision** that goes through the same approval process. Only approval copies the revision into `live`.

### Weather
OpenWeatherMap **current weather** (free plan, no credit card). The browser calls our own `/api/v1/weather`; the API key never reaches the browser. The server caches the answer for **10 minutes** (data shown is never older than 15 minutes), so thousands of simultaneous users cause **one** upstream request per refresh. Simultaneous requests share a single in-flight call, and a failed upstream is not hammered. If the data would be older than 15 minutes, the widget says weather is unavailable instead of showing old data.

---

## 4. Database models

| Model | Purpose | Main fields |
| --- | --- | --- |
| `User` | Reporters and editors | `username` (unique), `displayName`, `passwordHash` (bcrypt), `role` |
| `Article` | Articles and their workflow | `author`, `live` (approved version), `revision` (working copy + status + editor note), `viewCount`, `publishHistory[]` |
| `Comment` | Reader comments | `article`, `authorName`, `text`, `deviceId`, `ip` |
| `ViewStat` | **Hourly view buckets** for analytics | `article`, `hour`, `count` |
| `ViewedLog` | Which device viewed which article | `deviceId`, `article` |

Every model supports full CRUD (Create, Read with list + search, Update, Delete) through the REST API:
- `User`: `/api/v1/users` (search by username / name)
- `Article`: `/api/v1/manage/articles` (search by title)
- `Comment`: create `POST /articles/:id/comments` (readers), list / search / edit / delete `/api/v1/comments` (editor, search by text / name)
- `ViewStat`: `POST /api/v1/stats/views` (record a view) and `/api/v1/stats/views` (list by article / date, update, delete)

### How views are collected for thousands of readers
Storing one document per view would not scale. Instead:
1. A view is counted in memory and flushed to MongoDB in small batches every 2 seconds (and on graceful shutdown).
2. The flush does `$inc` on the **hourly bucket** (`ViewStat`) and on `Article.viewCount` (used for the popularity sort).
3. The chart reads a small range of buckets and fills quiet hours with zero. The hour of an update is skipped when comparing before / after, because it mixes both periods.
4. Each approval is stored in `Article.publishHistory`, which provides the markers on the chart.

---

## 5. REST API (`/api/v1`)

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Public | `GET /articles`, `GET /articles/:id`, `GET /articles/:id/comments`, `POST /articles/:id/comments`, `GET /categories`, `GET /weather`, `POST /stats/views` |
| Reporter + editor | `GET /manage/articles`, `GET /manage/articles/:id`, `PUT /manage/articles/:id/revision` (autosave) |
| Reporter | `POST /manage/articles`, `POST /manage/articles/:id/submit` |
| Editor | `POST /manage/articles/:id/approve`, `POST /manage/articles/:id/return`, `DELETE /manage/articles/:id`, `/comments`, `/users`, `/stats/...` |

Resources are nouns, verbs express the action, and status codes are meaningful: 200, 201, 202, 204, 400 (invalid data), 401 (not logged in), 403 (not allowed), 404, 409 (invalid state), 429 (rate limit).

---

## 6. Security, errors, performance, logs

- **Passwords** are hashed with bcrypt (salted, one-way) and are never returned by the API.
- **Sessions** live on the server (MongoDB via `connect-mongo`); the cookie only holds a signed id (`httpOnly`, `sameSite`). The user's **role is always read from the database**, never from anything the browser can change. After a **server restart, users stay logged in**.
- **Permissions are checked on the server** (`requireAuth`, `requireRole`, ownership checks in the service layer). Hiding buttons in the browser is only a convenience.
- Session id is regenerated on login, redirects after login are restricted to local paths, login attempts are rate-limited, and error messages do not reveal whether the username exists.
- All output is escaped (`<%= %>` in EJS, `textContent` in the browser), so user text cannot inject HTML. A Content-Security-Policy blocks inline scripts.
- **Validation** happens in the browser *and* on the server; ObjectIds, cursors, filters and bodies are validated, regular-expression characters in searches are escaped, and a central error handler turns any failure into a safe response. Invalid or forbidden actions never crash the server (`unhandledRejection` / `uncaughtException` are also logged).
- **Performance:** indexes for every feed / list query, keyset pagination, `.lean()` + field projection (the feed never loads full article text), bulk batched view writes, cached weather.
- **Logs:** `logs/app.log` (everything) and `logs/error.log` (warnings and errors), one JSON object per line, written with Node streams. Significant events (login, article submitted / published / returned / deleted, rate-limit hits, permission denials, weather refresh / failure) go through an `EventEmitter`.

---

## 7. Assumptions

- The assignment says any transition other than the listed ones is not allowed. Therefore an **editor's own edit never changes an article's state**. The only addition is a deliberate editor shortcut: when an article that is **already published** has a new version in preparation (for example the editor just edited it), the editor can publish that update directly (Save & publish / Publish these changes). A never-published draft still has to be submitted by its reporter first. This rule lives in one place, services/workflowService.js, and is covered by a unit test. Ask the lecturer if this shortcut is acceptable.
- The article image is an address (`https://...` or a site path). The demo data uses images generated by the project itself (`/placeholder/...`), so the system works offline.
- "Device" means one browser (identified by a signed cookie), with an additional per-IP safety ceiling.
- Published date shown to readers is the **first** publication time; later updates are recorded in the publish history.

---

## 8. Team workflow (Git)

- Every student works on their own computer with their own Git account.
- `main` is always working. Each feature is developed on its own branch (`feat/feed`, `feat/auth`, `feat/workflow`, `feat/analytics`, `feat/weather`, `feat/seed`, ...), with small, frequent, descriptive commits, and merged through a **pull request that a teammate reviews**.
- Never commit `.env`, API keys, passwords or `node_modules` (see `.gitignore`).
- Every team member must be able to explain every file in this repository.

## 9. Pre-defense checklist

1. Fresh clone, `npm install`, `.env` created, `npm run seed`, `npm start` works on a personal computer.
2. Weather key is configured and the widget shows data.
3. Demo: guest (feed, search, filter, sort, infinite scroll, comments, 4th comment blocked), permissions (guest and wrong role are rejected), autosave (close the browser mid-edit), workflow (submit, return with note, resubmit, approve), editing a published article (readers still see the old version; editor sees the diff), analytics chart, **server restart** (still logged in, work intact), weather (including what happens when the upstream fails).
