# Working in this repo

`README.md` covers what the site is and how the pipeline fits together — read it first.

## Voice

**It's Twitter, not X.** Anywhere the site speaks to a reader — link text, labels, prose,
meta descriptions — call it Twitter. The `x.com` hostname in URLs stays as-is, because
that's the address, not the name.

## Thread pages read like blog posts

`/threads/<slug>/` is the one place tweets are meant to be read straight through as one
piece of writing, so per-tweet chrome is stripped there and kept everywhere else:

- No like/RT counts on individual tweets (`showStats: false`). The thread-level totals in
  the lede stay; `/top/`, `/replies/`, month pages, and the thread index keep theirs.
- Only the opening tweet is dated, plus any tweet posted 24h or more after the thread
  started — that gap is real information, the minute-by-minute ones aren't.
- Undated tweets get the permalink as an inline SVG glyph, never a word. A copy-paste of
  a thread should come back as clean prose, which rules out text hidden by CSS.
