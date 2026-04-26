const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const AL_STATUS_LABEL = {
  CURRENT:   'Watching',
  COMPLETED: 'Completed',
  PAUSED:    'On Hold',
  DROPPED:   'Dropped',
  PLANNING:  'Plan to Watch',
  REPEATING: 'Rewatching',
};

const AL_TO_MAL_CODE = {
  CURRENT:   1,
  COMPLETED: 2,
  PAUSED:    3,
  DROPPED:   4,
  PLANNING:  6,
  REPEATING: 1,
};

const MAL_STATUS_LABEL = { 1: 'Watching', 2: 'Completed', 3: 'On Hold', 4: 'Dropped', 6: 'Plan to Watch' };

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function safeJson(res, source) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} returned an unexpected response (possibly down or blocking the request)`);
  }
}

async function fetchAniList(username) {
  const query = `
    query ($userName: String) {
      MediaListCollection(userName: $userName, type: ANIME) {
        lists {
          entries {
            media { id idMal title { romaji english } episodes }
            status
            progress
          }
        }
      }
    }
  `;
  const { signal, clear } = withTimeout(20000);
  let res;
  try {
    res = await fetch('https://graphql.anilist.co', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ query, variables: { userName: username } }),
      signal,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'AniList request timed out' : `AniList unreachable: ${err.message}`);
  } finally {
    clear();
  }

  const json = await safeJson(res, 'AniList');
  if (json.errors) throw new Error(`AniList: ${json.errors[0]?.message ?? 'Unknown error'}`);

  const entries = [];
  for (const list of json.data.MediaListCollection.lists) {
    for (const e of list.entries) {
      entries.push({
        anilistId: e.media.id,
        malId:     e.media.idMal,
        title:     e.media.title.english || e.media.title.romaji,
        totalEps:  e.media.episodes,
        status:    e.status,
        progress:  e.progress,
      });
    }
  }
  return entries;
}

async function fetchMAL(username) {
  const entries = [];
  let offset = 0;

  while (true) {
    const url = `https://myanimelist.net/animelist/${encodeURIComponent(username)}/load.json?status=7&offset=${offset}`;
    const { signal, clear } = withTimeout(20000);
    let res;
    try {
      res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        signal,
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'MAL request timed out' : `MAL unreachable: ${err.message}`);
    } finally {
      clear();
    }

    if (res.status === 400 || res.status === 404) throw new Error(`MAL: user "${username}" not found`);
    if (res.status === 403) throw new Error(`MAL: "${username}"'s list is private`);
    if (!res.ok) throw new Error(`MAL: server returned ${res.status}`);

    const batch = await safeJson(res, 'MAL');

    if (!Array.isArray(batch)) throw new Error(`MAL: unexpected response format`);

    if (batch.length === 0 && offset === 0) {
      throw new Error(`MAL: "${username}"'s list appears to be empty or private`);
    }
    if (batch.length === 0) break;

    for (const item of batch) {
      entries.push({
        malId:    item.anime_id,
        title:    item.anime_title_eng || item.anime_title,
        status:   item.status,
        progress: item.num_watched_episodes,
        totalEps: item.anime_num_episodes || null,
      });
    }

    if (batch.length < 300) break;
    offset += 300;
    await new Promise(r => setTimeout(r, 400));
  }

  return entries;
}

// ── AniList → MAL export ─────────────────────────────────────────────────────

const AL_TO_MAL_STATUS = {
  CURRENT:   'Watching',
  COMPLETED: 'Completed',
  PAUSED:    'On-Hold',
  DROPPED:   'Dropped',
  PLANNING:  'Plan to Watch',
  REPEATING: 'Watching',
};

