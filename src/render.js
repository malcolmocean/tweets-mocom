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
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="wrap${wide ? ' wide' : ''}">
<header class="site-head">
  <a class="home" href="/">${esc(SITE_TITLE)}</a>
  <nav>
    <a href="/by-month/"${nav === 'by-month' ? ' class="on"' : ''}>By month</a>
    <a href="/threads/"${nav === 'threads' ? ' class="on"' : ''}>Threads</a>
    <a href="/top/"${nav === 'top' ? ' class="on"' : ''}>Top</a>
  </nav>
</header>
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
function linkify(tweet) {
  const byShort = new Map((tweet.urls || []).map(u => [u.t, u]));
  let out = '';
  const re = /(https?:\/\/t\.co\/\w+)|(https?:\/\/[^\s<]+)|(^|\s)@(\w{1,15})|(^|\s)#(\w+)/g;
  let last = 0;
  for (const m of tweet.text.matchAll(re)) {
    out += esc(tweet.text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      const u = byShort.get(m[1]);
      if (!u) continue; // media/self link with no expansion — the image renders below
      out += `<a href="${esc(u.x)}" rel="nofollow ugc">${esc(u.d || u.x)}</a>`;
    } else if (m[2]) {
      out += `<a href="${esc(m[2])}" rel="nofollow ugc">${esc(m[2])}</a>`;
    } else if (m[4]) {
      out += `${m[3]}<a href="https://x.com/${esc(m[4])}">@${esc(m[4])}</a>`;
    } else if (m[6]) {
      out += `${m[5]}<a href="https://x.com/hashtag/${esc(m[6])}">#${esc(m[6])}</a>`;
    }
  }
  return out + esc(tweet.text.slice(last));
}

export const permalink = t => `https://x.com/${USERNAME}/status/${t.id}`;

const fmtDate = at => new Date(at).toLocaleDateString('en-US',
  { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function tweetHtml(t, { showDate = true } = {}) {
  const cls = t.isReplyToOther ? 'tweet is-reply' : 'tweet';
  const media = t.media.map(m => m.type === 'photo'
    // Twitter's CDN has dropped some older media; a broken image removes its own figure.
    ? `<div class="media"><img src="${esc(m.url)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></div>`
    : `<div class="media"><a href="${esc(permalink(t))}">[${esc(m.type)}]</a></div>`).join('');
  const replyTo = t.isReplyToOther && t.replyToUsername
    ? `<p class="reply-to">Replying to <a href="https://x.com/${esc(t.replyToUsername)}">@${esc(t.replyToUsername)}</a></p>`
    : '';
  // The quoted tweet usually also appears as an expanded t.co link in the text;
  // only add a separate line when it doesn't, so the same link isn't shown twice.
  const quoteLinked = t.quotes && (t.urls || []).some(u => u.x.includes(t.quotes));
  const quote = t.quotes && !quoteLinked
    ? `<p class="quotes">↩ <a href="https://x.com/i/status/${esc(t.quotes)}" rel="nofollow ugc">quoting a tweet</a></p>`
    : '';
  return `<article class="${cls}" id="t${esc(t.id)}">
${replyTo}<p class="tweet-text">${linkify(t)}</p>${media}${quote}
<p class="tweet-meta">
  ${showDate ? `<a href="${esc(permalink(t))}"><time datetime="${esc(t.at)}">${esc(fmtDate(t.at))}</time></a>` : `<a href="${esc(permalink(t))}">on X</a>`}
  <span class="stat">${plural(t.likes, 'like')}</span>
  <span class="stat">${plural(t.rts, 'RT')}</span>
</p>
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

export const FILTER_SCRIPT = `<script>
document.querySelectorAll('input[data-filter="replies"]').forEach(function (box) {
  var apply = function () { document.body.classList.toggle('hide-replies', !box.checked); };
  box.addEventListener('change', apply);
  apply();
});
</script>`;
