# Build me a static archive site for my tweets

Paste this whole file into Claude Code (or any coding agent) in an empty directory. It is a
complete spec: it says what to build, how the data works, and which decisions are mine to make.

**Before you write code, ask me for anything in "What I need from you" that I haven't already
told you.** Then build it in the order given under "Build order", running each step so we see
real data before the next one is written.

---

## What I need from you

Fill these into `src/config.js` as the only account-specific surface in the codebase:

| Value | What it is |
|---|---|
| `USERNAME` | My Twitter handle, spelled the way community-archive.org spells it |
| `SITE` | The full origin the site will live at, e.g. `https://tweets.example.com` |
| `SITE_TITLE` | What the banner and `<title>` say, e.g. "Jane Doe's tweets" |
| `PROFILE_URL` | A personal site to link in the footer (optional) |
| `DEPLOY_ACCOUNT_EMAIL` | Cloudflare login the deploy script refuses to run without (Cloudflare path only) |

Also ask me:

1. **Deploy target** — Cloudflare Workers static assets (the default) or GitHub Pages. Details
   in "Deploying" below. If I don't care, use Cloudflare.
2. **Look** — see "Visual direction". Ask for an accent colour, a font, and a banner image. If I
   have nothing in mind, pick a neutral pair of light/dark palettes with a single accent and
   move on; don't stall the build on it.