async function fetchAniListForExport(username) {
  const query = `
    query ($userName: String) {
      MediaListCollection(userName: $userName, type: ANIME) {
        lists {
          entries {
            media { idMal title { romaji english } episodes }
            status
            score(format: POINT_10)
            progress
          }
        }
      }
    }
  `;
  const { signal, clear } = withTimeout(20000);
  let res;
  try {
    res = await fetch('https://graphql.anilist.co', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ query, variables: { userName: username } }),
      signal,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'AniList request timed out' : `AniList unreachable: ${err.message}`);
  } finally {
    clear();
  }

  const json = await safeJson(res, 'AniList');
  if (json.errors) throw new Error(`AniList: ${json.errors[0]?.message ?? 'Unknown error'}`);

  const all = json.data.MediaListCollection.lists.flatMap(l => l.entries);
  const skipped = all.filter(e => !e.media.idMal).map(e => e.media.title.english || e.media.title.romaji);
  const entries = all
    .filter(e => e.media.idMal)
    .map(e => ({
      malId:       e.media.idMal,
      title:       e.media.title.english || e.media.title.romaji,
      episodes:    e.media.episodes || 0,
      progress:    e.progress,
      score:       e.score,
      status:      AL_TO_MAL_STATUS[e.status] ?? 'Completed',
      rewatching:  e.status === 'REPEATING' ? 1 : 0,
    }));
  return { entries, skipped };
}

