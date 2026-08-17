// HTML rendering: page shell, tweet markup, and the small client-side scripts
// (sorting, reply filtering) that the static pages carry.
import { SITE, SITE_TITLE, USERNAME } from './config.js';

export const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export const num = n => n.toLocaleString('en-US');
const plural = (n, word) => `<b>${num(n)}</b> ${word}${n === 1 ? '' : 's'}`;

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = key => {
  const [y, m] = key.split('-');
  return `${MONTH_FULL[Number(m) - 1]} ${y}`;
};

export function layout({ title, description, body, nav = '', canonical, wide = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(SITE + canonical)}">` : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
${canonical ? `<meta property="og:url" content="${esc(SITE + canonical)}">` : ''}
<meta name="twitter:card" content="summary">
<meta name="twitter:creator" content="@${USERNAME}">
<meta name="theme-color" content="#1d9bf0">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="banner">
  <div class="banner-in${wide ? ' wide' : ''}">
    <a class="home" href="/">${esc(SITE_TITLE)}</a>
    <nav>
      <a href="/by-month/"${nav === 'by-month' ? ' class="on"' : ''}>By month</a>
      <a href="/threads/"${nav === 'threads' ? ' class="on"' : ''}>Threads</a>
      <a href="/top/"${nav === 'top' ? ' class="on"' : ''}>Top</a>
      <a href="/replies/"${nav === 'replies' ? ' class="on"' : ''}>Replies</a>
      <a href="/retweets/"${nav === 'retweets' ? ' class="on"' : ''}>Retweets</a>
    </nav>
  </div>
</header>
<div class="wrap${wide ? ' wide' : ''}">
${body}
<footer>
  Tweets by <a href="https://x.com/${USERNAME}">@${USERNAME}</a> ·
  archive from <a href="https://www.community-archive.org/">Community Archive</a> ·
  more at <a href="https://malcolmocean.com">malcolmocean.com</a>
</footer>
</div>
</body>
</html>
`;
}

// --- tweet text ------------------------------------------------------------

// t.co shorteners are replaced with the expanded target the archive recorded;
// a link whose expansion we don't have is dropped rather than left as a dead t.co.
// `omit(url)` drops links we're rendering as a card instead — the quoted tweet's
// URL, which Twitter itself swallows into the embed rather than showing twice.
export function linkify(tweet, text = tweet.text, { omit = null } = {}) {
  const byShort = new Map((tweet.urls || []).map(u => [u.t, u]));
  let out = '';
  const re = /(https?:\/\/t\.co\/\w+)|(https?:\/\/[^\s<]+)|(^|\s)@(\w{1,15})|(^|\s)#(\w+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      const u = byShort.get(m[1]);
      if (!u) continue; // media/self link with no expansion — the image renders below
      if (omit?.(u.x)) continue;
      out += `<a href="${esc(u.x)}" rel="nofollow ugc">${esc(u.d || u.x)}</a>`;
    } else if (m[2]) {
      if (omit?.(m[2])) continue;
      out += `<a href="${esc(m[2])}" rel="nofollow ugc">${esc(m[2])}</a>`;
    } else if (m[4]) {
      out += `${m[3]}<a href="https://x.com/${esc(m[4])}">@${esc(m[4])}</a>`;
    } else if (m[6]) {
      out += `${m[5]}<a href="https://x.com/hashtag/${esc(m[6])}">#${esc(m[6])}</a>`;
    }
  }
  return out + esc(text.slice(last));
}

export const permalink = t => `https://x.com/${USERNAME}/status/${t.id}`;

// The undated tweets in a thread still need a way out to the original, but a word
// there would land in anything copied off the page and break the prose. An
// open-in-new-window glyph is drawn, not written, so a copy takes the text only.
const PERMALINK_ICON = `<svg class="ext" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true" focusable="false"><path d="M8 2.25H3.25A1.5 1.5 0 0 0 1.75 3.75v7A1.5 1.5 0 0 0 3.25 12.25h7a1.5 1.5 0 0 0 1.5-1.5V6"/><path d="M9.25 1.25h3.75v3.75M13 1.25 6.5 7.75"/></svg>`;

