// Generates the whole static site into public/. Pure function of data/ — safe to
// re-run after every fetch; nothing is written by hand.
import { mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArchive, assembleChains, chainToThread, worthSharing, months, retweetedAccounts, topReplies, MONTH_NAMES } from './model.js';
import { loadEmbeds, embedContext } from './embeds.js';
import { layout, esc, num, monthLabel, tweetHtml, permalink, SORT_SCRIPT, FILTER_SCRIPT, SEARCH_SCRIPT, RANDOM_TOP_SCRIPT } from './render.js';
import { PUBLIC_DIR, THREAD_NAMES_JSON, SITE, SITE_TITLE, USERNAME, THREAD_MIN_TWEETS, THREAD_MIN_LIKES, THREAD_MIN_LEN, TOP_TWEETS, TOP_REPLIES, RANDOM_TOP_SAMPLE } from './config.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const urls = [];

async function page(path, html, { priority = 0.5 } = {}) {
  const dir = join(PUBLIC_DIR, path);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), html);
  urls.push({ loc: (path ? `/${path}/` : '/'), priority });
}

// --- month colour ----------------------------------------------------------

// R = retweets, G = likes, B = tweet count, each log-scaled against the busiest
// month in that dimension. Log rather than linear because monthly engagement
// spans three orders of magnitude — linear would leave all but a few months black.
function colorScale(ms) {
  const max = k => Math.max(1, ...ms.map(m => m[k]));
  const maxes = { rts: max('rts'), likes: max('likes'), count: max('count') };
  const ch = (v, m) => Math.round(255 * (Math.log1p(v) / Math.log1p(m)) ** 0.85);
  return m => {
    const [r, g, b] = [ch(m.rts, maxes.rts), ch(m.likes, maxes.likes), ch(m.count, maxes.count)];
    // Luminance decides label colour so the hover count stays legible on any cell.
    return { css: `rgb(${r},${g},${b})`, light: (0.299 * r + 0.587 * g + 0.114 * b) > 140 };
  };
}

// --- pages -----------------------------------------------------------------

function calendarPage(ms, color) {
  const years = [...new Set(ms.map(m => m.year))].sort((a, b) => b - a);
  const byKey = new Map(ms.map(m => [m.key, m]));
  const rows = years.map(y => {
    const cells = MONTH_NAMES.map((_, i) => {
      const m = byKey.get(`${y}-${String(i + 1).padStart(2, '0')}`);
      if (!m || !m.tweets.length) return '<td><span class="cell empty"></span></td>';
      const c = color(m);
      const rt = m.retweets ? `, ${num(m.retweets)} retweets of others` : '';
      return `<td><a class="cell" href="/by-month/${m.key}/" style="background:${c.css}"
 title="${esc(monthLabel(m.key))} — ${num(m.count)} tweets, ${num(m.likes)} likes, ${num(m.rts)} RTs${rt}"
 ><span style="color:${c.light ? '#000' : '#fff'}">${num(m.count)}</span></a></td>`;
    }).join('');
    return `<tr><td class="yr">${y}</td>${cells}</tr>`;
  }).join('\n');

  const totals = ms.reduce((a, m) => ({
    count: a.count + m.count, likes: a.likes + m.likes, rts: a.rts + m.rts,
    retweets: a.retweets + m.retweets,
  }), { count: 0, likes: 0, rts: 0, retweets: 0 });

  return layout({
    title: `Tweets by month — ${SITE_TITLE}`,
    description: `Every month of @${USERNAME}'s tweets since 2009, coloured by retweets, likes, and volume.`,
    canonical: '/by-month/',
    nav: 'by-month',
    wide: true,
    body: `<h1>By month</h1>
<p class="lede">Every month since ${ms[0].year}. Each cell is coloured by how that month went:
red for retweets, green for likes, blue for sheer volume — so a bright cyan month was busy
and well-liked, and a dark one was quiet. Hover for the numbers.
Tweets he <a href="/retweets/">retweeted</a> show up on the month pages but aren't counted here.</p>
<div class="stats">
  <div><b>${num(totals.count)}</b> tweets</div>
  <div><b>${num(totals.likes)}</b> likes</div>
  <div><b>${num(totals.rts)}</b> retweets</div>
  <div><b>${ms.length}</b> months</div>
</div>
<div class="tbl-wrap"><table class="cal">
<thead><tr><th class="yr"></th>${MONTH_NAMES.map(m => `<th>${m}</th>`).join('')}</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="legend">
  <span><span class="swatch" style="background:rgb(220,40,40)"></span><b>Red</b> retweets</span>
  <span><span class="swatch" style="background:rgb(40,220,40)"></span><b>Green</b> likes</span>
  <span><span class="swatch" style="background:rgb(60,90,240)"></span><b>Blue</b> tweets</span>
  <span>each log-scaled against the biggest month.</span>
</p>`,
  });
}