3. Whether I have an `ANTHROPIC_API_KEY` available (thread naming needs one; everything else
   doesn't).

My account must already be in [community-archive.org](https://www.community-archive.org/) —
that's where the tweets come from. If it isn't, uploading my Twitter archive there is that
project's onboarding, and nothing here works until it's done.

---

## What the site is

A static, self-contained archive of one person's tweets. Every page is one HTML file with all of
its content in the markup: sorting, filtering and searching are client-side over rows that are
already there, so the pages work without JavaScript and anything crawling them sees everything.
No framework, no build tooling beyond Node — plain ES modules writing HTML strings.

### Pages

| URL | What it is |
|---|---|
| `/` | Counts on the banner, a linked section per page below, and one top tweet drawn at random on each visit |
| `/by-month/` | Calendar: years as rows, months as columns, each cell coloured by how that month went |
| `/by-month/YYYY-MM/` | Every tweet that month, chronological, with self-reply chains grouped |
| `/threads/` | Every thread worth sharing, sortable by topic, date, length, likes, RTs |
| `/threads/<slug>/` | One thread per page, read as one piece of writing |
| `/top/` | The 500 most-liked tweets, sortable by likes, RTs, date, or RT/like ratio |
| `/replies/` | The 250 most-liked replies to other people, each under the tweet it answers |
| `/retweets/` | Every retweet, searchable, plus a tally of who gets retweeted most |

Plus `/sitemap.xml` (generated from the pages actually written, with priorities) and `/robots.txt`
that allows everything and points at the sitemap. The archive is meant to be crawled.

---

## Data model — the parts that are easy to get wrong

These are the decisions that make the site correct rather than merely working. Implement them as
described; each one has a failure mode behind it.

### Retweets are shown but never counted

The archive stores a retweet as a tweet of mine whose text is `RT @them: …`. The trap: its
`favorite_count` and `retweet_count` belong to **the original tweet**, not to me. Counted
naively, a few thousand retweets can add more borrowed RTs than the account ever earned, and
then totals, month colours and `/top/` are all measuring other people's reach.

So `loadArchive()` returns two views: `archive.own` (retweets removed) is what every count on
the site is computed over, and `archive.tweets` stays the full record for pages that show
retweets in place. Retweets are excluded from threads, `/top/`, and all totals; they appear on
month pages (toggleable) and on `/retweets/`, where the reach column is explicitly labelled as
the original author's.

Detect with `/^RT @(\w{1,15})[: ]/` — **anchored**, so an old-style manual retweet with a comment
in front ("Well said. RT @them …") stays my own tweet. Self-retweets count as retweets too: the
tweet they point at is already in the archive with its own numbers, so counting the retweet
would double it. Strip the `RT @them:` prefix from the body and render it as an attribution
line instead — it's metadata, not part of what was said.

### Threads are self-reply chains, and most chains aren't threads

A chain is a maximal run of my own tweets each replying to the previous. The root may itself be
a reply to someone else — a thread hung off a reply still reads as a thread; what makes it a root
is that its parent isn't one of my own tweets in the archive. Where a tweet has several
self-replies (branching), the earliest child continues the main chain and later branches start
their own; walk roots chronologically and mark tweets claimed so the main chain wins.

A chain is "worth sharing" — i.e. gets its own page — if it is **at least 4 tweets** and
**either 6+ tweets long or 30+ total likes**. Put all four numbers in `config.js` and tell me
they're worth re-tuning, because they're calibrated to how one particular person posts. The
4-tweet floor is the load-bearing one: a tweet with an afterthought or two isn't a thread however
well it did, and well-liked short ones are already on `/top/`. Chains below the floor still group
visually on month pages; they just get no page and no label.

### Quoted and replied-to tweets get fetched

The community archive holds my tweets and nobody else's, so a quote-tweet arrives as a bare id
and a reply as a bare `reply_to_tweet_id` — which is exactly the half of the exchange that makes
my half readable. Fetch those from Twitter's **syndication API**, the unauthenticated JSON
backend behind embedded tweets:

```
GET https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<token>&lang=en
```

where `token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')`. (`Number()`
loses precision on large ids; the endpoint expects exactly this computation anyway.) A `Tweet`
comes back as `{ __typename: 'Tweet', user, text, created_at, entities.urls, photos, video,
quoted_tweet }`. A deleted or protected tweet may come back 200 as a `TweetTombstone`.

It is an unofficial endpoint that owes us nothing, so **everything degrades**: no cache, no card,
and the tweet renders with a plain link the way it would have anyway. Cache into
`data/embeds.json` and make the fetch incremental — there can be tens of thousands of these:

- API says unavailable (404, tombstone, non-Tweet) → cache `null`, a permanent no, so later runs
  don't ask again. A `--retry-gone` flag asks anyway.
- Network or rate-limit error → cache **nothing**, so the next run retries it.
- 40 consecutive failures stops the run and keeps what it got; back off between retries.
- Flush the cache to disk every ~500 answers via a temp file + rename, so a run that dies keeps
  its work and a concurrent build reads a complete file rather than half of one.
- Fetch in priority order — quoted tweets first (a QT without its quote is a non-sequitur), then
  replies weighted by likes — because a run can be cut short.
- Quote-tweets of my **own** tweets need no fetch: the tweet is already in the archive, and its
  card links to this site rather than to Twitter.

Render an embed as a card: above a reply ("Replying to …"), below a quote-tweet. Truncate a long
one at a word boundary (~600 chars) with a link to the rest.

### Thread names come from an LLM, incrementally

Each share-worthy thread gets a `{slug, title}` from the Claude API, stored in
`data/thread-names.json` keyed by the root tweet id. **The slug is the URL, so the file is
load-bearing state — never delete it, and keep it in git.** Existing names are kept, so a
scheduled refresh only pays for threads that appeared since last time; `--all` re-names
everything, `--limit N` caps a run.

Ask for: a 2-5 word lowercase kebab-case slug that reads as a *topic* rather than a summary
sentence, and a sentence-case title under 70 characters naming what the thread is about, without
editorializing and without starting with my name or "A thread". Batch ~8 threads per request with
~6 requests in flight, use structured JSON output, retry with backoff, and only trust ids the
model echoes back that were actually in the batch. Threads the model drops fall back to naming
from the first tweet's first few words. Ask me for a one-paragraph description of what I write
about — it goes in the system prompt and measurably sharpens the slugs.

Slug collisions take a numeric suffix (`-2`) in date order, newest keeping the bare slug.

### Everything else

- **Month buckets** cover every month between the first and last tweet, gaps included as zeroes,
  so the calendar stays a grid. A month's tweet list includes retweets (the page shows them);
  its counts don't.
- **Text arrives HTML-escaped** (`&amp;`, `&lt;`, `&gt;`) — decode once on load so every renderer
  can escape it itself, or "&" reaches the page as "&amp;".
- **`t.co` links** are replaced with the expanded URL the archive recorded, using the display
  text. A shortener with no recorded expansion is dropped rather than left as a dead link. The
  quoted tweet's own URL is omitted from the text when its card is rendered, the way Twitter
  itself swallows it into the embed rather than showing it twice.
- **Media is hot-linked** from `pbs.twimg.com`. Twitter has dropped some older files, so give
  every `<img>` an `onerror` that removes its own figure.
- **Replies I want demoted**: a `DEMOTED_REPLIES` set of tweet ids in `config.js` that keep their
  slot in the 250 on `/replies/` but sort to the bottom under a heading saying why. An archive
  doesn't hide things; it can order them. Keep the reason in a comment next to each id.

---

## The calendar's colour, specifically

This one is informational rather than decorative, so build it as described. Each month cell is
`rgb(retweets, likes, tweet-count)` — one metric per channel — with each channel log-scaled
against the busiest month in *that* dimension:

```js
ch = (v, max) => Math.round(255 * (Math.log1p(v) / Math.log1p(max)) ** 0.85)
```

Log rather than linear because monthly engagement spans three orders of magnitude and linear
leaves all but a few months black. A bright cyan month was busy and well-liked; a dark one was
quiet. Compute luminance per cell and pick black or white for the count label so it stays legible
on any background. A month with no tweets is an **outline**, not a dark cell, so it can't be
misread as a quiet one. Put a legend under the grid saying which channel is which.

---

## Visual direction

The look is mine to choose — ask me. What is **not** negotiable, because it's structure rather
than taste:

- **Light and dark**, driven by `prefers-color-scheme`, both defined as CSS custom properties on
  `:root` (background, panel, foreground, muted, faint, rule, accent, accent-hover, accent-soft).
- **One accent colour** used consistently for links, `::selection`, `:focus-visible`, and the
  active nav item.
- **Links carry their underline all the time.** Colour alone doesn't read as clickable. Chrome
  that is obviously clickable from its shape or position (banner title and nav, calendar cells,
  the permalink glyph) is the exception.
- **A measure of ~44rem** for reading pages, ~62rem for the wide table pages (`/top/`,
  `/retweets/`, `/by-month/`).
- **Reduced motion respected**, focus rings visible, tables horizontally scrollable in their own
  container so the page body never scrolls sideways.
- **A full-width banner** carrying the site title, the nav, and — on the homepage only — four
  counts (tweets, likes, retweets, threads) riding on the image itself. Ask me for an image. If
  it's a tiled or grid-based one, `repeat-x` it and let the page's first heading tuck up into the
  image's bottom edge rather than starting below it.
- **A favicon and `theme-color` meta** matching the accent.
- One self-hosted `woff2` if I name a font; otherwise a system font stack.

Anything else — colours, typography, the image — ask, then commit to it.

---

## Rendering rules worth keeping

- **Thread pages read like blog posts.** They're the one place tweets are meant to be read
  straight through as one piece, so per-tweet chrome is stripped there and kept everywhere else:
  no like/RT counts on individual tweets (the thread-level totals in the lede stay), and only the
  opening tweet is dated — plus any tweet posted 24h or more after the thread started, since that
  gap is real information while the minute-by-minute ones aren't. Undated tweets get their
  permalink as an inline **SVG glyph, never a word**: a copy-paste of a thread should come back
  as clean prose, which also rules out text hidden by CSS.
- **It's Twitter, not X.** Anywhere the site speaks to a reader — link text, labels, prose, meta
  descriptions — call it Twitter. The `x.com` hostname in URLs stays as-is, because that's the
  address, not the name. Write this rule into `CLAUDE.md` so it survives later edits.
- Every tweet is an `<article id="t<id>">` so a `#t123` anchor works from anywhere, with a
  `:target` highlight. Embed cards for my own tweets link to `/by-month/<month>/#t<id>` rather
  than off-site.
- Every page gets `<title>`, meta description, canonical, Open Graph tags and a `twitter:card`.
  Write descriptions from real numbers, not boilerplate.
- Filters (replies, retweets) work by toggling a body class; **the rows stay in the HTML either
  way**, so crawlers and no-JS readers still see everything.
- On the big search page, read the search haystack off the rows themselves and index lazily on
  first keystroke — emitting the text again as `data-` attributes more than doubled the bytes on
  the wire for a 6,000-row page.
- The homepage's random tweet is the one live thing. Pre-render a few hundred top tweets' markup
  into `/random-top.json` at build time with the same function that renders every other tweet on
  the site, and pick one in the browser after the page is up (via `requestIdleCallback`, silent
  on failure). Without JS the page is simply the page it was before.

---

## Layout

```
src/
  config.js       account, site constants, thread thresholds, demoted replies
  archive.js      community-archive REST client (paging, retries)
  fetch.js        → data/tweets.json
  model.js        archive → own tweets / retweets / chains / threads / months / top replies
  embeds.js       syndication-API client + cache; embed cards
  fetch-embeds.js → data/embeds.json (incremental, resumable)
  name-threads.js → data/thread-names.json (Claude API, batched + concurrent)
  render.js       page shell, tweet markup, client-side sort/filter/search scripts
  build.js        → public/
  update.js       one guarded, unattended run of all of the above (cron entry point)
  assets/         style.css, favicon, banner image, font — copied into public/ verbatim
data/             fetched + generated, never hand-edited
public/           generated — wiped on every build, gitignored
```

`model.js` is pure data and emits no HTML; both `build.js` and `name-threads.js` consume it.
Node 22+, ES modules, `@anthropic-ai/sdk` as the only runtime dependency.

`.gitignore`: `node_modules/`, `public/`, `.env`, `data/tweets.json`, `data/embeds.json`,
`data/*.bak`, logs and lock files. **Commit `data/thread-names.json`** — it's the URL space.

---

## The data source

community-archive.org exposes a public Supabase REST API. The anon key below is public and
documented in [their repo](https://github.com/TheExGenesis/community-archive):

```
https://fabxmporizzqflnftavs.supabase.co/rest/v1/
apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhYnhtcG9yaXp6cWZsbmZ0YXZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjIyNDQ5MTIsImV4cCI6MjAzNzgyMDkxMn0.UIEJiUNkLsW28tBHmG-RQDW-I5JNlJLt62CSk9D_qG8
```

Find the account with `account?username=ilike.<handle>&select=account_id,username,
account_display_name,num_tweets,num_followers`, then page `tweets?account_id=eq.<id>&select=…`
in 1000-row pages, **ordered by `tweet_id.asc`** — it's unique and monotonic-ish, so offset
paging stays stable in a way `created_at` (with ties) does not. Select:

```
tweet_id, created_at, full_text, favorite_count, retweet_count,
reply_to_tweet_id, reply_to_user_id, reply_to_username,
tweet_media(media_url,media_type), tweet_urls(url,expanded_url,display_url),
quote_tweets(quoted_tweet_id)
```

Retry with exponential backoff and a generous timeout; the whole archive is ~60 requests.

Normalise into `data/tweets.json` as `{ account, fetchedAt, tweets: [{ id, at, text, likes, rts,
replyTo, replyToUser, replyToUsername, media: [{url,type}], urls: [{t,x,d}], quotes }] }`, sorted
chronologically, with ids as strings — they exceed `Number.MAX_SAFE_INTEGER`.

**Fetch is a full refetch, deliberately.** Likes and RTs on old tweets keep changing, so an
incremental "new tweets only" pull would freeze engagement at first-seen values and rot the `/top/`
rankings and the month colours.

---

## Deploying

### Cloudflare Workers (default)

`wrangler.toml`:

```toml
name = "<project-name>"
compatibility_date = "<today>"

[assets]
directory = "./public"

[[routes]]
pattern = "<site hostname>"
custom_domain = true
```

`wrangler` as a devDependency, `npm run deploy` → `wrangler deploy`. Before deploying, the update
script checks `wrangler whoami` against `DEPLOY_ACCOUNT_EMAIL` and refuses if it's the wrong
account — many machines are logged into a work Cloudflare account too, and a 3am cron job should
not make that mistake.

### GitHub Pages (alternative)

Ask before setting this up, since it changes the refresh story: build in CI rather than locally.

- Drop `wrangler.toml` and the wrangler dependency; `npm run deploy` isn't needed.
- Add `.github/workflows/build.yml`: on push to `main` and on a daily `schedule`, run
  `npm ci && npm run fetch && npm run fetch-embeds && npm run name-threads && npm run build`,
  then upload `public/` with `actions/upload-pages-artifact` and `actions/deploy-pages`.
- The workflow needs `permissions: { contents: write, pages: write, id-token: write }`, and it
  must **commit `data/thread-names.json` and `data/embeds.json` back to the repo** — both are
  incremental caches whose value is that they persist, and a deleted tweet can never be refetched.
  Cache them, or the daily run re-pays for everything and loses what's gone.
- `ANTHROPIC_API_KEY` goes in repo secrets. Without it, `name-threads` skips and new threads stay
  unlisted until it runs.
- If the site lives at a subpath, make the root-absolute URLs in `render.js` respect a `BASE`
  from config. On a custom domain (or `user.github.io`) they're fine as-is.
- `update.js`'s guards (lock, backup, deploy-if-changed) are for the local cron path; on Pages,
  CI is the scheduler and the workflow is the guard.

---

## The unattended refresh

`npm run update` is the scheduled version of the pipeline: fetch → embeds → names → build →
deploy, written for a run nobody is watching. What it adds over running the five steps by hand:

- **One at a time.** A lock file in `data/` keeps a slow run and the next cron tick from
  interleaving two fetches over the same directory. A lock whose pid is gone (check with
  `process.kill(pid, 0)`; `EPERM` counts as alive) is taken over. Release it on every exit path,
  including signals — but only if this run holds it.
- **The archive is restored if the refetch looks wrong.** `fetch` overwrites the whole archive in
  one go, so a half-answered API is the one failure that could quietly empty the site. Keep the
  previous copy as `.bak` and put it back if what arrives isn't the right account, isn't
  parseable, or is **more than 2% smaller** than what it replaced. People delete a handful of
  tweets at a time; an archive doesn't lose 2% of itself in a day.
- **It only deploys what's new.** Hash the build's real inputs — which tweets exist, their
  like/RT counts, and the thread-names file — and compare against the hash of the last successful
  deploy in `data/update-state.json`. A run that dies before deploying still deploys next time; a
  run where nothing moved skips the build entirely. A deploy that went out with a step still
  owing work (names unwritten, embeds rate-limited) is recorded as `pending`, which stops the next
  run from skipping and stranding it.
- **Only a build failure is fatal.** Embeds and thread names are enrichments: a rate-limited
  syndication API or a missing API key costs a card or a thread page, not the run. A failed build
  stops before the deploy, so a half-written `public/` never reaches the live site.
- **Everything is timestamped into `data/update.log`**, buffered to one append at the end and
  rotated past ~1 MB. It's the only evidence a 3am run leaves. Exit 0 on success or
  nothing-to-do, 1 on failure.
- Flags: `--force`, `--no-deploy`, `--no-embeds`, `--no-names`, `--embed-limit N`.
- Cron has no login shell, so read a `.env` at the repo root for `ANTHROPIC_API_KEY`, with
  anything already in the environment winning. Document the cron line with an **absolute** node
  path (cron's `PATH` won't find nvm's), and note that macOS cron needs Full Disk Access for the
  repo — `launchd` with a `StartCalendarInterval` avoids that.

---

## Build order

Run each step for real before writing the next; the data will tell us things the spec can't.

1. `config.js`, `archive.js`, `fetch.js` → run `npm run fetch`, and report what came back: how
   many tweets, the date range, how many are retweets, replies, quote-tweets.
2. `model.js` → print the chain-length distribution and how many chains clear the thresholds. If
   the count looks wrong for my posting style, say so and suggest numbers before continuing.
3. `render.js` + `build.js` for the homepage, calendar and month pages → build, and open one.
4. Threads: `name-threads.js` (start with `--limit 20` to check the slugs read well before paying
   for all of them), then the thread index and thread pages.
5. `/top/`, `/replies/`, `/retweets/`, sitemap, robots.
6. `embeds.js` + `fetch-embeds.js` → run with `--limit 500` first and check the cards render, then
   let the full run go in the background (it can take an hour on a large archive).
7. `update.js` and the deploy path.
8. A `README.md` documenting the pipeline, and a `CLAUDE.md` carrying the voice and rendering
   rules above, so later sessions keep them.
