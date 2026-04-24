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
  const res  = await fetch('https://graphql.anilist.co', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify({ query, variables: { userName: username } }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`AniList: ${json.errors[0]?.message ?? 'Unknown error'}`);

  const entries = [];
  for (const list of json.data.MediaListCollection.lists) {
    for (const e of list.entries) {
      entries.push({
        anilistId:  e.media.id,
        malId:      e.media.idMal,
        title:      e.media.title.english || e.media.title.romaji,
        totalEps:   e.media.episodes,
        status:     e.status,
        progress:   e.progress,
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
    const res  = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (res.status === 400 || res.status === 404) throw new Error(`MAL: user "${username}" not found or list is private`);
    if (!res.ok) throw new Error(`MAL: server returned ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
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

app.get('/api/compare', async (req, res) => {
  const alUser  = (req.query.al  ?? '').trim();
  const malUser = (req.query.mal ?? '').trim();
  if (!alUser || !malUser) return res.status(400).json({ error: 'Both usernames are required.' });

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
          title:     al.title,
          malId:     al.malId,
          alStatus:  AL_STATUS_LABEL[al.status]  ?? al.status,
          malStatus: MAL_STATUS_LABEL[mal.status] ?? String(mal.status),
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

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
