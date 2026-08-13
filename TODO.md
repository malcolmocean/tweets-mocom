# visual
- [x] theme upgrades: use twitter blue everywhere.
  - accent palette → #1d9bf0 (light) / #45a8f2 (dark) in style.css
- [x] make a header that's got the same vibe as the header of malcolmocean.com but is twitter blue.
  - ran malcolmocean.com's mosaic header.png through a hue-compression filter (all hues
    mapped to twitter-blue ±14°) → src/assets/header-bg.png; full-width banner with
    white title + nav, favicon cropped from the same mosaic
- [x] make 1-3 additional ui/ux improvements
  - favicon + theme-color meta, ::selection / :focus-visible in twitter blue,
    faint blue wash on tweet hover

# content
- [x] for QTs, embed them using... the same method that ~/dev/xyxz uses
  - also for tweets that are replies
  - `npm run fetch-embeds` → data/embeds.json (syndication API), cards render above replies
    and below QTs. Quotes of his own tweets link to this site instead of X.

- [x] relatedly, we should have a page for "top replies"
  - /replies/ — 250 most-liked, each under the tweet it answers

- [x] threads that 3 or fewer tweets, I think just shouldn't be counted as threads. in practice any that were
  - included are probably under "top tweets"
  - THREAD_MIN_LEN = 4 in config.js; 965 threads → 648

# auto-updating
- [ ] write a script that will automatically pull more items from community archive and regenerate the site