const fmtDate = at => new Date(at).toLocaleDateString('en-US',
  { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

// A card is context, not the main event: a very long tweet (Malcolm's own can run to
// thousands of characters) is cut at a word boundary and finished by clicking through.
// Tweets fetched from the syndication API arrive at ~280 chars and are never cut.
const EMBED_MAX_CHARS = 600;
function embedText(text) {
  if (text.length <= EMBED_MAX_CHARS) return { text, cut: false };
  const head = text.slice(0, EMBED_MAX_CHARS);
  const space = head.lastIndexOf(' ');
  return { text: head.slice(0, space > EMBED_MAX_CHARS / 2 ? space : EMBED_MAX_CHARS).trimEnd() + '…', cut: true };
}

// A tweet by someone else that this archive points at — quoted, or replied to —
// rendered in place so the tweet around it makes sense on its own. The text is the
// other person's, so the card says whose it is and links to the original; when it's
// one of Malcolm's own, the link stays on this site.
export function embedHtml(e, { label = '' } = {}) {
  const body = embedText(e.text);
  const extra = [];
  // The first photo is shown; any others are counted, as is video (never shown —
  // there's no still to hot-link, only a player).
  const rest = e.photos - (e.photo ? 1 : 0);
  if (rest > 0) extra.push(`${num(rest)} more photo${rest === 1 ? '' : 's'}`);
  if (e.video) extra.push('video');
  const when = e.at
    ? ` · <a class="embed-when" href="${esc(e.href)}"><time datetime="${esc(e.at)}">${esc(fmtDate(e.at))}</time></a>`
    : '';
  return `<blockquote class="embed">
<p class="embed-head">${label ? `${esc(label)} ` : ''}<a class="embed-who" href="https://x.com/${esc(e.user)}"><b>${esc(e.name || e.user)}</b> @${esc(e.user)}</a>${when}</p>
<p class="embed-text">${linkify(e, body.text)}</p>${body.cut
    ? `\n<p class="embed-extra"><a href="${esc(e.href)}">read the whole tweet →</a></p>` : ''}${e.photo
    ? `\n<div class="media"><img src="${esc(e.photo)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></div>`
    : ''}${extra.length ? `\n<p class="embed-extra">[${esc(extra.join(' + '))}]</p>` : ''}${e.truncated
    ? `\n<p class="embed-extra">[long tweet — <a href="${esc(e.href)}">read the rest on Twitter</a>]</p>` : ''}${e.quoted
    ? `\n<p class="embed-quoted">quoting <a href="https://x.com/${esc(e.quoted.user)}">@${esc(e.quoted.user)}</a>: ${esc(e.quoted.text.slice(0, 280))}</p>` : ''}
</blockquote>`;
}

// `ctx.embed(id)` supplies the card data for a referenced tweet, if we have it —
// see embedContext() in embeds.js. Without it (or without a cached embed) the tweet
// renders as it always did: a line naming who was being answered or quoted.
// `showStats: false` drops the like/RT counts — thread pages read as one piece of
// writing, and a score under every paragraph pulls against that.
export function tweetHtml(t, { showDate = true, showStats = true, ctx = null } = {}) {
  const cls = 'tweet' + (t.isReplyToOther ? ' is-reply' : '') + (t.isRetweet ? ' is-retweet' : '');
  const media = t.media.map(m => m.type === 'photo'
    // Twitter's CDN has dropped some older media; a broken image removes its own figure.
    ? `<div class="media"><img src="${esc(m.url)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></div>`
    : `<div class="media"><a href="${esc(permalink(t))}">[${esc(m.type)}]</a></div>`).join('');
  const parent = t.isReplyToOther ? ctx?.embed(t.replyTo) : null;
  const replyTo = parent
    ? embedHtml(parent, { label: 'Replying to' })
    : t.isReplyToOther && t.replyToUsername
      // The tweet being answered is one URL away even when we couldn't fetch it.
      ? `<p class="reply-to">Replying to <a href="https://x.com/${esc(t.replyToUsername)}/status/${esc(t.replyTo)}">@${esc(t.replyToUsername)}</a></p>`
      : '';
  // The "RT @them:" prefix becomes an attribution line, so the body below reads as
  // what it is — someone else's tweet, passed on.
  const rtHead = t.isRetweet
    ? `<p class="rt-head">Retweeted <a href="https://x.com/${esc(t.rtUser)}">@${esc(t.rtUser)}</a></p>`
    : '';
  // A quote-tweet: the card carries the quoted tweet, so the link to it comes out of
  // the text — Twitter swallows it into the embed too, rather than showing it twice.
  const quoted = t.quotes ? ctx?.embed(t.quotes) : null;
  const omit = quoted ? url => url.includes(t.quotes) : null;
  // Without the card, the quoted tweet is a line — but only when the text doesn't
  // already carry the link, so the same URL isn't shown twice.
  const quoteLinked = t.quotes && (t.urls || []).some(u => u.x.includes(t.quotes));
  const quote = quoted
    ? embedHtml(quoted)
    : t.quotes && !quoteLinked
      ? `<p class="quotes">↩ <a href="https://x.com/i/status/${esc(t.quotes)}" rel="nofollow ugc">quoting a tweet</a></p>`
      : '';
  // No like/RT counts on a retweet: the archive's numbers there are the original
  // tweet's, and showing them next to your own would read as yours.
  const stats = t.isRetweet || !showStats ? '' :
    `<span class="stat">${plural(t.likes, 'like')}</span>
  <span class="stat">${plural(t.rts, 'RT')}</span>`;
  // Thread tweets (no date in the meta row) get their permalink as a small icon
  // pinned to the top-right corner instead of taking a line of its own.
  const corner = showDate ? '' :
    `<span class="permalink-pad" aria-hidden="true"></span><a class="permalink" href="${esc(permalink(t))}" title="Read this tweet on Twitter" aria-label="Read this tweet on Twitter">${PERMALINK_ICON}</a>`;
  const metaInner = [
    showDate ? `<a href="${esc(permalink(t))}"><time datetime="${esc(t.at)}">${esc(fmtDate(t.at))}</time></a>` : '',
    stats,
  ].filter(Boolean).join('\n  ');
  const meta = metaInner ? `<p class="tweet-meta">\n  ${metaInner}\n</p>` : '';
  return `<article class="${cls}" id="t${esc(t.id)}">
${corner}${rtHead}${replyTo}<p class="tweet-text">${linkify(t, t.isRetweet ? t.rtBody : t.text, { omit })}</p>${media}${quote}
${meta}
</article>`;
}