function buildMalXml(username, entries) {
  const counts = { Watching: 0, Completed: 0, 'On-Hold': 0, Dropped: 0, 'Plan to Watch': 0 };
  for (const e of entries) counts[e.status] = (counts[e.status] || 0) + 1;

  const nodes = entries.map(e => `  <anime>
    <series_animedb_id>${e.malId}</series_animedb_id>
    <series_title><![CDATA[${e.title}]]></series_title>
    <series_episodes>${e.episodes}</series_episodes>
    <my_id>0</my_id>
    <my_watched_episodes>${e.progress}</my_watched_episodes>
    <my_start_date>0000-00-00</my_start_date>
    <my_finish_date>0000-00-00</my_finish_date>
    <my_score>${e.score}</my_score>
    <my_status>${e.status}</my_status>
    <my_rewatching>${e.rewatching}</my_rewatching>
    <my_rewatching_ep>0</my_rewatching_ep>
    <my_times_watched>0</my_times_watched>
    <my_priority>LOW</my_priority>
    <my_comments><![CDATA[]]></my_comments>
    <my_tags><![CDATA[]]></my_tags>
    <my_discuss>0</my_discuss>
    <my_sns>default</my_sns>
    <update_on_import>1</update_on_import>
  </anime>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<myanimelist>
  <myinfo>
    <user_export_type>1</user_export_type>
    <user_total_anime>${entries.length}</user_total_anime>
    <user_total_watching>${counts['Watching']}</user_total_watching>
    <user_total_completed>${counts['Completed']}</user_total_completed>
    <user_total_onhold>${counts['On-Hold']}</user_total_onhold>
    <user_total_dropped>${counts['Dropped']}</user_total_dropped>
    <user_total_plantowatch>${counts['Plan to Watch']}</user_total_plantowatch>
  </myinfo>
${nodes}
</myanimelist>`;
}

app.get('/api/export/anilist-to-mal', async (req, res) => {
  const username = (req.query.username ?? '').trim();
  if (!username) return res.status(400).json({ error: 'Username is required.' });
  if (username.length > 100) return res.status(400).json({ error: 'Username is too long.' });

  try {
    const { entries, skipped } = await fetchAniListForExport(username);
    const xml = buildMalXml(username, entries);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mal-import-${username}.xml"`);
    res.setHeader('X-Skipped-Count', skipped.length);
    res.send(xml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AniList vs MAL ────────────────────────────────────────────────────────────

app.get('/api/compare', async (req, res) => {
  const alUser  = (req.query.al  ?? '').trim();
  const malUser = (req.query.mal ?? '').trim();

  if (!alUser || !malUser) return res.status(400).json({ error: 'Both usernames are required.' });
  if (alUser.length > 100 || malUser.length > 100) return res.status(400).json({ error: 'Username is too long.' });

  try {
    const [alEntries, malEntries] = await Promise.all([fetchAniList(alUser), fetchMAL(malUser)]);

    const alByMalId  = new Map(alEntries.filter(e => e.malId).map(e => [e.malId, e]));
    const malByMalId = new Map(malEntries.map(e => [e.malId, e]));

    const onlyAL      = [];
    const onlyMAL     = [];
    const statusDiffs = [];
    const epDiffs     = [];
    const noMalId     = [];

    for (const al of alEntries) {
      if (!al.malId) {
        noMalId.push({ title: al.title, status: AL_STATUS_LABEL[al.status] ?? al.status, progress: al.progress, totalEps: al.totalEps });
        continue;
      }
      const mal = malByMalId.get(al.malId);
      if (!mal) {
        onlyAL.push({ title: al.title, malId: al.malId, status: AL_STATUS_LABEL[al.status] ?? al.status, progress: al.progress, totalEps: al.totalEps });
        continue;
      }

      if (AL_TO_MAL_CODE[al.status] !== mal.status) {
        statusDiffs.push({
          title:       al.title,
          malId:       al.malId,
          alStatus:    AL_STATUS_LABEL[al.status]  ?? al.status,
          malStatus:   MAL_STATUS_LABEL[mal.status] ?? String(mal.status),
          alProgress:  al.progress,
          malProgress: mal.progress,
          totalEps:    al.totalEps ?? mal.totalEps,
        });
      }

      if (al.progress !== mal.progress) {
        epDiffs.push({
          title:       al.title,
          malId:       al.malId,
          alProgress:  al.progress,
          malProgress: mal.progress,
          totalEps:    al.totalEps ?? mal.totalEps,
          status:      AL_STATUS_LABEL[al.status] ?? al.status,
        });
      }
    }

    for (const mal of malEntries) {
      if (!alByMalId.has(mal.malId)) {
        onlyMAL.push({ title: mal.title, malId: mal.malId, status: MAL_STATUS_LABEL[mal.status] ?? String(mal.status), progress: mal.progress, totalEps: mal.totalEps });
      }
    }

    res.json({ alTotal: alEntries.length, malTotal: malEntries.length, onlyAL, onlyMAL, statusDiffs, epDiffs, noMalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AniList vs AniList ────────────────────────────────────────────────────────

app.get('/api/compare/al-al', async (req, res) => {
  const al1 = (req.query.al1 ?? '').trim();
  const al2 = (req.query.al2 ?? '').trim();

  if (!al1 || !al2) return res.status(400).json({ error: 'Both usernames are required.' });
  if (al1.length > 100 || al2.length > 100) return res.status(400).json({ error: 'Username is too long.' });

  try {
    const [list1, list2] = await Promise.all([fetchAniList(al1), fetchAniList(al2)]);

    const map1 = new Map(list1.map(e => [e.anilistId, e]));
    const map2 = new Map(list2.map(e => [e.anilistId, e]));

    const only1 = [], only2 = [], statusDiffs = [], epDiffs = [];

    for (const e1 of list1) {
      const e2 = map2.get(e1.anilistId);
      if (!e2) {
        only1.push({ title: e1.title, anilistId: e1.anilistId, malId: e1.malId, status: AL_STATUS_LABEL[e1.status] ?? e1.status, progress: e1.progress, totalEps: e1.totalEps });
        continue;
      }
      if (e1.status !== e2.status) {
        statusDiffs.push({
          title: e1.title, anilistId: e1.anilistId, malId: e1.malId,
          s1: AL_STATUS_LABEL[e1.status] ?? e1.status,
          s2: AL_STATUS_LABEL[e2.status] ?? e2.status,
          p1: e1.progress, p2: e2.progress,
          totalEps: e1.totalEps ?? e2.totalEps,
        });
      }
      if (e1.progress !== e2.progress) {
        epDiffs.push({
          title: e1.title, anilistId: e1.anilistId, malId: e1.malId,
          p1: e1.progress, p2: e2.progress,
          totalEps: e1.totalEps ?? e2.totalEps,
          status: AL_STATUS_LABEL[e1.status] ?? e1.status,
        });
      }
    }

    for (const e2 of list2) {
      if (!map1.has(e2.anilistId)) {
        only2.push({ title: e2.title, anilistId: e2.anilistId, malId: e2.malId, status: AL_STATUS_LABEL[e2.status] ?? e2.status, progress: e2.progress, totalEps: e2.totalEps });
      }
    }

    res.json({ t1: list1.length, t2: list2.length, only1, only2, statusDiffs, epDiffs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MAL vs MAL ────────────────────────────────────────────────────────────────

app.get('/api/compare/mal-mal', async (req, res) => {
  const mal1 = (req.query.mal1 ?? '').trim();
  const mal2 = (req.query.mal2 ?? '').trim();

  if (!mal1 || !mal2) return res.status(400).json({ error: 'Both usernames are required.' });
  if (mal1.length > 100 || mal2.length > 100) return res.status(400).json({ error: 'Username is too long.' });

  try {
    const [list1, list2] = await Promise.all([fetchMAL(mal1), fetchMAL(mal2)]);

    const map1 = new Map(list1.map(e => [e.malId, e]));
    const map2 = new Map(list2.map(e => [e.malId, e]));

    const only1 = [], only2 = [], statusDiffs = [], epDiffs = [];

    for (const e1 of list1) {
      const e2 = map2.get(e1.malId);
      if (!e2) {
        only1.push({ title: e1.title, malId: e1.malId, status: MAL_STATUS_LABEL[e1.status] ?? String(e1.status), progress: e1.progress, totalEps: e1.totalEps });
        continue;
      }
      if (e1.status !== e2.status) {
        statusDiffs.push({
          title: e1.title, malId: e1.malId,
          s1: MAL_STATUS_LABEL[e1.status] ?? String(e1.status),
          s2: MAL_STATUS_LABEL[e2.status] ?? String(e2.status),
          p1: e1.progress, p2: e2.progress,
          totalEps: e1.totalEps ?? e2.totalEps,
        });
      }
      if (e1.progress !== e2.progress) {
        epDiffs.push({
          title: e1.title, malId: e1.malId,
          p1: e1.progress, p2: e2.progress,
          totalEps: e1.totalEps ?? e2.totalEps,
          status: MAL_STATUS_LABEL[e1.status] ?? String(e1.status),
        });
      }
    }

    for (const e2 of list2) {
      if (!map1.has(e2.malId)) {
        only2.push({ title: e2.title, malId: e2.malId, status: MAL_STATUS_LABEL[e2.status] ?? String(e2.status), progress: e2.progress, totalEps: e2.totalEps });
      }
    }

    res.json({ t1: list1.length, t2: list2.length, only1, only2, statusDiffs, epDiffs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-list ────────────────────────────────────────────────────────────────

app.get('/api/compare/multi', async (req, res) => {
  let raw = req.query.list;
  if (!raw) return res.status(400).json({ error: 'At least 2 lists are required.' });
  if (!Array.isArray(raw)) raw = [raw];
  if (raw.length < 2) return res.status(400).json({ error: 'At least 2 lists are required.' });
  if (raw.length > 6) return res.status(400).json({ error: 'Maximum 6 lists allowed.' });

  const users = [];
  for (const item of raw) {
    const colon = item.indexOf(':');
    if (colon < 0) return res.status(400).json({ error: `Invalid format: ${item}` });
    const type     = item.slice(0, colon);
    const username = item.slice(colon + 1).trim();
    if (!['al', 'mal'].includes(type) || !username || username.length > 100)
      return res.status(400).json({ error: `Invalid list entry: ${item}` });
    users.push({ type, username });
  }

  try {
    const fetched = await Promise.all(
      users.map(u => u.type === 'al' ? fetchAniList(u.username) : fetchMAL(u.username))
    );

    const animeMap = new Map();
    const noMalId  = [];

    for (let i = 0; i < fetched.length; i++) {
      for (const e of fetched[i]) {
        if (!e.malId) {
          if (users[i].type === 'al')
            noMalId.push({ title: e.title, userIdx: i, status: AL_STATUS_LABEL[e.status] ?? e.status, progress: e.progress, totalEps: e.totalEps });
          continue;
        }
        if (!animeMap.has(e.malId)) {
          animeMap.set(e.malId, {
            title:     e.title,
            malId:     e.malId,
            anilistId: e.anilistId ?? null,
            entries:   new Array(users.length).fill(null),
          });
        }
        const row = animeMap.get(e.malId);
        if (e.anilistId && !row.anilistId) row.anilistId = e.anilistId;
        const statusLabel = users[i].type === 'al'
          ? (AL_STATUS_LABEL[e.status] ?? e.status)
          : (MAL_STATUS_LABEL[e.status] ?? String(e.status));
        row.entries[i] = { status: statusLabel, progress: e.progress, totalEps: e.totalEps ?? null };
      }
    }

    const rows = [];
    for (const row of animeMap.values()) {
      const present = row.entries.filter(Boolean);
      const isDiff  = present.length < users.length
        || new Set(present.map(e => e.status)).size   > 1
        || new Set(present.map(e => e.progress)).size > 1;
      rows.push({ ...row, isDiff });
    }

    rows.sort((a, b) => a.title.localeCompare(b.title));

    res.json({ users, totals: fetched.map(l => l.length), rows, noMalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