function monthPage(m, prev, next, chainOf, named, ctx) {
  const replies = m.tweets.filter(t => t.isReplyToOther).length;
  let html = '';
  let i = 0;
  while (i < m.tweets.length) {
    const t = m.tweets[i];
    const chain = chainOf.get(t.id);
    if (!chain) { html += tweetHtml(t, { ctx }); i++; continue; }
    // Take the run of this chain's tweets that falls inside this month; a chain
    // spanning a month boundary renders its tail under the later month.
    const run = [];
    while (i < m.tweets.length && chainOf.get(m.tweets[i].id) === chain) run.push(m.tweets[i++]);
    const name = named.get(chain[0].id);
    const partial = run.length < chain.length;
    // Unnamed chains are often just a two-tweet reply exchange; the left rule
    // already shows they belong together, so only label the ones with a page.
    const tag = name
      ? `<p class="thread-tag">Thread · <a href="/threads/${esc(name.slug)}/">${esc(name.title)}</a>${partial ? ` · ${run.length} of ${chain.length} tweets` : ''}</p>`
      : '';
    html += `<div class="thread-block">
${tag}${run.map(x => tweetHtml(x, { ctx })).join('\n')}
</div>`;
  }

  return layout({
    title: `${monthLabel(m.key)} — ${SITE_TITLE}`,
    description: `${num(m.count)} tweets by @${USERNAME} in ${monthLabel(m.key)}, with ${num(m.likes)} likes and ${num(m.rts)} retweets.`,
    canonical: `/by-month/${m.key}/`,
    nav: 'by-month',
    body: `<p class="crumb"><a href="/by-month/">By month</a></p>
<h1>${monthLabel(m.key)}</h1>
<div class="stats">
  <div><b>${num(m.count)}</b> tweets</div>
  <div><b>${num(m.likes)}</b> likes</div>
  <div><b>${num(m.rts)}</b> retweets</div>
${m.retweets ? `  <div><b>${num(m.retweets)}</b> <a href="/retweets/">retweeted</a></div>` : ''}
</div>
${replies ? `<label class="filter"><input type="checkbox" data-filter="replies" checked> Include ${num(replies)} replies to other people</label>` : ''}
${m.retweets ? `<label class="filter"><input type="checkbox" data-filter="retweets" checked> Include ${num(m.retweets)} retweets</label>` : ''}
${html}
<nav class="pager">
  <span>${prev ? `<a href="/by-month/${prev.key}/">← ${monthLabel(prev.key)}</a>` : ''}</span>
  <span>${next ? `<a href="/by-month/${next.key}/">${monthLabel(next.key)} →</a>` : ''}</span>
</nav>
${FILTER_SCRIPT}`,
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function threadPage(th, name, prev, next, ctx) {
  const first = th.tweets[0];
  const snippet = first.text.replace(/https?:\/\/t\.co\/\w+/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  // A thread written in one sitting reads as one piece, so only the opening tweet is
  // dated. A tweet added a day or more later is a genuine addition — that one says when.
  const start = Date.parse(first.at);
  const dated = t => t === first || Date.parse(t.at) - start >= DAY_MS;
  return layout({
    title: `${name.title} — ${SITE_TITLE}`,
    description: snippet,
    canonical: `/threads/${name.slug}/`,
    nav: 'threads',
    body: `<p class="crumb"><a href="/threads/">Threads</a></p>
<h1>${esc(name.title)}</h1>
<p class="lede">${th.len} tweets · <a href="/by-month/${th.month}/">${monthLabel(th.month)}</a> ·
${num(th.likes)} likes · ${num(th.rts)} retweets ·
<a href="${esc(permalink(first))}">read on Twitter</a></p>
${th.tweets.map(t => tweetHtml(t, { showDate: dated(t), showStats: false, ctx })).join('\n')}
<nav class="pager">
  <span>${prev ? `<a href="/threads/${esc(prev.slug)}/">← ${esc(prev.title)}</a>` : ''}</span>
  <span>${next ? `<a href="/threads/${esc(next.slug)}/">${esc(next.title)} →</a>` : ''}</span>
</nav>`,
  });
}

function threadsIndex(list) {
  const rows = list.map(({ th, name }) => `<tr data-date="${esc(th.date)}" data-len="${th.len}" data-likes="${th.likes}" data-rts="${th.rts}" data-title="${esc(name.title)}">
<td><a class="title" href="/threads/${esc(name.slug)}/">${esc(name.title)}</a></td>
<td class="date">${esc(th.date)}</td>
<td class="num">${th.len}</td>
<td class="num">${num(th.likes)}</td>
<td class="num">${num(th.rts)}</td>
</tr>`).join('\n');

  return layout({
    title: `Threads — ${SITE_TITLE}`,
    description: `${num(list.length)} threads by @${USERNAME}, sortable by date, length, likes, and retweets.`,
    canonical: '/threads/',
    nav: 'threads',
    body: `<h1>Threads</h1>
<p class="lede">${num(list.length)} threads worth sharing — every self-reply chain of at least
${THREAD_MIN_LEN} tweets that either runs ${THREAD_MIN_TWEETS}+ tweets long or picked up
${THREAD_MIN_LIKES}+ likes. Shorter chains are a tweet with an afterthought, and live on
<a href="/top/">Top tweets</a> instead. Click a column to re-sort.</p>
<div class="tbl-wrap"><table class="rows">
<thead><tr>
  <th data-sort="title" data-type="text">Topic</th>
  <th data-sort="date" data-type="text" class="sorted" data-dir="desc">Date</th>
  <th data-sort="len">Tweets</th>
  <th data-sort="likes">Likes</th>
  <th data-sort="rts">RTs</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
${SORT_SCRIPT}`,
  });
}

function topPage(tweets, count) {
  const rows = tweets.map(t => {
    const text = t.text.replace(/https?:\/\/t\.co\/\w+/g, '').replace(/\s+/g, ' ').trim();
    return `<tr data-date="${esc(t.date)}" data-likes="${t.likes}" data-rts="${t.rts}" data-ratio="${t.likes ? (t.rts / t.likes).toFixed(4) : 0}">
<td><a href="${esc(permalink(t))}">${esc(text.slice(0, 400))}</a></td>
<td class="date"><a href="/by-month/${t.month}/">${esc(t.date)}</a></td>
<td class="num">${num(t.likes)}</td>
<td class="num">${num(t.rts)}</td>
<td class="num">${t.likes ? (100 * t.rts / t.likes).toFixed(0) + '%' : '—'}</td>
</tr>`;
  }).join('\n');

  return layout({
    title: `Top tweets — ${SITE_TITLE}`,
    description: `The most-liked and most-retweeted of @${USERNAME}'s ${num(count)} tweets.`,
    canonical: '/top/',
    nav: 'top',
    wide: true,
    body: `<h1>Top tweets</h1>
<p class="lede">The ${num(tweets.length)} most-liked tweets out of ${num(count)}.
Sort by retweets, date, or RT-to-like ratio — the last one surfaces the tweets people
passed on rather than just enjoyed.</p>
<div class="tbl-wrap"><table class="rows">
<thead><tr>
  <th>Tweet</th>
  <th data-sort="date" data-type="text">Date</th>
  <th data-sort="likes" class="sorted" data-dir="desc">Likes</th>
  <th data-sort="rts">RTs</th>
  <th data-sort="ratio" title="Retweets as a share of likes">RT/like</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
${SORT_SCRIPT}`,
  });
}

// Malcolm's best-received replies to other people. A reply is the one kind of tweet
// here that was written into someone else's conversation, so each is shown under the
// tweet it answers — the halves are only worth reading together. Where that tweet is
// gone (deleted, or an account since locked) the reply stands alone with a link.
// A handful are demoted by hand (config.js) and sit at the bottom under their own
// heading, out of like order — the heading is there so that reads as deliberate.
function repliesPage({ kept, demoted }, total, ctx) {
  const render = ts => ts.map(t => tweetHtml(t, { ctx })).join('\n');
  const tail = demoted.length
    ? `<p class="demoted-head">And ${demoted.length === 1 ? 'one that did well' : `${demoted.length} that did well`}
without being worth reading first, or answering a tweet that has since been deleted.</p>
${render(demoted)}`
    : '';
  const count = kept.length + demoted.length;
  return layout({
    title: `Top replies — ${SITE_TITLE}`,
    description: `The best-received of the ${num(total)} replies @${USERNAME} has written to other people, each under the tweet it answers.`,
    canonical: '/replies/',
    nav: 'replies',
    body: `<h1>Top replies</h1>
<p class="lede">The ${num(count)} most-liked of @${USERNAME}'s ${num(total)} replies to other
people. A reply is half a conversation, so each one sits under the tweet it answers —
pulled from Twitter, and missing where that tweet has since been deleted.</p>
${render(kept)}
${tail}`,
  });
}

// Everything retweeted from someone else, newest first. These are on the site because
// they're part of the record of what Malcolm was reading and boosting — but nothing
// here counts towards his own numbers, and the reach column is the original tweet's.
function retweetsPage(rts, accounts) {
  const rows = [...rts].reverse().map(t => {
    const text = t.rtBody.replace(/https?:\/\/t\.co\/\w+/g, '').replace(/\s+/g, ' ').trim();
    return `<tr data-date="${esc(t.date)}" data-user="${esc(t.rtUser.toLowerCase())}" data-rts="${t.rts}">
<td><a class="rt-user" href="https://x.com/${esc(t.rtUser)}">@${esc(t.rtUser)}</a></td>
<td><a href="${esc(permalink(t))}">${esc(text.slice(0, 400))}</a></td>
<td class="date"><a href="/by-month/${t.month}/">${esc(t.date)}</a></td>
<td class="num">${num(t.rts)}</td>
</tr>`;
  }).join('\n');

  const isSelf = u => u.toLowerCase() === USERNAME.toLowerCase();
  const self = accounts.find(a => isSelf(a.user));
  const top = accounts.slice(0, 40).map(a =>
    `<li><a href="https://x.com/${esc(a.user)}">@${esc(a.user)}</a> <span class="n">${num(a.count)}${isSelf(a.user) ? ', himself' : ''}</span></li>`).join('');

  return layout({
    title: `Retweets — ${SITE_TITLE}`,
    description: `${num(rts.length)} tweets @${USERNAME} has retweeted, from ${num(accounts.length)} accounts.`,
    canonical: '/retweets/',
    nav: 'retweets',
    wide: true,
    body: `<h1>Retweets</h1>
<p class="lede">${num(rts.length)} tweets @${USERNAME} has passed on, from ${num(accounts.length)}
accounts${self ? ` — including ${num(self.count)} re-shares of his own` : ''}. None of it counts
towards his tweets, likes or retweets anywhere else on the site: a retweet's engagement belongs
to whoever wrote the tweet, and re-sharing his own would count it twice. They still show up in
place on the <a href="/by-month/">month pages</a>, where they can be toggled off.</p>
<h2>Most retweeted</h2>
<ul class="rt-top">${top}</ul>
<h2>All of them</h2>
<p class="search-row">
  <input type="search" data-search="rt-table" data-count="rt-shown" placeholder="Filter by account or text…" aria-label="Filter retweets">
  <span class="search-count"><span id="rt-shown"></span>newest first</span>
</p>
<div class="tbl-wrap"><table class="rows" id="rt-table">
<thead><tr>
  <th data-sort="user" data-type="text">Account</th>
  <th>Tweet</th>
  <th data-sort="date" data-type="text" class="sorted" data-dir="desc">Date</th>
  <th data-sort="rts" title="Retweets on the original tweet — the author's reach, not Malcolm's">Reach</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>
${SORT_SCRIPT}
${SEARCH_SCRIPT}`,
  });
}

function homePage({ archive, ms, threadList, topThreads, replyCount }) {
  const totals = ms.reduce((a, m) => ({ likes: a.likes + m.likes, rts: a.rts + m.rts }), { likes: 0, rts: 0 });
  const rtCount = archive.retweets.length;
  // The counts sit on the banner rather than the page: what the site is, is the
  // mosaic plus these four numbers, and the sections below say the rest themselves.
  const stats = `<div class="stats">
  <div><b>${num(archive.own.length)}</b> tweets</div>
  <div><b>${num(totals.likes)}</b> likes</div>
  <div><b>${num(totals.rts)}</b> retweets</div>
  <div><b>${num(threadList.length)}</b> threads</div>
</div>`;
  return layout({
    title: SITE_TITLE,
    description: `An archive of @${USERNAME}'s ${num(archive.own.length)} tweets, browsable by month, by thread, and by what did best.`,
    canonical: '/',
    overBanner: stats,
    body: `<h2><span class="h-ico" aria-hidden="true">📅</span><a href="/by-month/">By month</a></h2>
<p>A ${ms.length}-month calendar, each month coloured by its retweets, likes, and volume.</p>
<h2><span class="h-ico" aria-hidden="true">🧵</span><a href="/threads/">Threads</a></h2>
<p>${num(threadList.length)} threads worth sharing, each on its own page, sortable by date, length, or reception.</p>
<ul>${topThreads.map(({ th, name }) =>
  `<li><a href="/threads/${esc(name.slug)}/">${esc(name.title)}</a> <span style="color:var(--faint)">— ${th.len} tweets, ${num(th.likes)} likes</span></li>`).join('\n')}</ul>
<h2><span class="h-ico" aria-hidden="true">❤️</span><a href="/top/">Top tweets</a></h2>
<p>The most-liked and most-retweeted, sortable several ways.</p>
<div class="rando" id="rando"></div>
<h2><span class="h-ico" aria-hidden="true">💬</span><a href="/replies/">Top replies</a></h2>
<p>The best-received of the ${num(replyCount)} replies he's written to other people, each shown
under the tweet it answers.</p>
<h2><span class="h-ico" aria-hidden="true">🔁</span><a href="/retweets/">Retweets</a></h2>
<p>${num(rtCount)} tweets passed on, searchable and tallied by who wrote them.</p>
${RANDOM_TOP_SCRIPT}`,
  });
}

// --- driver ----------------------------------------------------------------

async function main() {
  const archive = await loadArchive();
  const names = await readFile(THREAD_NAMES_JSON, 'utf8').then(JSON.parse).catch(() => ({}));
  // Quoted and replied-to tweets, fetched by fetch-embeds.js. Absent (or absent for
  // a given tweet) the pages still build — those tweets just get a link instead of
  // the thing they're answering.
  const embeds = await loadEmbeds();
  const ctx = embedContext(archive, embeds);

  const chains = assembleChains(archive);
  const chainOf = new Map();
  for (const c of chains) for (const t of c) chainOf.set(t.id, c);

  const allThreads = chains.map(chainToThread);
  const shareable = allThreads.filter(worthSharing).sort((a, b) => (a.at < b.at ? 1 : -1));

  // Slugs are the URL, so they must be unique and stable; a collision takes a
  // numeric suffix in date order (newest first), which is the iteration order here.
  const used = new Set();
  const named = new Map();
  const list = [];
  for (const th of shareable) {
    const raw = names[th.id];
    if (!raw) continue; // not yet named — name-threads.js will pick it up next run
    let slug = raw.slug;
    for (let n = 2; used.has(slug); n++) slug = `${raw.slug}-${n}`;
    used.add(slug);
    const name = { slug, title: raw.title };
    named.set(th.id, name);
    list.push({ th, name });
  }

  const ms = months(archive);
  const color = colorScale(ms);

  await rm(PUBLIC_DIR, { recursive: true, force: true });
  await mkdir(PUBLIC_DIR, { recursive: true });
  await cp(join(SRC, 'assets'), PUBLIC_DIR, { recursive: true });

  const topThreads = [...list].sort((a, b) => b.th.likes - a.th.likes).slice(0, 6);
  const replyCount = archive.own.filter(t => t.isReplyToOther).length;
  await page('', homePage({ archive, ms, threadList: list, topThreads, replyCount }), { priority: 1.0 });
  await page('by-month', calendarPage(ms, color), { priority: 0.9 });
  await page('threads', threadsIndex(list), { priority: 0.9 });

  // A month with nothing but retweets still gets a page — the retweets are on it.
  const withTweets = ms.filter(m => m.tweets.length);
  for (let i = 0; i < withTweets.length; i++) {
    await page(`by-month/${withTweets[i].key}`,
      monthPage(withTweets[i], withTweets[i - 1], withTweets[i + 1], chainOf, named, ctx),
      { priority: 0.7 });
  }
  console.log(`${withTweets.length} month pages`);

  for (let i = 0; i < list.length; i++) {
    await page(`threads/${list[i].name.slug}`,
      threadPage(list[i].th, list[i].name, list[i + 1]?.name, list[i - 1]?.name, ctx),
      { priority: 0.8 });
  }
  console.log(`${list.length} thread pages`);

  const top = [...archive.own].sort((a, b) => b.likes - a.likes).slice(0, TOP_TWEETS);
  await page('top', topPage(top, archive.own.length), { priority: 0.9 });

  // The homepage draws one of these at random on each visit, in the browser. They
  // are rendered here, with the same function that renders every other tweet on the
  // site, so the one that lands is a tweet of this site's and not an embed of
  // Twitter's. Only the first slice: past a few hundred a "top tweet" isn't one.
  const sample = top.slice(0, RANDOM_TOP_SAMPLE).map(t => tweetHtml(t, { ctx }));
  const sampleJson = JSON.stringify(sample);
  await writeFile(join(PUBLIC_DIR, 'random-top.json'), sampleJson);
  console.log(`${sample.length} tweets in the homepage's random pick (${Math.round(sampleJson.length / 1024)} KB)`);

  const replies = topReplies(archive, TOP_REPLIES);
  await page('replies', repliesPage(replies, replyCount, ctx), { priority: 0.8 });
  const all = [...replies.kept, ...replies.demoted];
  const withParent = all.filter(t => ctx.embed(t.replyTo)).length;
  console.log(`${all.length} top replies of ${num(replyCount)} (${withParent} with the tweet they answer, ${replies.demoted.length} demoted)`);

  const accounts = retweetedAccounts(archive);
  await page('retweets', retweetsPage(archive.retweets, accounts), { priority: 0.6 });
  console.log(`${num(archive.retweets.length)} retweets from ${num(accounts.length)} accounts (uncounted)`);

  const lastmod = archive.fetchedAt.slice(0, 10);
  await writeFile(join(PUBLIC_DIR, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `<url><loc>${SITE}${u.loc}</loc><lastmod>${lastmod}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`);
  await writeFile(join(PUBLIC_DIR, 'robots.txt'),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  console.log(`${urls.length} pages total`);
}

main().catch(e => { console.error(e); process.exit(1); });