// --- client-side behaviour -------------------------------------------------

// Sorting stays client-side so every page is one static file with all rows in
// the HTML — good for readers without JS, and for anything crawling the text.
export const SORT_SCRIPT = `<script>
document.querySelectorAll('table.rows').forEach(function (table) {
  var body = table.tBodies[0];
  table.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.insertAdjacentHTML('beforeend', ' <span class="arrow">\\u2193</span>');
    th.addEventListener('click', function () {
      var key = th.dataset.sort;
      var numeric = th.dataset.type !== 'text';
      var desc = th.dataset.dir !== 'desc';
      table.querySelectorAll('th[data-sort]').forEach(function (o) {
        o.classList.toggle('sorted', o === th);
        if (o !== th) delete o.dataset.dir;
      });
      th.dataset.dir = desc ? 'desc' : 'asc';
      th.querySelector('.arrow').textContent = desc ? '\\u2193' : '\\u2191';
      var rows = Array.prototype.slice.call(body.rows);
      rows.sort(function (a, b) {
        var x = a.dataset[key], y = b.dataset[key];
        if (numeric) { x = parseFloat(x) || 0; y = parseFloat(y) || 0; return desc ? y - x : x - y; }
        return desc ? String(y).localeCompare(x) : String(x).localeCompare(y);
      });
      rows.forEach(function (r) { body.appendChild(r); });
    });
  });
});
</script>`;

// Each checkbox owns one body class (hide-replies, hide-retweets); the rows stay in
// the HTML either way, so crawlers and no-JS readers still see everything.
export const FILTER_SCRIPT = `<script>
document.querySelectorAll('input[data-filter]').forEach(function (box) {
  var cls = 'hide-' + box.dataset.filter;
  var apply = function () { document.body.classList.toggle(cls, !box.checked); };
  box.addEventListener('change', apply);
  apply();
});
</script>`;

// Substring search over table rows. The haystack is read off the rows themselves
// rather than emitted as a data- attribute — on a 6k-row page that duplicated text
// was more than half the bytes on the wire. Indexed once, lazily, on first keystroke.
export const SEARCH_SCRIPT = `<script>
document.querySelectorAll('input[data-search]').forEach(function (input) {
  var rows = Array.prototype.slice.call(
    document.getElementById(input.dataset.search).tBodies[0].rows);
  var out = document.getElementById(input.dataset.count);
  var hay = null;
  input.value = '';
  input.addEventListener('input', function () {
    if (!hay) hay = rows.map(function (r) { return r.textContent.toLowerCase(); });
    var q = input.value.trim().toLowerCase().replace(/^@/, '');
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var hit = !q || hay[i].indexOf(q) !== -1;
      rows[i].hidden = !hit;
      if (hit) shown++;
    }
    if (out) out.textContent = shown === rows.length ? '' : shown.toLocaleString('en-US') + ' matching · ';
  });
});
</script>`;
