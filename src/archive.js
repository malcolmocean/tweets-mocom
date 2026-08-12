// Thin client for community-archive.org's public Supabase REST API.
// Docs: github.com/TheExGenesis/community-archive docs/api-doc.md
const SUPABASE = 'https://fabxmporizzqflnftavs.supabase.co';
// Public anon key (documented in the community-archive repo).
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhYnhtcG9yaXp6cWZsbmZ0YXZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjIyNDQ5MTIsImV4cCI6MjAzNzgyMDkxMn0.UIEJiUNkLsW28tBHmG-RQDW-I5JNlJLt62CSk9D_qG8';

export async function ca(path, { retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${SUPABASE}/rest/v1/${path}`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`community-archive HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// Pages through a table in `pageSize` chunks until a short page comes back.
// `order` must be on a unique-ish column so offsets stay stable across pages.
export async function caPaged(table, query, { pageSize = 1000, order, onPage = () => {} } = {}) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await ca(`${table}?${query}&order=${order}&limit=${pageSize}&offset=${offset}`);
    out.push(...rows);
    onPage(out.length);
    if (rows.length < pageSize) break;
  }
  return out;
}

export async function findAccount(username) {
  const rows = await ca(`account?username=ilike.${encodeURIComponent(username)}&select=account_id,username,account_display_name,num_tweets,num_followers`);
  if (!rows.length) throw new Error(`@${username} not found in community-archive`);
  return rows[0];
}
