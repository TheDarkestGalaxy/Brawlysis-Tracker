// App State
let brawlers = [];
let rankedMaps = [];
let matches = JSON.parse(localStorage.getItem('brawl_matches')) || [];
let userProfile = JSON.parse(localStorage.getItem('brawl_profile')) || null;
let officialApiKey = localStorage.getItem('brawl_api_key') || '';
/** When set, official + community API requests go to this origin (trailing slash ok). Empty = this site’s origin (Vercel/Netlify). */
let apiProxyOrigin = (localStorage.getItem('brawl_proxy_origin') || '').trim().replace(/\/$/, '');
let isSyncing = false; // Sync lock to prevent race conditions

// Name normalization for cross-API matching
// Supercell API uses 'LARRY & LAWRIE', 'MR. P'
// BrawlAPI uses      'LARRY-LAWRIE',  'MR-P'
function normalizeBrawlerName(name) {
    if (!name) return "";
    return name.toUpperCase().trim()
        .replace(/[^A-Z0-9]/g, ''); // strip ALL non-alphanumeric
}

/** Brawlify CDN portrait when BrawlAPI has not listed the brawler yet (e.g. Sirius). */
function brawlifyBrawlerIconUrl(id, variant = 'borderless') {
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) return '';
    return `https://cdn.brawlify.com/brawlers/${variant}/${numId}.png`;
}

/** BrawlAPI icon when available, otherwise Supercell brawler id on Brawlify. */
function resolveBrawlerIconUrl(playerBrawlerOrId, globalBrawler) {
    if (globalBrawler) {
        return globalBrawler.imageUrl2 || globalBrawler.imageUrl || '';
    }
    const id = typeof playerBrawlerOrId === 'object' ? playerBrawlerOrId?.id : playerBrawlerOrId;
    return brawlifyBrawlerIconUrl(id);
}

/** Canonical `#TAG` form for comparing Supercell player tags. */
function normalizePlayerTag(tag) {
    if (!tag) return '';
    let t = String(tag).trim().toUpperCase();
    if (!t) return '';
    t = t.replace(/^#+/, '');
    return t ? `#${t}` : '';
}

function tagsEqual(a, b) {
    return normalizePlayerTag(a) === normalizePlayerTag(b);
}

function normalizeMapName(name) {
    let s = String(name || '');
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
    s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return s.toLowerCase().replace(/[_\-\.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Strip legacy "Mode - Map" prefixes so the same map is not split in analytics. */
function extractMapLabel(raw) {
    let s = String(raw || '').trim();
    if (!s) return 'Unknown Map';
    const dashIdx = s.lastIndexOf(' - ');
    if (dashIdx > 0) {
        const right = s.slice(dashIdx + 3).trim();
        if (right) s = right;
    }
    return s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

function mapNameKey(name) {
    return normalizeMapName(extractMapLabel(name));
}

function normalizeModeName(name) {
    return (name || '').toLowerCase().replace(/[\s\-\._]+/g, '');
}

const MODE_CANONICAL_LABELS = {
    gemgrab: 'Gem Grab',
    heist: 'Heist',
    bounty: 'Bounty',
    brawlball: 'Brawl Ball',
    hotzone: 'Hot Zone',
    knockout: 'Knockout',
    duels: 'Duels',
    wipeout: 'Wipeout',
    payload: 'Payload',
    basketbrawl: 'Basket Brawl',
    soloshowdown: 'Solo Showdown',
};

function canonicalMapName(raw) {
    return extractMapLabel(raw);
}

function canonicalModeName(raw, mappedMap) {
    if (mappedMap?.gameMode?.name) {
        return mappedMap.gameMode.name.replace(/-/g, ' ').trim();
    }
    const norm = normalizeModeName(raw);
    if (MODE_CANONICAL_LABELS[norm]) return MODE_CANONICAL_LABELS[norm];
    if (!norm || norm === 'ranked') return '';
    const spaced = String(raw || '').replace(/-/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    return spaced || String(raw || '').trim();
}

function findRankedMapEntry(mapRaw) {
    const norm = mapNameKey(mapRaw);
    return rankedMaps.find(m => mapNameKey(m.name) === norm) || null;
}

/** Group brawler stats even when API rows use id 0 before BrawlAPI loads. */
function brawlerStatsKey(m) {
    if (m.brawlerId && m.brawlerId !== 0) return `id:${m.brawlerId}`;
    return `name:${normalizeBrawlerName(m.brawlerName)}`;
}

/** Per-map analytics: ranked maps are unique by name (mode labels vary in stored data). */
function matchesAnalyticsMap(m, selected) {
    if (!m || !selected) return false;
    return mapNameKey(m.mapName) === mapNameKey(selected.mapName);
}

function isMapInRankedPool(mapName) {
    const norm = mapNameKey(mapName);
    return RANKED_POOL.some(rp => mapNameKey(rp) === norm);
}

/** Competitive Ranked (solo queue, team queue, club league power matches). */
const COMPETITIVE_RANKED_BATTLE_TYPES = new Set(['soloranked', 'teamranked', 'competitive']);
/** Trophy Road ladder — Supercell API type string is misleadingly `"ranked"`. */
const TROPHY_ROAD_BATTLE_TYPE = 'ranked';
const NON_RANKED_BATTLE_TYPES = new Set(['friendly', 'practice', 'tournament', 'challenge', 'casual']);

function hasTrophyRoadSignal(m) {
    const bt = String(m.battleType || '').toLowerCase();
    if (bt === TROPHY_ROAD_BATTLE_TYPE) return true;
    const tc = m.trophyChange;
    return typeof tc === 'number' && tc !== 0;
}

/** Supercell battle.type — competitive Ranked only, not Trophy Road ladder. */
function isBattleRanked(battle) {
    if (!battle) return false;
    const battleType = (battle.type || '').toLowerCase();
    if (COMPETITIVE_RANKED_BATTLE_TYPES.has(battleType)) return true;
    if (battleType === TROPHY_ROAD_BATTLE_TYPE) return false;
    if (NON_RANKED_BATTLE_TYPES.has(battleType)) return false;
    return false;
}

/** Battle log rows use Supercell battleTime as id (e.g. 20260407T123456.000Z). */
function isApiSyncedMatch(m) {
    if (!m) return false;
    if (m.source === 'api') return true;
    return /^\d{8}T\d{6}/.test(String(m.id || ''));
}

/** Classify a stored API battle row (competitive Ranked types only). */
function classifyApiStoredMatch(m) {
    const bt = String(m.battleType || '').toLowerCase();
    if (COMPETITIVE_RANKED_BATTLE_TYPES.has(bt)) return true;
    if (bt === TROPHY_ROAD_BATTLE_TYPE) return false;
    if (NON_RANKED_BATTLE_TYPES.has(bt)) return false;
    if (m.isRanked === false) return false;
    if (hasTrophyRoadSignal(m)) return false;
    // Legacy API rows missing battleType — include unless trophy signals above
    if (!bt) return true;
    return false;
}

/** Normalize map/mode strings so the same ranked map is not split across analytics rows. */
function repairStoredMatchMetadata() {
    let changed = 0;
    matches.forEach(m => {
        const canonMap = canonicalMapName(m.mapName);
        if (m.mapName !== canonMap) {
            m.mapName = canonMap;
            changed++;
        }
        const mappedMap = findRankedMapEntry(canonMap);
        const canonMode = canonicalModeName(m.modeName, mappedMap);
        if (canonMode && m.modeName !== canonMode) {
            m.modeName = canonMode;
            changed++;
        }
    });
    return changed;
}

/** Re-tag all API-synced rows; fixes legacy data missing source / mis-tagged by old migrations. */
function repairStoredMatchRankFlags() {
    let changed = 0;
    matches.forEach(m => {
        if (!isApiSyncedMatch(m)) return;
        if (m.source !== 'api') {
            m.source = 'api';
            changed++;
        }
        const ranked = classifyApiStoredMatch(m);
        if (m.isRanked !== ranked) {
            m.isRanked = ranked;
            changed++;
        }
    });
    if (changed > 0) {
        rebuildMatchIdIndex();
        localStorage.setItem('brawl_matches', JSON.stringify(matches));
    }
    return changed;
}

/** Whether a stored match counts toward ranked stats (dashboard win rate, analytics). */
function isRankedMatch(m) {
    if (!m) return false;
    if (isApiSyncedMatch(m)) return classifyApiStoredMatch(m);
    if (m.isRanked === false) return false;
    return true;
}

const MATCH_LIST_PAGE_SIZE = 50;
/** Ranked log never renders more than this many rows (keeps the list fast). */
const RANKED_LOG_MAX_MATCHES = 50;
let matchListVisibleCount = MATCH_LIST_PAGE_SIZE;
let matchIdIndex = new Map();

function rebuildMatchIdIndex() {
    matchIdIndex.clear();
    matches.forEach((m, i) => matchIdIndex.set(String(m.id), i));
}

/** One-time fix for matches mis-tagged before `ranked` battle type was recognized. */
function migrateLegacyRankedFlags() {
    let changed = 0;
    if (!localStorage.getItem('brawl_ranked_type_fix_v1')) {
        matches.forEach(m => {
            if (m.source !== 'api' || m.isRanked !== false) return;
            const bt = String(m.battleType || '').toLowerCase();
            if (bt === 'ranked' || bt === 'soloranked' || bt === 'teamranked' || bt === 'competitive') {
                m.isRanked = true;
                changed++;
            }
        });
        localStorage.setItem('brawl_ranked_type_fix_v1', '1');
    }
    if (!localStorage.getItem('brawl_ranked_type_fix_v2')) {
        matches.forEach(m => {
            if (m.source !== 'api' || m.isRanked !== false || m.battleType) return;
            m.isRanked = true;
            changed++;
        });
        localStorage.setItem('brawl_ranked_type_fix_v2', '1');
    }
    // Undo v2: re-tag API matches strictly from battle type / trophy delta
    if (!localStorage.getItem('brawl_ranked_type_fix_v3')) {
        matches.forEach(m => {
            if (m.source !== 'api') return;
            const ranked = classifyApiStoredMatch(m);
            if (m.isRanked !== ranked) {
                m.isRanked = ranked;
                changed++;
            }
        });
        localStorage.setItem('brawl_ranked_type_fix_v3', '1');
    }
    // v4: legacy rows synced before `source: 'api'` (battleTime id only) — strict reclassify
    if (!localStorage.getItem('brawl_ranked_type_fix_v4')) {
        changed += repairStoredMatchRankFlags();
        localStorage.setItem('brawl_ranked_type_fix_v4', '1');
    }
    // v5: ranked API rows with trophyChange were wrongly excluded from analytics
    if (!localStorage.getItem('brawl_ranked_type_fix_v5')) {
        changed += repairStoredMatchRankFlags();
        localStorage.setItem('brawl_ranked_type_fix_v5', '1');
    }
    // v6: API type "ranked" is Trophy Road — only soloRanked/teamRanked are competitive
    if (!localStorage.getItem('brawl_ranked_type_fix_v6')) {
        changed += repairStoredMatchRankFlags();
        localStorage.setItem('brawl_ranked_type_fix_v6', '1');
    }
    // v7: include legacy ranked rows missing battleType; unify map/mode labels for analytics
    if (!localStorage.getItem('brawl_ranked_type_fix_v7')) {
        changed += repairStoredMatchRankFlags();
        changed += repairStoredMatchMetadata();
        localStorage.setItem('brawl_ranked_type_fix_v7', '1');
    }
    // v8: fix map label splitting (e.g. "Knockout - Flowing Springs") and relax legacy API rank tags
    if (!localStorage.getItem('brawl_ranked_type_fix_v8')) {
        changed += repairStoredMatchRankFlags();
        changed += repairStoredMatchMetadata();
        localStorage.setItem('brawl_ranked_type_fix_v8', '1');
    }
    if (changed > 0) {
        rebuildMatchIdIndex();
        localStorage.setItem('brawl_matches', JSON.stringify(matches));
    }
}

/** Enemy brawler names from battlelog (all opposing teams / other showdown players). */
function extractOpponentBrawlersFromBattle(item, userTag) {
    const names = [];
    const add = (n) => {
        if (n && typeof n === 'string') names.push(n.toUpperCase().trim());
    };
    const b = item.battle;
    if (!b) return [];
    if (Array.isArray(b.teams)) {
        let myTeamIdx = -1;
        for (let i = 0; i < b.teams.length; i++) {
            const team = b.teams[i];
            if (!Array.isArray(team)) continue;
            if (team.some(p => p && tagsEqual(p.tag, userTag))) {
                myTeamIdx = i;
                break;
            }
        }
        for (let i = 0; i < b.teams.length; i++) {
            if (i === myTeamIdx) continue;
            const team = b.teams[i];
            if (!Array.isArray(team)) continue;
            for (const p of team) {
                if (p && p.brawler && p.brawler.name) add(p.brawler.name);
            }
        }
    } else if (Array.isArray(b.players)) {
        for (const p of b.players) {
            if (p && !tagsEqual(p.tag, userTag) && p.brawler && p.brawler.name) add(p.brawler.name);
        }
    }
    return [...new Set(names)];
}

function opponentKeyFromRawName(rawUpper) {
    const gb = brawlers.find(x => normalizeBrawlerName(x.name) === normalizeBrawlerName(rawUpper));
    if (gb) return `id:${gb.id}`;
    return `n:${normalizeBrawlerName(rawUpper)}`;
}

function brawlerDisplayFromKey(key) {
    if (key.startsWith('id:')) {
        const id = Number(key.slice(3));
        const gb = brawlers.find(x => Number(x.id) === id);
        return {
            name: gb ? gb.name : `Brawler ${id}`,
            icon: gb ? (gb.imageUrl || gb.imageUrl2 || '') : brawlifyBrawlerIconUrl(id)
        };
    }
    const norm = key.slice(2);
    const gb = brawlers.find(x => normalizeBrawlerName(x.name) === norm);
    const displayName = gb ? gb.name : norm;
    const icon = gb
        ? (gb.imageUrl || gb.imageUrl2 || '')
        : `https://media.brawltime.ninja/brawlers/${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}/avatar.png`;
    return { name: displayName, icon };
}

const MIN_MATCHUP_GAMES = 2;

function populateMatchupTargetList(rankedMatches) {
    const listEl = document.getElementById('matchup-target-list');
    if (!listEl) return;
    const prev = JSON.parse(localStorage.getItem('matchup_target_snapshot') || '[]');
    const names = new Set(prev);
    rankedMatches.forEach(m => {
        if (!Array.isArray(m.opponentBrawlers)) return;
        m.opponentBrawlers.forEach(n => names.add(String(n || '').toUpperCase().trim()));
    });
    listEl.innerHTML = '';
    [...names]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .forEach(name => {
            const opt = document.createElement('option');
            opt.value = brawlerDisplayFromKey(opponentKeyFromRawName(name)).name;
            listEl.appendChild(opt);
        });
    localStorage.setItem('matchup_target_snapshot', JSON.stringify([...names].filter(Boolean).slice(0, 400)));
}

function renderMatchupTable(rankedMatches) {
    const wrap = document.getElementById('matchup-table-container');
    const input = document.getElementById('matchup-target-input');
    if (!wrap || !input) return;
    const targetRaw = input.value.trim();
    if (!targetRaw) {
        wrap.innerHTML = '<p class="empty-state" style="margin:0;">Type an enemy brawler to see your best counters.</p>';
        return;
    }
    const targetKey = opponentKeyFromRawName(targetRaw);
    const targetNorm = targetKey.startsWith('id:')
        ? normalizeBrawlerName(brawlerDisplayFromKey(targetKey).name)
        : targetKey.slice(2);

    const vsTargetMatches = rankedMatches.filter(m => {
        if (!Array.isArray(m.opponentBrawlers) || m.opponentBrawlers.length === 0) return false;
        return m.opponentBrawlers.some(opp => normalizeBrawlerName(opp) === targetNorm);
    });

    const agg = {};
    vsTargetMatches.forEach(m => {
        if (m.result !== 'win' && m.result !== 'loss') return;
        const myKey = (m.brawlerId && Number(m.brawlerId) > 0)
            ? `id:${m.brawlerId}`
            : `n:${normalizeBrawlerName(m.brawlerName)}`;
        if (!agg[myKey]) agg[myKey] = { wins: 0, losses: 0 };
        if (m.result === 'win') agg[myKey].wins++;
        else agg[myKey].losses++;
    });

    const rows = Object.entries(agg)
        .map(([k, s]) => {
            const total = s.wins + s.losses;
            const disp = brawlerDisplayFromKey(k);
            return { key: k, ...s, total, wr: total ? Math.round((s.wins / total) * 100) : 0, ...disp };
        })
        .filter(r => r.total >= MIN_MATCHUP_GAMES)
        .sort((a, b) => b.wr - a.wr || b.total - a.total);

    if (rows.length === 0) {
        wrap.innerHTML = `<p class="empty-state" style="margin:0;">Not enough data vs <strong>${brawlerDisplayFromKey(targetKey).name}</strong>. Need at least ${MIN_MATCHUP_GAMES} win/loss games per candidate brawler.</p>`;
        return;
    }

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let html = `<table class="matchup-table"><thead><tr><th>Your counter pick</th><th>Record vs ${esc(brawlerDisplayFromKey(targetKey).name)}</th><th>Win rate</th></tr></thead><tbody>`;
    rows.forEach(r => {
        const badgeColor = r.wr >= 50 ? 'var(--color-win)' : 'var(--color-loss)';
        const bg = r.wr >= 50 ? 'rgba(76, 219, 143, 0.1)' : 'rgba(235, 87, 87, 0.1)';
        html += `<tr>
            <td><div class="matchup-cell-brawler"><img src="${r.icon || 'https://via.placeholder.com/36'}" alt="" class="brawler-avatar" style="width:36px;height:36px;" onerror="this.src='https://via.placeholder.com/36'"><span>${esc(r.name)}</span></div></td>
            <td>${r.wins}W — ${r.losses}L <span style="color:var(--text-muted);font-size:0.8rem;">(${r.total})</span></td>
            <td><span class="win-rate-badge" style="background-color:${bg};color:${badgeColor}">${r.wr}%</span></td>
        </tr>`;
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
}

// Browser IP Detection Helper
async function getBrowserIP() {
    try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        return data.ip || 'Unknown';
    } catch (err) {
        return 'Detection Failed (Check VPN/CORS)';
    }
}

/** Base URL for /api/official and /api/* proxies (never call Supercell from the browser — they do not allow CORS). */
function getProxyBaseUrl() {
    if (window.location.protocol === 'file:') {
        return 'http://127.0.0.1:8000';
    }
    if (apiProxyOrigin) return apiProxyOrigin;
    return window.location.origin;
}

function isNetworkOrCorsFailure(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    if (err.name === 'TypeError') return true;
    return /Failed to fetch|NetworkError|Load failed|aborted|timeout/i.test(String(err.message || ''));
}

/** IPv4/IPv6 from Supercell error text (e.g. "from IP 1.2.3.4" or "Invalid IP: …"). */
function extractIpFromApiMessage(msg) {
    if (!msg || typeof msg !== 'string') return null;
    let m = msg.match(/Invalid IP:?\s*([0-9a-fA-F:\.]+)/i);
    if (m) return m[1].trim();
    m = msg.match(/from IP\s+([0-9a-fA-F:\.]+)/i);
    if (m) return m[1].trim();
    return null;
}

function keyIpWhitelistHint(message) {
    const ip = extractIpFromApiMessage(String(message || ''));
    if (ip) {
        return `Whitelist ${ip} for this key at developer.brawlstars.com (server IP Supercell sees — not your home Wi‑Fi).`;
    }
    return 'Allowed IP list for this key at developer.brawlstars.com must include the proxy server IP Supercell sees.';
}

const OFFICIAL_API_FETCH_MS = 30000;
const BRAWL_API_FETCH_MS = 6000;

// Official Supercell API — always via same-origin or configured proxy (server forwards Authorization).
async function smartBrawlFetch(endpoint) {
    const headers = { 'Authorization': `Bearer ${officialApiKey}` };
    const base = getProxyBaseUrl();
    const url = `${base}/api/official${endpoint}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OFFICIAL_API_FETCH_MS);
    const opts = { headers, cache: 'no-store', signal: ctrl.signal };
    try {
        if (window.location.protocol === 'file:') {
            try {
                return await fetch(url, opts);
            } catch (err) {
                console.warn('[Network] Local proxy unreachable:', err);
                throw err;
            }
        }
        return await fetch(url, opts);
    } finally {
        clearTimeout(timer);
    }
}

/** BrawlAPI (brawlers/maps) — try proxy first, then public API if the host has no rewrite. */
async function fetchBrawlApiJson(path) {
    const candidates = [];
    if (window.location.protocol === 'file:') {
        candidates.push('http://127.0.0.1:8000');
    }
    const proxyBase = getProxyBaseUrl();
    if (!candidates.includes(proxyBase)) candidates.push(proxyBase);

    const tried = new Set();
    for (const base of candidates) {
        if (tried.has(base)) continue;
        tried.add(base);
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), BRAWL_API_FETCH_MS);
            try {
                const res = await fetch(`${base}/api${path}`, { cache: 'no-store', signal: ctrl.signal });
                const ct = res.headers.get('content-type') || '';
                if (res.ok && ct.includes('application/json')) {
                    return await res.json();
                }
            } finally {
                clearTimeout(timer);
            }
        } catch (_) { /* try next */ }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRAWL_API_FETCH_MS);
    try {
        const res = await fetch(`https://api.brawlapi.com/v1${path}`, { cache: 'no-store', signal: ctrl.signal });
        if (!res.ok) throw new Error(`BrawlAPI ${path} HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function strategyStorageKey(mapKey) {
    return `brawl_strategy_v1:${mapKey}`;
}

function strategyMapKeyFor(mapObj) {
    const mode = mapObj?.gameMode?.name || 'mode';
    const map = mapObj?.name || 'map';
    return `${mode}::${map}`;
}

function strategyMapImageUrl(mapObj) {
    if (!mapObj) return '';
    if (mapObj.imageUrl2) return mapObj.imageUrl2;
    if (mapObj.imageUrl) return mapObj.imageUrl;
    const slug = String(mapObj.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `https://cdn.brawlify.com/maps/regular/${slug}.png`;
}

let strategyCanvasSize = { width: 0, height: 0, dpr: 1 };
let strategyLabels = [];
let strategyDraggingLabelIndex = -1;
let strategyDragOffset = { x: 0, y: 0 };
let strategyInkCanvas = null;
let strategyInkCtx = null;
let strategyEditorEl = null;
let strategyUndoStack = [];
let strategyUndoIndex = -1;
let strategySuspendUndoPush = false;
const STRATEGY_TEXT_SIZE_MAP = { sm: 12, md: 14, lg: 17 };

function strategyCurrentFontSize() {
    const sel = document.getElementById('strategy-text-size-select');
    const key = sel ? sel.value : 'md';
    return STRATEGY_TEXT_SIZE_MAP[key] || 18;
}

function strategyEnsureInkCanvas() {
    if (!strategyInkCanvas) {
        strategyInkCanvas = document.createElement('canvas');
    }
    if (!strategyInkCtx && strategyInkCanvas) {
        strategyInkCtx = strategyInkCanvas.getContext('2d');
    }
}

function strategySnapshot() {
    return {
        ink: strategyInkCanvas ? strategyInkCanvas.toDataURL('image/png') : '',
        labels: JSON.parse(JSON.stringify(strategyLabels || []))
    };
}

function strategyStateSignature(snap) {
    return `${snap.ink.length}:${JSON.stringify(snap.labels)}`;
}

function strategyPushUndoSnapshot() {
    if (strategySuspendUndoPush) return;
    const snap = strategySnapshot();
    const sig = strategyStateSignature(snap);
    if (strategyUndoIndex >= 0) {
        const currentSig = strategyStateSignature(strategyUndoStack[strategyUndoIndex]);
        if (sig === currentSig) return;
    }
    if (strategyUndoIndex < strategyUndoStack.length - 1) {
        strategyUndoStack = strategyUndoStack.slice(0, strategyUndoIndex + 1);
    }
    strategyUndoStack.push(snap);
    if (strategyUndoStack.length > 60) strategyUndoStack.shift();
    strategyUndoIndex = strategyUndoStack.length - 1;
}

function strategyResetUndoHistory() {
    strategyUndoStack = [];
    strategyUndoIndex = -1;
    strategyPushUndoSnapshot();
}

function strategyApplySnapshot(snap, persist = true) {
    if (!snap || !strategyInkCtx) return;
    strategySuspendUndoPush = true;
    strategyLabels = JSON.parse(JSON.stringify(snap.labels || []));
    strategyInkCtx.clearRect(0, 0, strategyCanvasSize.width, strategyCanvasSize.height);
    if (snap.ink) {
        const img = new Image();
        img.onload = () => {
            strategyInkCtx.drawImage(img, 0, 0, strategyCanvasSize.width, strategyCanvasSize.height);
            strategyComposite();
            if (persist) strategySave(false);
            strategySuspendUndoPush = false;
        };
        img.onerror = () => {
            strategyComposite();
            if (persist) strategySave(false);
            strategySuspendUndoPush = false;
        };
        img.src = snap.ink;
        return;
    }
    strategyComposite();
    if (persist) strategySave(false);
    strategySuspendUndoPush = false;
}

function strategyUndo() {
    if (strategyUndoIndex <= 0) return;
    strategyUndoIndex -= 1;
    const snap = strategyUndoStack[strategyUndoIndex];
    strategyApplySnapshot(snap, true);
}

function strategyResizeCanvas() {
    if (!strategyCanvas || !strategyMapImage) return;
    const rect = strategyMapImage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    strategyEnsureInkCanvas();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    strategyCanvasSize = { width: Math.round(rect.width), height: Math.round(rect.height), dpr };

    strategyCanvas.width = Math.round(rect.width * dpr);
    strategyCanvas.height = Math.round(rect.height * dpr);
    strategyInkCanvas.width = Math.round(rect.width * dpr);
    strategyInkCanvas.height = Math.round(rect.height * dpr);

    const vctx = strategyCanvas.getContext('2d');
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    strategyInkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    strategyComposite();
}

function strategyComposite() {
    if (!strategyCanvas) return;
    const ctx = strategyCanvas.getContext('2d');
    const { width, height } = strategyCanvasSize;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    if (strategyInkCanvas) {
        ctx.drawImage(strategyInkCanvas, 0, 0, width, height);
    }
    strategyDrawLabels(ctx);
}

function strategyDrawLabels(ctx) {
    if (!ctx || !Array.isArray(strategyLabels)) return;
    ctx.save();
    ctx.textBaseline = 'top';
    strategyLabels.forEach(lbl => {
        if (!lbl || !lbl.text) return;
        const txt = String(lbl.text);
        const fontSize = Number(lbl.size) || 18;
        ctx.font = `700 ${fontSize}px Outfit, sans-serif`;
        const textWidth = ctx.measureText(txt).width;
        const padX = 5;
        const padY = Math.max(1, Math.round(fontSize * 0.1));
        const boxW = textWidth + padX * 2;
        const boxH = fontSize + padY * 2;

        // High-contrast chip to keep labels readable on any map texture.
        ctx.fillStyle = 'rgba(5, 8, 14, 0.82)';
        ctx.strokeStyle = lbl.color || '#ff4d4d';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const r = 3;
        const x = lbl.x - padX;
        const y = lbl.y - padY;
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + boxW - r, y);
        ctx.quadraticCurveTo(x + boxW, y, x + boxW, y + r);
        ctx.lineTo(x + boxW, y + boxH - r);
        ctx.quadraticCurveTo(x + boxW, y + boxH, x + boxW - r, y + boxH);
        ctx.lineTo(x + r, y + boxH);
        ctx.quadraticCurveTo(x, y + boxH, x, y + boxH - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#f8fafc';
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 1;
        ctx.fillText(txt, lbl.x, lbl.y);
    });
    ctx.restore();
}

function strategyCloseInlineEditor(save) {
    if (!strategyEditorEl) return;
    const el = strategyEditorEl;
    const text = el.value.trim();
    const x = Number(el.dataset.x);
    const y = Number(el.dataset.y);
    const color = String(el.dataset.color || '#ff4d4d');
    const size = Number(el.dataset.size) || strategyCurrentFontSize();
    el.remove();
    strategyEditorEl = null;
    if (save && text) {
        strategyLabels.push({ text, x, y, color, size });
        strategyComposite();
        strategySave();
        strategyPushUndoSnapshot();
    }
}

function strategyOpenInlineEditor(pt, color) {
    const wrap = document.querySelector('.strategy-board-wrap');
    if (!wrap) return;
    strategyCloseInlineEditor(false);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'strategy-inline-editor';
    input.placeholder = 'Type label and press Enter';
    input.style.left = `${Math.max(6, Math.round(pt.x))}px`;
    input.style.top = `${Math.max(6, Math.round(pt.y))}px`;
    input.dataset.x = String(Math.max(6, Math.round(pt.x)));
    input.dataset.y = String(Math.max(6, Math.round(pt.y)));
    input.dataset.color = color || '#ff4d4d';
    input.dataset.size = String(strategyCurrentFontSize());
    // Keep the temporary input compact; label size is applied after save.
    input.style.fontSize = '13px';
    input.style.minWidth = '110px';
    input.style.maxWidth = '180px';
    wrap.appendChild(input);
    strategyEditorEl = input;
    input.focus();
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            strategyCloseInlineEditor(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            strategyCloseInlineEditor(false);
        }
    });
    input.addEventListener('blur', () => strategyCloseInlineEditor(true));
}

function strategyLabelHitTest(pt) {
    if (!strategyCanvas) return -1;
    const ctx = strategyCanvas.getContext('2d');
    ctx.save();
    for (let i = strategyLabels.length - 1; i >= 0; i--) {
        const lbl = strategyLabels[i];
        if (!lbl || !lbl.text) continue;
        const fontSize = Number(lbl.size) || 18;
        ctx.font = `700 ${fontSize}px Outfit, sans-serif`;
        const w = ctx.measureText(lbl.text).width;
        const h = fontSize + 8;
        if (pt.x >= lbl.x - 4 && pt.x <= lbl.x + w + 4 && pt.y >= lbl.y - 4 && pt.y <= lbl.y + h + 4) {
            ctx.restore();
            return i;
        }
    }
    ctx.restore();
    return -1;
}

function strategyLoad() {
    if (!strategyCanvas || !strategyMapKey) return;
    strategyEnsureInkCanvas();
    const data = localStorage.getItem(strategyStorageKey(strategyMapKey));
    const clearAndComposite = () => {
        strategyLabels = [];
        if (strategyInkCtx) strategyInkCtx.clearRect(0, 0, strategyCanvasSize.width, strategyCanvasSize.height);
        strategyComposite();
    };
    if (!data) {
        clearAndComposite();
        strategyResetUndoHistory();
        return;
    }
    let inkDataUrl = '';
    let labels = [];
    try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object') {
            inkDataUrl = typeof parsed.ink === 'string' ? parsed.ink : '';
            labels = Array.isArray(parsed.labels) ? parsed.labels : [];
        } else if (typeof parsed === 'string') {
            inkDataUrl = parsed;
        }
    } catch {
        inkDataUrl = data;
    }
    strategyLabels = labels.map(l => {
        const rawSize = Number(l.size);
        // Auto-migrate older larger labels to the new compact sizing.
        const migratedSize = Number.isFinite(rawSize)
            ? Math.max(10, Math.min(17, Math.round(rawSize * 0.78)))
            : 14;
        return {
            text: String(l.text || ''),
            x: Number(l.x) || 20,
            y: Number(l.y) || 20,
            color: String(l.color || '#ff4d4d'),
            size: migratedSize
        };
    }).filter(l => l.text.trim().length > 0);
    strategyInkCtx.clearRect(0, 0, strategyCanvasSize.width, strategyCanvasSize.height);
    if (!inkDataUrl) {
        strategyComposite();
        strategyResetUndoHistory();
        return;
    }
    const img = new Image();
    img.onload = () => {
        strategyInkCtx.drawImage(img, 0, 0, strategyCanvasSize.width, strategyCanvasSize.height);
        strategyComposite();
        strategyResetUndoHistory();
    };
    img.onerror = () => {
        strategyComposite();
        strategyResetUndoHistory();
    };
    img.src = inkDataUrl;
}

function strategySave(showToast = false) {
    if (!strategyCanvas || !strategyMapKey) return;
    const payload = {
        ink: strategyInkCanvas ? strategyInkCanvas.toDataURL('image/png') : '',
        labels: strategyLabels
    };
    localStorage.setItem(strategyStorageKey(strategyMapKey), JSON.stringify(payload));
    if (showToast) {
        const msg = document.getElementById('strategy-save-msg');
        if (msg) {
            msg.style.display = 'block';
            setTimeout(() => { msg.style.display = 'none'; }, 1600);
        }
    }
}

function strategyDrawArrow(from, to, color) {
    if (!strategyInkCtx) return;
    const ctx = strategyInkCtx;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) return;
    const head = Math.max(10, Math.min(18, len * 0.18));
    const ang = Math.atan2(dy, dx);
    const tip = { x: to.x, y: to.y };
    const end = { x: tip.x - head * Math.cos(ang), y: tip.y - head * Math.sin(ang) };
    ctx.save();
    // outline under-stroke for contrast
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    // main stroke
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    // arrow head with outline
    const p1 = { x: tip.x - head * Math.cos(ang - Math.PI / 6), y: tip.y - head * Math.sin(ang - Math.PI / 6) };
    const p2 = { x: tip.x - head * Math.cos(ang + Math.PI / 6), y: tip.y - head * Math.sin(ang + Math.PI / 6) };
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
}

function strategyCanvasPoint(ev) {
    const rect = strategyCanvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function populateStrategyMaps() {
    if (!strategyMapSelect) return;
    strategyMapSelect.innerHTML = '';
    rankedMaps
        .slice()
        .sort((a, b) => `${a.gameMode?.name || ''} ${a.name}`.localeCompare(`${b.gameMode?.name || ''} ${b.name}`))
        .forEach(m => {
            const opt = document.createElement('option');
            opt.value = strategyMapKeyFor(m);
            opt.textContent = `${(m.gameMode?.name || '').replace(/-/g, ' ')} - ${(m.name || '').replace(/-/g, ' ')}`;
            opt.dataset.img = strategyMapImageUrl(m);
            strategyMapSelect.appendChild(opt);
        });
    if (strategyMapSelect.options.length && !strategyMapSelect.value) strategyMapSelect.selectedIndex = 0;
    if (strategyMapSelect.options.length) {
        strategyMapKey = strategyMapSelect.value;
        strategyMapImage.src = strategyMapSelect.selectedOptions[0].dataset.img || '';
    }
}


// Global Game Mode Icon Safety Map (using official Brawlify IDs)
const MODE_ICON_MAP = {
    'GEM-GRAB': '48000000', 'GEM_GRAB': '48000000', 'GEMGRAB': '48000000',
    'HEIST': '48000002',
    'BOUNTY': '48000003',
    'BRAWL-BALL': '48000005', 'BRAWL_BALL': '48000005', 'BRAWLBALL': '48000005',
    'HOT-ZONE': '48000017', 'HOT_ZONE': '48000017', 'HOTZONE': '48000017',
    'KNOCKOUT': '48000020',
    'DUELS': '48000024',
    'WIPEOUT': '48000025',
    'PAYLOAD': '48000026',
    'BASKET-BRAWL': '48000022', 'BASKET_BRAWL': '48000022',
    'SOLO-SHOWDOWN': '48000006', 'SOLO_SHOWDOWN': '48000006'
};

// The active pool of Ranked Maps (Edit this array when ranked seasons change)
const defaultRankedPool = [
    // Brawl Ball
    "Beach Ball", "Center Stage", "Pinball Dreams", "Sneaky Fields", "Spiraling Out", "Triple Dribble",
    // Gem Grab
    "Double Swoosh", "Gem Fort", "Hard Rock Mine", "Undermine",
    // Heist
    "Bridge Too Far", "Hot Potato", "Kaboom Canyon", "Safe Zone",
    // Hot Zone
    "Dueling Beetles", "Open Business", "Parallel Plays", "Ring of Fire",
    // Knockout
    "Belle's Rock", "Flaring Phoenix", "New Horizons", "Out in the Open",
    // Bounty
    "Dry Season", "Hideout", "Layer Cake", "Shooting Star"
];

let RANKED_POOL = JSON.parse(localStorage.getItem('ranked_maps_v2')) || defaultRankedPool;

// Form State
let selectedBrawler = null;
let selectedMode = null;

// Analytics State
let playedMaps = [];
let selectedAnalyticsMap = null;
let activeAnalyticsTab = 'map'; // 'map' | 'overall' | 'matchups'
let activeMatchTab = 'ranked'; // 'ranked' or 'trophy'
let strategyMapKey = '';
let strategyDrawing = false;
let strategyStart = null;
let strategyTool = 'arrow';

// DOM Elements
const navLinks = document.querySelectorAll('.nav-links li');
const views = document.querySelectorAll('.view');
const modalOverlay = document.getElementById('add-match-modal');
const addMatchBtn = document.getElementById('add-match-btn');
const closeBtns = document.querySelectorAll('.close-modal');
const matchForm = document.getElementById('add-match-form');
const clearAllBtn = document.getElementById('clear-all-btn');

// Dropdown Elements
const brawlerDropdown = document.getElementById('brawler-dropdown');
const brawlerSearch = document.getElementById('brawler-search');
const brawlerOptions = document.getElementById('brawler-options');
const brawlerIcon = document.getElementById('brawler-selected-icon');

const modeDropdown = document.getElementById('mode-dropdown');
const modeSearch = document.getElementById('mode-search');
const modeOptions = document.getElementById('mode-options');
const modeIcon = document.getElementById('mode-selected-icon');

// Settings Elements
const mapPoolInput = document.getElementById('map-pool-input');
const savePoolBtn = document.getElementById('save-pool-btn');
const savePoolMsg = document.getElementById('save-pool-msg');

// Profile Elements
const linkAccountModal = document.getElementById('link-account-modal');
const openLinkModalBtn = document.getElementById('open-link-modal-btn');
const closeLinkBtn = document.getElementById('close-link-btn');
const editProfileBtn = document.getElementById('edit-profile-btn');
const linkAccountForm = document.getElementById('link-account-form');
const profileUnlinked = document.getElementById('profile-unlinked');
const profileLinked = document.getElementById('profile-linked');
const profileUsername = document.getElementById('profile-username');
const profileTag = document.getElementById('profile-tag');
const profileAvatar = document.getElementById('profile-avatar');
const profileLiveStats = document.getElementById('profile-live-stats');
const profileTrophies = document.getElementById('profile-trophies');
const profileHighest = document.getElementById('profile-highest');
const profile3v3 = document.getElementById('profile-3v3');
const profileClub = document.getElementById('profile-club');
const apiStatusBadge = document.getElementById('api-status-badge');
const syncIndicator = document.getElementById('sync-indicator');

// Collection Elements
const collectionGrid = document.getElementById('collection-grid');
const collectionCount = document.getElementById('collection-count');

// Settings Elements - Expanded
const apiTokenInput = document.getElementById('api-token-input');
const apiProxyInput = document.getElementById('api-proxy-input');
const saveApiBtn = document.getElementById('save-api-btn');
const saveApiMsg = document.getElementById('save-api-msg');

// Map Analytics Elements
const analyticsMapDropdown = document.getElementById('analytics-map-dropdown');
const analyticsMapSearch = document.getElementById('analytics-map-search');
const analyticsMapOptions = document.getElementById('analytics-map-options');
const analyticsMapIcon = document.getElementById('analytics-map-selected-icon');
const analyticsBrawlersList = document.getElementById('analytics-brawlers-list');
const strategyMapSelect = document.getElementById('strategy-map-select');
const strategyMapImage = document.getElementById('strategy-map-image');
const strategyCanvas = document.getElementById('strategy-canvas');

// Initialization
async function init() {
    rebuildMatchIdIndex();
    migrateLegacyRankedFlags();
    repairStoredMatchRankFlags();
    repairStoredMatchMetadata();
    updateProfileCard();
    renderMatches();
    updateDashboard();
    
    // Populate Settings Textarea
    mapPoolInput.value = RANKED_POOL.join('\n');
    apiTokenInput.value = officialApiKey;
    if (apiProxyInput) apiProxyInput.value = localStorage.getItem('brawl_proxy_origin') || '';
    
    setupDropdowns();
    initGuideStrategy();
    fetchGameData();
    const savedCollection = JSON.parse(localStorage.getItem('brawl_collection_data')) || [];
    if (savedCollection.length > 0) renderCollection(savedCollection);
    
    // Initial fetch logs & start auto-sync loop (45s interval for reliability)
    if (officialApiKey) {
        syncBattlelog();
        fetchLiveProfile(); // Also refresh profile on load
    }
    setInterval(() => {
        if (officialApiKey) syncBattlelog();
    }, 45000); // Poll every 45 seconds for matched games
    
    // Refresh profile/collection every 3 minutes
    setInterval(() => {
        if (officialApiKey) fetchLiveProfile();
    }, 180000);
    
    // Manual sync button
    const syncNowBtn = document.getElementById('sync-now-btn');
    if (syncNowBtn) {
        syncNowBtn.addEventListener('click', () => {
            syncBattlelog();
            fetchLiveProfile();
        });
    }

    const matchupTargetInput = document.getElementById('matchup-target-input');
    if (matchupTargetInput) {
        matchupTargetInput.addEventListener('input', () => {
            if (activeAnalyticsTab === 'matchups') {
                renderMatchupTable(matches.filter(isRankedMatch));
            }
        });
    }

    if (strategyCanvas && strategyMapImage && strategyMapSelect) {
        window.addEventListener('resize', () => {
            strategyResizeCanvas();
            strategyLoad();
        });
        strategyMapImage.addEventListener('load', () => {
            strategyResizeCanvas();
            strategyLoad();
        });
        strategyMapSelect.addEventListener('change', () => {
            strategyMapKey = strategyMapSelect.value;
            strategyMapImage.src = strategyMapSelect.selectedOptions[0]?.dataset?.img || '';
        });
        const toolSel = document.getElementById('strategy-tool-select');
        if (toolSel) toolSel.addEventListener('change', () => { strategyTool = toolSel.value; });
        const colorInput = document.getElementById('strategy-color');
        const textInput = document.getElementById('strategy-text-input');
        strategyCanvas.addEventListener('mousedown', ev => {
            if (!strategyMapKey) return;
            strategyCloseInlineEditor(true);
            const pt = strategyCanvasPoint(ev);
            if (strategyTool === 'text') {
                const hitIdx = strategyLabelHitTest(pt);
                if (hitIdx >= 0) {
                    strategyDraggingLabelIndex = hitIdx;
                    strategyDragOffset = {
                        x: pt.x - strategyLabels[hitIdx].x,
                        y: pt.y - strategyLabels[hitIdx].y
                    };
                    strategyDrawing = true;
                } else {
                    const preset = textInput ? textInput.value.trim() : '';
                    if (preset) {
                        strategyLabels.push({
                            text: preset,
                            x: pt.x,
                            y: pt.y,
                            color: colorInput ? colorInput.value : '#ff4d4d',
                            size: strategyCurrentFontSize()
                        });
                        strategyComposite();
                        strategySave();
                        strategyPushUndoSnapshot();
                    } else {
                        strategyOpenInlineEditor(pt, colorInput ? colorInput.value : '#ff4d4d');
                    }
                }
                return;
            }
            if (strategyTool === 'erase') {
                const hitIdx = strategyLabelHitTest(pt);
                if (hitIdx >= 0) {
                    strategyLabels.splice(hitIdx, 1);
                    strategyComposite();
                    strategySave();
                    strategyPushUndoSnapshot();
                    return;
                }
                if (!strategyInkCtx) return;
            }
            strategyDrawing = true;
            strategyStart = pt;
        });
        strategyCanvas.addEventListener('mousemove', ev => {
            const pt = strategyCanvasPoint(ev);
            if (strategyTool === 'text' && strategyDrawing && strategyDraggingLabelIndex >= 0) {
                const lbl = strategyLabels[strategyDraggingLabelIndex];
                lbl.x = pt.x - strategyDragOffset.x;
                lbl.y = pt.y - strategyDragOffset.y;
                strategyComposite();
                return;
            }
            if (!strategyDrawing || strategyTool !== 'erase') return;
            if (!strategyInkCtx) return;
            strategyInkCtx.save();
            strategyInkCtx.globalCompositeOperation = 'destination-out';
            strategyInkCtx.beginPath();
            strategyInkCtx.arc(pt.x, pt.y, 12, 0, Math.PI * 2);
            strategyInkCtx.fill();
            strategyInkCtx.restore();
            strategyComposite();
        });
        strategyCanvas.addEventListener('mouseup', ev => {
            if (!strategyDrawing) return;
            const end = strategyCanvasPoint(ev);
            if (strategyTool === 'arrow' && strategyStart) {
                strategyDrawArrow(strategyStart, end, colorInput ? colorInput.value : '#ff4d4d');
            }
            strategyDrawing = false;
            strategyStart = null;
            strategyDraggingLabelIndex = -1;
            strategyDragOffset = { x: 0, y: 0 };
            strategyComposite();
            strategySave();
            strategyPushUndoSnapshot();
        });
        strategyCanvas.addEventListener('mouseleave', () => {
            if (strategyDrawing && strategyTool === 'erase') {
                strategySave();
                strategyPushUndoSnapshot();
            }
            strategyDrawing = false;
            strategyStart = null;
            strategyDraggingLabelIndex = -1;
            strategyDragOffset = { x: 0, y: 0 };
        });
        const clearBtn = document.getElementById('strategy-clear-btn');
        if (clearBtn) clearBtn.addEventListener('click', () => {
            if (!strategyCanvas || !strategyInkCtx) return;
            strategyCloseInlineEditor(false);
            strategyInkCtx.clearRect(0, 0, strategyCanvasSize.width, strategyCanvasSize.height);
            strategyLabels = [];
            strategyComposite();
            strategySave(true);
            strategyPushUndoSnapshot();
        });
        const undoBtn = document.getElementById('strategy-undo-btn');
        if (undoBtn) undoBtn.addEventListener('click', () => strategyUndo());
        const saveBtn = document.getElementById('strategy-save-btn');
        if (saveBtn) saveBtn.addEventListener('click', () => strategySave(true));
        const exportBtn = document.getElementById('strategy-export-btn');
        if (exportBtn) exportBtn.addEventListener('click', () => {
            if (!strategyMapImage || !strategyCanvas) return;
            const out = document.createElement('canvas');
            out.width = strategyCanvasSize.width * strategyCanvasSize.dpr;
            out.height = strategyCanvasSize.height * strategyCanvasSize.dpr;
            const octx = out.getContext('2d');
            octx.drawImage(strategyMapImage, 0, 0, out.width, out.height);
            octx.drawImage(strategyCanvas, 0, 0, out.width, out.height);
            const a = document.createElement('a');
            a.href = out.toDataURL('image/png');
            a.download = `strategy-${(strategyMapKey || 'map').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
            a.click();
        });
        document.addEventListener('keydown', e => {
            const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 'z';
            if (!isUndo) return;
            const activeView = document.querySelector('.view.active');
            if (!activeView || activeView.id !== 'strategies') return;
            const targetTag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
            if (targetTag === 'input' || targetTag === 'textarea') return;
            e.preventDefault();
            strategyUndo();
        });
    }
}

// Navigation Logic
navLinks.forEach(link => {
    link.addEventListener('click', () => {
        navLinks.forEach(nav => nav.classList.remove('active'));
        link.classList.add('active');
        const targetView = link.dataset.view;
        views.forEach(view => {
            if (view.id === targetView) {
                view.classList.add('active');
            } else {
                view.classList.remove('active');
            }
        });
        if (targetView === 'analytics') updateAnalyticsData();
        if (targetView === 'strategies') {
            strategyResizeCanvas();
            strategyLoad();
        }
        if (targetView === 'guide') {
            initGuideStrategy();
            renderGuideView();
        }
    });
});

// Settings Save Logic
savePoolBtn.addEventListener('click', async () => {
    const rawVal = mapPoolInput.value;
    const newPool = rawVal.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    RANKED_POOL = newPool;
    localStorage.setItem('ranked_maps_v2', JSON.stringify(RANKED_POOL));
    
    savePoolMsg.style.display = 'block';
    setTimeout(() => { savePoolMsg.style.display = 'none'; }, 3000);
    
    // 1. Purge historical matches that are no longer in rotation
    purgeNonRotationMatches();
    
    // 2. Re-fetch and re-filter using our new pool
    await fetchGameData();
});

saveApiBtn.addEventListener('click', async () => {
    officialApiKey = apiTokenInput.value.trim();
    localStorage.setItem('brawl_api_key', officialApiKey);

    const rawProxy = apiProxyInput ? apiProxyInput.value.trim().replace(/\/$/, '') : '';
    apiProxyOrigin = rawProxy;
    if (rawProxy) localStorage.setItem('brawl_proxy_origin', rawProxy);
    else localStorage.removeItem('brawl_proxy_origin');
    
    saveApiMsg.style.display = 'block';
    setTimeout(() => { saveApiMsg.style.display = 'none'; }, 3000);
    
    await fetchGameData();
    await fetchLiveProfile();
});

// Modal Logic
addMatchBtn.addEventListener('click', () => {
    modalOverlay.classList.add('active');
});

openLinkModalBtn.addEventListener('click', () => {
    linkAccountModal.classList.add('active');
    if (userProfile) {
        document.getElementById('link-username').value = userProfile.username;
        document.getElementById('link-tag').value = userProfile.tag;
    }
});

editProfileBtn.addEventListener('click', () => {
    linkAccountModal.classList.add('active');
    if (userProfile) {
        document.getElementById('link-username').value = userProfile.username;
        document.getElementById('link-tag').value = userProfile.tag;
    }
});

closeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        closeModal();
    });
});

closeLinkBtn.addEventListener('click', () => {
    linkAccountModal.classList.remove('active');
});

function closeModal() {
    modalOverlay.classList.remove('active');
    matchForm.reset();
    document.getElementById('result-win').checked = true;
    
    // Reset dropdowns
    selectedBrawler = null;
    brawlerSearch.value = '';
    brawlerIcon.style.display = 'none';
    renderBrawlerOptions(brawlers);

    selectedMode = null;
    modeSearch.value = '';
    modeIcon.style.display = 'none';
    renderModeOptions(rankedMaps);
}

// Dropdown Setup
function setupDropdowns() {
    // Focus actions
    brawlerSearch.addEventListener('focus', () => {
        brawlerDropdown.classList.add('open');
        brawlerSearch.value = '';
        renderBrawlerOptions(brawlers);
    });

    modeSearch.addEventListener('focus', () => {
        modeDropdown.classList.add('open');
        modeSearch.value = '';
        renderModeOptions(rankedMaps);
    });

    analyticsMapSearch.addEventListener('focus', () => {
        analyticsMapDropdown.classList.add('open');
        analyticsMapSearch.value = '';
        renderAnalyticsMapOptions(playedMaps);
    });

    // Close options when clicking outside
    document.addEventListener('click', (e) => {
        if (!brawlerDropdown.contains(e.target)) {
            brawlerDropdown.classList.remove('open');
            if (selectedBrawler) brawlerSearch.value = selectedBrawler.name;
            else brawlerSearch.value = '';
        }
        if (!modeDropdown.contains(e.target)) {
            modeDropdown.classList.remove('open');
            if (selectedMode) modeSearch.value = `${selectedMode.modeName} - ${selectedMode.mapName}`;
            else modeSearch.value = '';
        }
        if (!analyticsMapDropdown.contains(e.target)) {
            analyticsMapDropdown.classList.remove('open');
            if (selectedAnalyticsMap) analyticsMapSearch.value = `${selectedAnalyticsMap.modeName} - ${selectedAnalyticsMap.mapName}`;
            else analyticsMapSearch.value = '';
        }
    });

    // Search Filtering
    brawlerSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = brawlers.filter(b => b.name.toLowerCase().includes(query));
        renderBrawlerOptions(filtered);
    });

    modeSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = rankedMaps.filter(map => {
            const mode = map.gameMode;
            if (!mode) return false;
            const str = `${mode.name.replace(/-/g, ' ')} - ${map.name.replace(/-/g, ' ')}`.toLowerCase();
            return str.includes(query);
        });
        renderModeOptions(filtered);
    });

    analyticsMapSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = playedMaps.filter(pm => {
            return `${pm.modeName} - ${pm.mapName}`.toLowerCase().includes(query);
        });
        renderAnalyticsMapOptions(filtered);
    });
}

function renderBrawlerOptions(list) {
    brawlerOptions.innerHTML = '';
    if (list.length === 0) {
        brawlerOptions.innerHTML = '<div class="dropdown-option" style="color: var(--text-muted); cursor: default;">No brawlers found</div>';
        return;
    }

    list.forEach(b => {
        const div = document.createElement('div');
        div.className = 'dropdown-option';
        div.innerHTML = `<img src="${b.imageUrl}" alt="${b.name}"><span>${b.name}</span>`;
        div.addEventListener('click', () => {
            selectedBrawler = b;
            brawlerSearch.value = b.name;
            brawlerIcon.src = b.imageUrl;
            brawlerIcon.style.display = 'block';
            brawlerDropdown.classList.remove('open');
        });
        brawlerOptions.appendChild(div);
    });
}

function renderModeOptions(list) {
    modeOptions.innerHTML = '';
    if (list.length === 0) {
        modeOptions.innerHTML = '<div class="dropdown-option" style="color: var(--text-muted); cursor: default;">No ranked maps found</div>';
        return;
    }

    list.forEach(map => {
        const mode = map.gameMode;
        if (!mode) return;
        
        const div = document.createElement('div');
        div.className = 'dropdown-option';
        
        // Use mapping for more robust icons
        const normalizedMode = mode.name.toUpperCase().replace(/[\s\-\.]+/g, '-');
        const modeId = MODE_ICON_MAP[normalizedMode] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '_')] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '')];
        const modeIconUrl = modeId 
            ? `https://cdn.brawlify.com/game-modes/regular/${modeId}.png`
            : `https://cdn.brawlify.com/gamemode/header/${mode.hash.toLowerCase()}.png`;
        
        const cleanModeName = mode.name.replace(/-/g, ' ');
        const cleanMapName = map.name.replace(/-/g, ' ');

        div.innerHTML = `
            <img src="${modeIconUrl}" alt="${cleanModeName}">
            <span>${cleanModeName} - ${cleanMapName}</span>
        `;
        div.addEventListener('click', () => {
            selectedMode = {
                modeName: cleanModeName,
                mapName: cleanMapName,
                modeIcon: modeIconUrl
            };
            modeSearch.value = `${cleanModeName} - ${cleanMapName}`;
            modeIcon.src = modeIconUrl;
            modeIcon.style.display = 'block';
            modeDropdown.classList.remove('open');
        });
        modeOptions.appendChild(div);
    });
}

function renderAnalyticsMapOptions(list) {
    analyticsMapOptions.innerHTML = '';
    if (list.length === 0) {
        analyticsMapOptions.innerHTML = '<div class="dropdown-option" style="color: var(--text-muted); cursor: default;">No map data yet</div>';
        return;
    }

    list.forEach(pm => {
        const div = document.createElement('div');
        div.className = 'dropdown-option';
        
        div.innerHTML = `
            <img src="${pm.modeIcon}" alt="${pm.modeName}">
            <span>${pm.modeName} - ${pm.mapName}</span>
        `;
        div.addEventListener('click', () => {
            selectedAnalyticsMap = pm;
            analyticsMapSearch.value = `${pm.modeName} - ${pm.mapName}`;
            analyticsMapIcon.src = pm.modeIcon;
            analyticsMapIcon.style.display = 'block';
            analyticsMapDropdown.classList.remove('open');
            updateAnalyticsData();
        });
        analyticsMapOptions.appendChild(div);
    });
}

let brawlersFetchPromise = null;

/** Single in-flight brawler list fetch shared by match form, collection, and guide. */
async function fetchBrawlersOnce() {
    if (brawlers.length) return true;
    if (!brawlersFetchPromise) {
        brawlersFetchPromise = (async () => {
            try {
                const brawlersData = await fetchBrawlApiJson('/brawlers');
                brawlers = brawlersData.list.sort((a, b) => a.name.localeCompare(b.name));
                if (brawlerSearch) {
                    brawlerSearch.placeholder = 'Select a Brawler...';
                    brawlerSearch.disabled = false;
                }
                renderBrawlerOptions(brawlers);
                if (isGuideViewActive() && guideActiveTab === 'tierlists') {
                    renderGuideBrawlerPool();
                }
                return true;
            } catch (err) {
                brawlersFetchPromise = null;
                console.warn('[Brawlers] fetch failed:', err);
                return false;
            }
        })();
    }
    return brawlersFetchPromise;
}

// Fetch Data from BrawlAPI
async function fetchGameData() {
    const [brawlersOk, mapsResult] = await Promise.all([
        fetchBrawlersOnce(),
        fetchBrawlApiJson('/maps').then(data => ({ ok: true, data })).catch(err => ({ ok: false, err }))
    ]);

    if (mapsResult.ok) {
        const uniqueMaps = [];
        const seenNames = new Set();
        mapsResult.data.list.forEach(m => {
            const normalizedName = m.name.replace(/-/g, ' ').toLowerCase();
            if (!seenNames.has(normalizedName)) {
                seenNames.add(normalizedName);
                uniqueMaps.push(m);
            }
        });

        rankedMaps = uniqueMaps.filter(m => {
            const normalizedName = m.name.replace(/-/g, ' ').toLowerCase();
            return RANKED_POOL.some(rankedName => rankedName.replace(/-/g, ' ').toLowerCase() === normalizedName);
        });

        if (modeSearch) {
            modeSearch.placeholder = 'Select Ranked Map & Mode...';
            modeSearch.disabled = false;
        }
        renderModeOptions(rankedMaps);
        populateStrategyMaps();
    } else {
        console.error('Error fetching maps:', mapsResult.err);
    }

    if (!brawlersOk && !brawlers.length) {
        const offline = window.location.protocol === 'file:' || mapsResult.err?.name === 'TypeError';
        if (brawlerSearch) {
            brawlerSearch.placeholder = offline
                ? '⚠️ Proxy missing. Live mode selection disabled.'
                : 'Error loading brawlers.';
        }
        if (modeSearch && !mapsResult.ok) {
            modeSearch.placeholder = offline
                ? '⚠️ Run Launch.bat to enable map selection.'
                : 'Error loading maps.';
        }
    }

    if (isGuideViewActive() && guideActiveTab === 'tierlists') {
        renderGuideBrawlerPool();
    }

    const metaRepaired = repairStoredMatchMetadata();
    if (metaRepaired > 0) {
        localStorage.setItem('brawl_matches', JSON.stringify(matches));
        updateDashboard();
    }
}

// Profile Logic
linkAccountForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const username = document.getElementById('link-username').value.trim();
    const tag = document.getElementById('link-tag').value.trim().toUpperCase();
    
    if (!tag.startsWith('#')) {
        alert("Player Tag must start with a `#` symbol.");
        return;
    }

    userProfile = {
        username,
        tag: normalizePlayerTag(tag),
        icon: "https://cdn.brawlify.com/profile-icons/regular/28000000.png" // Default generic icon until API hooked
    };
    
    localStorage.setItem('brawl_profile', JSON.stringify(userProfile));
    linkAccountModal.classList.remove('active');
    updateProfileCard();
});

function updateProfileCard() {
    if (userProfile) {
        profileUnlinked.style.display = 'none';
        profileLinked.style.display = 'flex';
        profileUsername.textContent = userProfile.username;
        profileTag.textContent = userProfile.tag;
        profileAvatar.src = userProfile.icon;
        
        // Hide API specific stats by default until fetched
        profileLiveStats.style.display = 'none';
        profileClub.style.display = 'none';
        apiStatusBadge.style.display = 'none';
        
        if (officialApiKey) fetchLiveProfile();
    } else {
        profileUnlinked.style.display = 'flex';
        profileLinked.style.display = 'none';
    }
}

async function fetchLiveProfile() {
    if (!userProfile || !officialApiKey) return;
    
    apiStatusBadge.style.display = 'block';
    apiStatusBadge.style.color = 'var(--text-muted)';
    apiStatusBadge.textContent = 'API Syncing...';
    
    // Developer Sandbox Bypass for server outages
    if (officialApiKey === 'SANDBOX_TEST') {
        setTimeout(() => {
            apiStatusBadge.style.color = 'var(--color-win)';
            apiStatusBadge.textContent = 'Live Synced ✓ (Sandbox)';
            
            profileLiveStats.style.display = 'flex';
            profileTrophies.textContent = (45120).toLocaleString();
            profileHighest.textContent = (46000).toLocaleString();
            profile3v3.textContent = (12540).toLocaleString();
            profileClub.style.display = 'inline-block';
            profileClub.textContent = 'Antigravity Esports';
            
            const sandboxBrawlers = [
                { name: "SHELLY", power: 11, hasHypercharge: true, starPowers: [{name: "Shell Shock"}, {name: "Band-Aid"}], gadgets: [{name:"Fast Forward"}], gears: [{name: "Speed"}, {name: "Damage"}] },
                { name: "EDGAR", power: 9, starPowers: [{name: "Fisticuffs"}], gadgets: [{name:"Let's Fly"}], gears: [] },
                { name: "PIPER", power: 10, starPowers: [{name: "Ambush"}], gadgets: [{name:"Auto Aimer"}, {name:"Homemade Recipe"}], gears: [{name: "Damage"}] },
                { name: "MORTIS", power: 11, hasHypercharge: true, starPowers: [{name: "Creepy Harvest"}, {name: "Coiled Snake"}], gadgets: [{name:"Combo Spinner"}], gears: [{name: "Damage"}] },
                { name: "CROW", power: 8, starPowers: [], gadgets: [{name:"Defense Booster"}], gears: [] }
            ];
            
            localStorage.setItem('brawl_collection_data', JSON.stringify(sandboxBrawlers));
            renderCollection(sandboxBrawlers);
            
            setTimeout(() => { apiStatusBadge.style.display = 'none'; }, 4000);
        }, 800);
        return;
    }
    
    try {
        const tagFormatted = userProfile.tag.replace('#', '');
        const res = await smartBrawlFetch(`/players/%23${tagFormatted}`);
        const ct = res.headers.get('content-type') || '';

        if (!res.ok) {
            let hint = `API error (${res.status})`;
            if (res.status === 404 || !ct.includes('application/json')) {
                hint = 'No proxy here (e.g. GitHub Pages). Deploy this repo on Vercel/Netlify, or set “Proxy site URL” in Settings to that deployment.';
            } else {
                try {
                    const errData = await res.json();
                    if (res.status === 403) {
                        apiStatusBadge.style.color = 'var(--color-loss)';
                        apiStatusBadge.textContent = `⚠️ ${keyIpWhitelistHint(errData.message)}`;
                        console.error('[Profile] 403:', errData.message || errData);
                        return;
                    }
                    if (errData.message) hint = errData.message;
                } catch { /* keep hint */ }
            }
            apiStatusBadge.style.color = 'var(--color-loss)';
            apiStatusBadge.textContent = hint;
            return;
        }

        let data;
        try {
            data = await res.json();
        } catch (parseErr) {
            apiStatusBadge.style.color = 'var(--color-loss)';
            apiStatusBadge.textContent = 'Bad response from proxy (not JSON). Redeploy or check Vercel logs.';
            console.error(parseErr);
            return;
        }

        // Supercell sometimes returns HTTP 200 with a JSON error body (no `trophies`).
        if (data.reason && typeof data.trophies !== 'number') {
            apiStatusBadge.style.color = 'var(--color-loss)';
            apiStatusBadge.textContent = `⚠️ ${keyIpWhitelistHint(data.message)}`;
            console.warn('[Profile] Error-shaped JSON:', data.reason, data.message);
            return;
        }

        // Note: `if (data.trophies)` is wrong — trophy count can be 0 and is still valid.
        if (typeof data.trophies === 'number') {
            // Update successful
            apiStatusBadge.style.color = 'var(--color-win)';
            apiStatusBadge.textContent = 'Live Synced ✓';
            
            // Map JSON response to UI
            profileLiveStats.style.display = 'flex';
            profileTrophies.textContent = data.trophies.toLocaleString();
            profileHighest.textContent = (data.highestTrophies ?? 0).toLocaleString();
            profile3v3.textContent = (data['3vs3Victories'] || 0).toLocaleString();
            
            // Sync Profile Icon from API
            if (data.icon && data.icon.id) {
                userProfile.icon = `https://cdn.brawlify.com/profile-icons/regular/${data.icon.id}.png`;
                localStorage.setItem('brawl_profile', JSON.stringify(userProfile));
                profileAvatar.src = userProfile.icon;
            }

            if (data.club && data.club.name) {
                profileClub.style.display = 'inline-block';
                profileClub.textContent = data.club.name;
            } else {
                profileClub.style.display = 'none';
            }
            
            // Sync Collection
            if (data.brawlers) {
                localStorage.setItem('brawl_collection_data', JSON.stringify(data.brawlers));
                renderCollection(data.brawlers);
            }
            
            // Wait 3 seconds and fade out the badge for cleanliness
            setTimeout(() => { apiStatusBadge.style.display = 'none'; }, 3000);
        } else {
            apiStatusBadge.style.color = 'var(--color-loss)';
            const msg = [data.reason, data.message].filter(Boolean).join(' — ') || 'Unexpected API response (no player data). Check player tag.';
            apiStatusBadge.textContent = msg;
            console.warn('[Profile] OK but not a player JSON:', data);
        }
        
    } catch (err) {
        apiStatusBadge.style.color = 'var(--color-loss)';
        if (window.location.protocol === 'file:') {
            apiStatusBadge.textContent = 'Run Launch.bat (local proxy) or open the deployed site on Vercel/Netlify.';
        } else if (err.name === 'AbortError') {
            apiStatusBadge.textContent = `Request timed out (${OFFICIAL_API_FETCH_MS / 1000}s). Proxy or upstream API is slow or unreachable.`;
        } else if (isNetworkOrCorsFailure(err)) {
            apiStatusBadge.textContent = 'Cannot reach API proxy. If you use GitHub Pages, set “Proxy site URL” to your Vercel deployment of this repo.';
        } else {
            apiStatusBadge.textContent = 'Failed to fetch profile';
        }
        console.error(err);
    }
}

// Form Submission (Add Match)
matchForm.addEventListener('submit', (e) => {
    e.preventDefault();

    if (!selectedBrawler) {
        alert("Please select a Brawler.");
        return;
    }
    if (!selectedMode) {
        alert("Please select a Ranked Map & Mode.");
        return;
    }

    const result = document.querySelector('input[name="result"]:checked').value;

    const match = {
        id: Date.now().toString(),
        brawlerId: selectedBrawler.id,
        brawlerName: selectedBrawler.name,
        brawlerIcon: selectedBrawler.imageUrl,
        modeName: selectedMode.modeName,
        mapName: selectedMode.mapName,
        modeIcon: selectedMode.modeIcon,
        result,
        isRanked: true, // Manual entries are assumed ranked for this tracker
        date: new Date().toISOString()
    };

    matches.unshift(match);
    localStorage.setItem('brawl_matches', JSON.stringify(matches));
    
    closeModal();
    renderMatches();
    updateDashboard();
});

// Match History Tab Switching
window.switchMatchTab = function(tabName) {
    document.querySelectorAll('#matches .sub-tab').forEach(t => t.classList.remove('active'));
    const targetTab = document.querySelector(`#matches .sub-tab[data-tab="${tabName}"]`);
    if (targetTab) targetTab.classList.add('active');
    activeMatchTab = tabName;
    matchListVisibleCount = MATCH_LIST_PAGE_SIZE;
    renderMatches();
};

window.switchAnalyticsTab = function(tabName) {
    activeAnalyticsTab = tabName;
    document.querySelectorAll('#analytics .analytics-sub-tab').forEach(t => {
        t.classList.remove('active');
        const ind = t.querySelector('.analytics-tab-indicator');
        if (ind) ind.style.display = 'none';
    });
    const targetTab = document.querySelector(`#analytics .analytics-sub-tab[data-analytics-tab="${tabName}"]`);
    if (targetTab) {
        targetTab.classList.add('active');
        const ind = targetTab.querySelector('.analytics-tab-indicator');
        if (ind) ind.style.display = 'block';
    }
    updateAnalyticsData();
};

// Clear All Matches
clearAllBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to delete all match history?")) {
        matches = [];
        matchListVisibleCount = MATCH_LIST_PAGE_SIZE;
        rebuildMatchIdIndex();
        localStorage.setItem('brawl_matches', JSON.stringify(matches));
        renderMatches();
        updateDashboard();
    }
});

/** Milliseconds for sorting; uses `date`, else parses Supercell `battleTime` id, else numeric id. */
function matchChronoKey(m) {
    if (!m) return 0;
    const t = Date.parse(m.date);
    if (Number.isFinite(t)) return t;
    const sid = String(m.id || '');
    const bt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(sid);
    if (bt) {
        const parsed = Date.parse(`${bt[1]}-${bt[2]}-${bt[3]}T${bt[4]}:${bt[5]}:${bt[6]}Z`);
        if (Number.isFinite(parsed)) return parsed;
    }
    const n = Number(m.id);
    return Number.isFinite(n) ? n : 0;
}

function compareMatchesNewestFirst(a, b) {
    const kb = matchChronoKey(b);
    const ka = matchChronoKey(a);
    if (kb !== ka) return kb - ka;
    return String(b.id).localeCompare(String(a.id));
}

// Render Match History List
function renderMatches() {
    const listContainer = document.getElementById('matches-list-container');
    if (!listContainer) return;

    matches.sort(compareMatchesNewestFirst);
    rebuildMatchIdIndex();
    
    // Filter matches based on the active tab
    const filteredMatches = matches.filter(m => {
        if (activeMatchTab === 'ranked') {
            return isRankedMatch(m);
        } else {
            return !isRankedMatch(m);
        }
    });

    let loadMoreBtn = document.getElementById('load-more-matches-btn');

    if (filteredMatches.length === 0) {
        listContainer.innerHTML = `<div class="empty-state">No ${activeMatchTab} matches recorded yet.</div>`;
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        return;
    }

    listContainer.innerHTML = '';

    const displayLimit = activeMatchTab === 'ranked'
        ? RANKED_LOG_MAX_MATCHES
        : matchListVisibleCount;
    const visibleMatches = filteredMatches.slice(0, displayLimit);

    visibleMatches.forEach((match) => {
        const item = document.createElement('div');
        item.className = 'match-item';
        
        const dateStr = new Date(match.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });

        item.innerHTML = `
            <div class="match-item-left">
                <img src="${match.brawlerIcon || 'https://via.placeholder.com/40'}" alt="${match.brawlerName}" class="brawler-avatar" onerror="this.src='https://via.placeholder.com/40'">
                <div class="match-item-details">
                    <h4>${match.brawlerName}</h4>
                    <p>${match.modeName} - ${match.mapName} • ${dateStr}</p>
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 1rem;">
                <div class="match-item-result result-${match.result}">
                    ${match.result}
                </div>
                <button class="delete-match-btn" title="Delete Match">&times;</button>
            </div>
        `;
        
        item.querySelector('.delete-match-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteMatch(match.id);
        });

        listContainer.appendChild(item);
    });

    if (activeMatchTab === 'ranked' && filteredMatches.length > RANKED_LOG_MAX_MATCHES) {
        const note = document.createElement('p');
        note.className = 'empty-state';
        note.style.cssText = 'margin-top:0.75rem;font-size:0.85rem;opacity:0.75;';
        note.textContent = `Showing your ${RANKED_LOG_MAX_MATCHES} most recent ranked battles (${filteredMatches.length} stored).`;
        listContainer.appendChild(note);
    }

    if (!loadMoreBtn) {
        loadMoreBtn = document.createElement('button');
        loadMoreBtn.id = 'load-more-matches-btn';
        loadMoreBtn.type = 'button';
        loadMoreBtn.className = 'primary-btn';
        loadMoreBtn.style.cssText = 'display:none;width:100%;margin-top:1rem;padding:0.75rem;font-size:0.9rem;';
        loadMoreBtn.addEventListener('click', () => {
            matchListVisibleCount += MATCH_LIST_PAGE_SIZE;
            renderMatches();
        });
        listContainer.parentNode.insertBefore(loadMoreBtn, listContainer.nextSibling);
    }

    if (activeMatchTab !== 'ranked' && filteredMatches.length > matchListVisibleCount) {
        const remaining = filteredMatches.length - matchListVisibleCount;
        loadMoreBtn.textContent = `Load more (${remaining} older)`;
        loadMoreBtn.style.display = 'block';
    } else {
        loadMoreBtn.style.display = 'none';
    }

}

function deleteMatch(id) {
    matches = matches.filter(m => m.id !== id);
    rebuildMatchIdIndex();
    localStorage.setItem('brawl_matches', JSON.stringify(matches));
    renderMatches();
    updateDashboard();
}

/**
 * Permanently deletes matches from maps that are not in the current RANKED_POOL.
 * @param {boolean} silent If true, skips re-rendering (useful during sync)
 * @returns {number} The number of purged items
 */
/** Optional cleanup when saving a new map pool (does not run on auto-sync). */
function purgeNonRotationMatches(silent = false) {
    if (!matches || matches.length === 0) return 0;
    
    const beforeCount = matches.length;
    
    matches = matches.filter(m => {
        if (m.isRanked === false) return true;
        if (isApiSyncedMatch(m)) return true;
        return isMapInRankedPool(m.mapName);
    });
    
    const purged = beforeCount - matches.length;
    if (purged > 0) {
        rebuildMatchIdIndex();
        localStorage.setItem('brawl_matches', JSON.stringify(matches));
        if (!silent) {
            renderMatches();
            updateDashboard();
        }
    }
    return purged;
}

// SYNC LOGIC (Supercell Official API)
// ======================================
let lastSyncTime = null;

async function syncBattlelog() {
    if (isSyncing) return;
    if (!userProfile || !userProfile.tag) {
        alert("Please link your account at the top first!");
        return;
    }

    // Safety check - wait for brawlers to load if they haven't yet
    if (brawlers.length === 0) {
        const syncStatus = document.getElementById('sync-status-text');
        if (syncStatus) {
            syncStatus.textContent = "Waiting for game data...";
            syncStatus.style.color = "var(--color-win)";
        }
        await new Promise(r => setTimeout(r, 1500)); 
    }

    isSyncing = true;
    const syncStatus = document.getElementById('sync-status-text');
    if (syncStatus) {
        syncStatus.textContent = "Syncing...";
        syncStatus.style.color = "var(--color-win)";
    }
    
    rebuildMatchIdIndex();
    
    try {
        let items = [];
        
        if (officialApiKey === 'SANDBOX_TEST') {
            // Fake Mock Data for Sandbox
            const modes = ['brawlBall', 'gemGrab', 'heist', 'knockout', 'bounty', 'hotZone'];
            const maps = ['Center Stage', 'Hard Rock Mine', 'Hot Potato', 'Flaring Phoenix', 'Shooting Star', 'Ring of Fire'];
            const brawlerNames = ['MORTIS', 'SHELLY', 'CROW', 'EDGAR', 'PIPER'];
            const idx = Math.floor(Math.random() * modes.length);
            items = [
                {
                    battleTime: new Date().toISOString().replace(/[-:]/g, '').replace('.', ''),
                    event: { mode: modes[idx], map: maps[idx] },
                    battle: {
                        mode: modes[idx], type: "soloRanked", 
                        result: Math.random() > 0.4 ? "victory" : "defeat",
                        teams: [[{ tag: userProfile.tag, name: userProfile.username, brawler: { name: brawlerNames[Math.floor(Math.random() * brawlerNames.length)] } }]]
                    }
                }
            ];
            await new Promise(r => setTimeout(r, 800));
        } else {
            // Official Fetch
            const tagFormatted = userProfile.tag.replace('#', '');
            const res = await smartBrawlFetch(`/players/%23${tagFormatted}/battlelog`);
            
            if (!res.ok) {
                const ct = res.headers.get('content-type') || '';
                let errorMsg = `Sync error (${res.status})`;
                if (res.status === 404 || !ct.includes('application/json')) {
                    errorMsg = 'No API proxy on this host. Use Vercel/Netlify for this repo, or set “Proxy site URL” in Settings.';
                } else {
                    try {
                        const errData = await res.json();
                        if (res.status === 403) {
                            errorMsg = `⚠️ ${keyIpWhitelistHint(errData.message)}`;
                            console.error('[Sync] 403 Forbidden:', errData.hint || errData.message || 'IP mismatch');
                        } else if (errData.message) {
                            errorMsg = `Error: ${errData.message}`;
                        }
                    } catch { /* couldn't parse error body */ }
                }
                
                if (syncStatus) {
                    syncStatus.textContent = errorMsg;
                    syncStatus.style.color = 'var(--color-loss)';
                }
                console.warn(`[Sync] Battlelog fetch failed: HTTP ${res.status}`);
                return;
            }
            
            // Reset status color on success
            if (syncStatus) syncStatus.style.color = 'var(--text-muted)';
            
            const data = await res.json();
            if (data.reason && !Array.isArray(data.items)) {
                const ip = extractIpFromApiMessage(String(data.message || ''));
                const errorMsg = ip
                    ? `⚠️ ${keyIpWhitelistHint(data.message)}`
                    : [data.reason, data.message].filter(Boolean).join(' — ');
                if (syncStatus) {
                    syncStatus.textContent = errorMsg;
                    syncStatus.style.color = 'var(--color-loss)';
                }
                console.warn('[Sync] Error JSON from battlelog:', data);
                return;
            }
            if (data.items) items = data.items;
            console.log(`[Sync] Fetched ${items.length} battlelog entries`);
        }
        
        let newCount = 0;
        let skippedCount = 0;
        let updatedCount = 0;

        // Ranked Bo3 (Mythic+) returns each game as its own entry sharing one battleTime.
        // Track per-battleTime occurrences so every individual game is stored, not collapsed.
        const battleTimeOccurrences = new Map();
        
        items.forEach(item => {
            // Safety check for malformed entries
            if (!item.battle || !item.event) {
                skippedCount++;
                return;
            }
            
            const battleType = (item.battle.type || '').toLowerCase();
            const isRanked = isBattleRanked(item.battle);
            
            // Find User's Brawler in the teams data
            let myBrawlerName = "";
            let myBrawlerId = 0;
            let foundPlayer = false;
            
            // Handle team-based modes (never use team array index as "rank" — it is not win/loss.)
            if (item.battle.teams) {
                for (let i = 0; i < item.battle.teams.length; i++) {
                    let team = item.battle.teams[i];
                    for (let p of team) {
                        if (tagsEqual(p.tag, userProfile.tag)) {
                            myBrawlerName = p.brawler.name.toUpperCase();
                            myBrawlerId = p.brawler.id || 0;
                            foundPlayer = true;
                            break;
                        }
                    }
                    if (foundPlayer) break;
                }
            }
            
            // Handle solo modes (Showdown, etc.) — players array instead of teams
            if (!foundPlayer && item.battle.players) {
                for (let i = 0; i < item.battle.players.length; i++) {
                    let p = item.battle.players[i];
                    if (tagsEqual(p.tag, userProfile.tag)) {
                        myBrawlerName = p.brawler.name.toUpperCase();
                        myBrawlerId = p.brawler.id || 0;
                        foundPlayer = true;
                        break;
                    }
                }
            }
            
            if (!foundPlayer) {
                console.log(`[Sync] Skipped match: could not find player ${userProfile.tag}`);
                skippedCount++;
                return;
            }
            
            // Resolve brawler icon from loaded global data
            const normalizedMyBrawler = normalizeBrawlerName(myBrawlerName);
            const mappedBrawler = brawlers.find(b => normalizeBrawlerName(b.name) === normalizedMyBrawler);
            
            // Try to find map in ranked pool for icon, but DON'T skip if not found
            const mapRaw = item.event.map || 'Unknown Map';
            const mappedMap = findRankedMapEntry(mapRaw);
            const modeLabel = canonicalModeName(item.battle.mode || item.event.mode, mappedMap) || 'Unknown Mode';
            
            // Determine result: prefer official `battle.result` (3v3 / most modes). Rank rules only when that is absent (Showdown-style).
            let result = 'loss';
            const rawResult = (item.battle.result || '').toLowerCase();
            const modeStr = (item.battle.mode || item.event.mode || '').toLowerCase();

            if (rawResult === 'victory' || rawResult === 'win') {
                result = 'win';
            } else if (rawResult === 'defeat' || rawResult === 'loss') {
                result = 'loss';
            } else if (rawResult === 'draw') {
                result = 'draw';
            } else {
                const placement = item.battle.rank;
                if (placement !== undefined && placement !== null) {
                    const r = Number(placement);
                    if (!Number.isNaN(r)) {
                        if (r === 1) {
                            result = 'win';
                        } else if (modeStr.includes('solo') && r <= 4) {
                            result = 'win';
                        } else if (modeStr.includes('duo') && r <= 2) {
                            result = 'win';
                        } else if (modeStr.includes('trio') && r <= 2) {
                            result = 'win';
                        } else if (r === 5 && modeStr.includes('solo')) {
                            result = 'draw';
                        } else if (r === 3 && modeStr.includes('duo')) {
                            result = 'draw';
                        }
                    }
                }
            }
            
            // Parse the actual battle time for accurate history
            let battleDate;
            try {
                // Brawl Stars API format: "20260407T123456.000Z" 
                const bt = item.battleTime;
                battleDate = new Date(
                    bt.slice(0,4) + '-' + bt.slice(4,6) + '-' + bt.slice(6,8) + 'T' +
                    bt.slice(9,11) + ':' + bt.slice(11,13) + ':' + bt.slice(13,15) + 'Z'
                ).toISOString();
            } catch {
                battleDate = new Date().toISOString();
            }
            
            const oppBrawlers = extractOpponentBrawlersFromBattle(item, userProfile.tag);

            // Distinguish individual games within the same Bo3 (identical battleTime).
            // Order in the battlelog is stable, so occurrence #n maps to the same game each sync.
            const battleTimeId = item.battleTime;
            const occurrence = (battleTimeOccurrences.get(battleTimeId) || 0) + 1;
            battleTimeOccurrences.set(battleTimeId, occurrence);
            const matchId = occurrence === 1 ? battleTimeId : `${battleTimeId}#${occurrence}`;

            const newMatch = {
                id: matchId,
                source: 'api',  // Tag as API-synced so it never gets purged
                brawlerId: mappedBrawler ? mappedBrawler.id : myBrawlerId,
                brawlerName: mappedBrawler ? mappedBrawler.name : myBrawlerName,
                brawlerIcon: mappedBrawler ? mappedBrawler.imageUrl : resolveBrawlerIconUrl(myBrawlerId),
                modeName: modeLabel,
                mapName: canonicalMapName(mapRaw),
                modeIcon: mappedMap?.gameMode?.imageUrl || '',
                result,
                isRanked,
                battleType,
                trophyChange: item.battle.trophyChange ?? null,
                date: battleDate,
                opponentBrawlers: oppBrawlers
            };
            
            const existingIdx = matchIdIndex.get(String(matchId));
            if (existingIdx !== undefined) {
                const oldMatch = matches[existingIdx];
                let repaired = false;
                if (oldMatch.source !== 'api') {
                    oldMatch.source = 'api';
                    repaired = true;
                }
                if (oppBrawlers.length && JSON.stringify(oldMatch.opponentBrawlers || []) !== JSON.stringify(oppBrawlers)) {
                    oldMatch.opponentBrawlers = oppBrawlers;
                    repaired = true;
                }
                if (oldMatch.battleType !== battleType) {
                    oldMatch.battleType = battleType;
                    repaired = true;
                }
                const tc = item.battle.trophyChange ?? null;
                if (oldMatch.trophyChange !== tc) {
                    oldMatch.trophyChange = tc;
                    repaired = true;
                }
                if (oldMatch.isRanked !== isRanked || oldMatch.result !== result) {
                    oldMatch.isRanked = isRanked;
                    oldMatch.result = result;
                    repaired = true;
                }
                if (oldMatch.modeName !== modeLabel) {
                    oldMatch.modeName = modeLabel;
                    repaired = true;
                }
                const canonMap = canonicalMapName(mapRaw);
                if (oldMatch.mapName !== canonMap) {
                    oldMatch.mapName = canonMap;
                    repaired = true;
                }
                if (repaired) updatedCount++;
            } else {
                matches.push(newMatch);
                matchIdIndex.set(String(matchId), matches.length - 1);
                newCount++;
            }
        });

        if (newCount > 0) {
            matches.sort(compareMatchesNewestFirst);
            rebuildMatchIdIndex();
        }

        const flagsRepaired = repairStoredMatchRankFlags();
        const metaRepaired = repairStoredMatchMetadata();
        
        if (newCount > 0 || updatedCount > 0 || flagsRepaired > 0 || metaRepaired > 0) {
            if (flagsRepaired > 0 || metaRepaired > 0) rebuildMatchIdIndex();
            localStorage.setItem('brawl_matches', JSON.stringify(matches));
            renderMatches();
            updateDashboard();
            if (newCount > 0) console.log(`[Sync] Added ${newCount} new matches`);
            if (updatedCount > 0) console.log(`[Sync] Repaired ${updatedCount} existing matches`);
            if (flagsRepaired > 0) console.log(`[Sync] Reclassified ${flagsRepaired} match rank flags`);
        }
        
        lastSyncTime = new Date();
        if (syncStatus) {
            const timeStr = lastSyncTime.toLocaleTimeString();
            let statusParts = [];
            if (newCount > 0) statusParts.push(`+${newCount} match${newCount > 1 ? 'es' : ''}`);
            if (updatedCount > 0) statusParts.push(`${updatedCount} updated`);
            statusParts.push(`${matches.length} stored`);
            syncStatus.textContent = statusParts.length > 0
                ? `${statusParts.join(', ')} • ${timeStr}`
                : `Up to date • ${timeStr}`;
        }
        
    } catch (err) {
        console.error("Auto Sync Failed:", err);
        const syncStatus = document.getElementById('sync-status-text');
        if (syncStatus) {
            if (window.location.protocol === 'file:') {
                syncStatus.textContent = 'Offline — start the local server (Launch.bat) for API sync.';
            } else if (isNetworkOrCorsFailure(err)) {
                syncStatus.textContent = 'Cannot reach API proxy. Deploy on Vercel/Netlify or set “Proxy site URL” in Settings.';
            } else {
                syncStatus.textContent = 'Sync failed — check API key and developer portal IP whitelist.';
            }
        }
    } finally {
        isSyncing = false;
    }
}

// Global IP Checker for Debugging
async function handleCheckIP() {
    const btn = document.getElementById('check-ip-btn');
    const display = document.getElementById('ip-display');
    if (!btn || !display) return;

    btn.textContent = 'Checking...';
    display.style.display = 'inline-block';
    display.textContent = 'Detecting...';
    
    const ip = await getBrowserIP();
    display.textContent = `Current Browser IP: ${ip}`;
    btn.textContent = 'Check Connection IP';
}

// Render Dashboard
function updateDashboard() {
    // Filter for only ranked matches for analytics
    const rankedMatches = matches.filter(isRankedMatch);
    const totalMatches = rankedMatches.length;

    if (totalMatches === 0) {
        document.getElementById('overall-match-count').textContent = '0 ranked matches';
        document.getElementById('overall-winrate-text').textContent = '0%';
        document.getElementById('overall-winrate-circle').style.background = `conic-gradient(var(--bg-surface) 360deg, var(--bg-surface) 0deg)`;
        
        document.getElementById('top-brawlers-list').innerHTML = '<li class="empty-state">No ranked matches recorded yet.</li>';
        document.getElementById('best-modes-list').innerHTML = '<li class="empty-state">No ranked matches recorded yet.</li>';
        playedMaps = [];
        if (selectedAnalyticsMap || activeAnalyticsTab === 'overall' || activeAnalyticsTab === 'matchups') updateAnalyticsData();
        return;
    }

    const uniqueMapsMap = new Map();
    
    rankedMatches.forEach(m => {
        const key = mapNameKey(m.mapName);
        if (!uniqueMapsMap.has(key)) {
            const mappedMap = findRankedMapEntry(m.mapName);
            const modeLabel = canonicalModeName(m.modeName, mappedMap) || m.modeName || 'Ranked';
            // Find better icon if current one is broken
            let icon = m.modeIcon;
            if (!icon || icon === "undefined" || icon === "") {
                const normalizedMode = modeLabel.toUpperCase().replace(/[\s\-\.]+/g, '-');
                const modeId = MODE_ICON_MAP[normalizedMode] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '_')] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '')];
                if (modeId) icon = `https://cdn.brawlify.com/game-modes/regular/${modeId}.png`;
            }
            uniqueMapsMap.set(key, { modeName: modeLabel, mapName: canonicalMapName(m.mapName), modeIcon: icon || 'https://cdn.brawlify.com/game-modes/regular/48000000.png' });
        }
    });
    playedMaps = Array.from(uniqueMapsMap.values());
    if (selectedAnalyticsMap || activeAnalyticsTab === 'overall' || activeAnalyticsTab === 'matchups') updateAnalyticsData();

    const wins = rankedMatches.filter(m => m.result === 'win').length;
    const losses = rankedMatches.filter(m => m.result === 'loss').length;
    const decisive = wins + losses;
    const winRate = decisive > 0 ? Math.round((wins / decisive) * 100) : 0;
    
    document.getElementById('overall-winrate-text').textContent = `${winRate}%`;
    document.getElementById('overall-winrate-circle').style.background = `conic-gradient(var(--accent-blue) ${winRate * 3.6}deg, var(--bg-surface) 0deg)`;
    const countEl = document.getElementById('overall-match-count');
    if (countEl) {
        const draws = totalMatches - decisive;
        countEl.textContent = draws > 0
            ? `${totalMatches} ranked (${wins}W-${losses}L, ${draws} draw)`
            : `${totalMatches} ranked (${wins}W-${losses}L)`;
    }

    // 2. Top Brawlers
    const brawlerStats = {};
    rankedMatches.forEach(m => {
        const key = brawlerStatsKey(m);
        if (!brawlerStats[key]) {
            brawlerStats[key] = { name: m.brawlerName, icon: m.brawlerIcon, matches: 0, wins: 0 };
        }
        brawlerStats[key].matches++;
        if (m.result === 'win') brawlerStats[key].wins++;
    });

    const sortedBrawlers = Object.values(brawlerStats)
        .map(b => ({ ...b, winRate: Math.round((b.wins / b.matches) * 100) }))
        .sort((a, b) => {
            if (b.winRate === a.winRate) return b.matches - a.matches;
            return b.winRate - a.winRate;
        })
        .slice(0, 3);

    const brawlersList = document.getElementById('top-brawlers-list');
    brawlersList.innerHTML = '';
    sortedBrawlers.forEach(b => {
        brawlersList.innerHTML += `
            <li>
                <div class="brawler-info">
                    <img src="${b.icon || 'https://via.placeholder.com/40'}" class="brawler-avatar" onerror="this.src='https://via.placeholder.com/40'">
                    <div>
                        <strong>${b.name}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted)">${b.matches} matches</div>
                    </div>
                </div>
                <span class="win-rate-badge">${b.winRate}% SR</span>
            </li>
        `;
    });

    // 3. Best Modes (ranked only)
    const modeStats = {};
    rankedMatches.forEach(m => {
        const modeKey = `${m.modeName} - ${m.mapName}`;
        if (!modeStats[modeKey]) {
            // Fallback icon lookup if missing in match record
            let icon = m.modeIcon;
            if (!icon || icon === "undefined") {
                const foundMap = rankedMaps.find(rm => rm.name === m.mapName);
                if (foundMap && foundMap.gameMode) {
                    icon = foundMap.gameMode.imageUrl;
                }
            }
            
            modeStats[modeKey] = { 
                name: modeKey, 
                icon: icon || "", 
                matches: 0, 
                wins: 0, 
                color: m.modeColor || '#444' 
            };
        }
        modeStats[modeKey].matches++;
        if (m.result === 'win') modeStats[modeKey].wins++;
    });

    const sortedModes = Object.values(modeStats)
        .map(stats => {
            // Split "Mode - Map Names" back to just the Map Name for display
            const mapName = stats.name.includes(' - ') ? stats.name.split(' - ')[1] : stats.name;
            const modeName = stats.name.includes(' - ') ? stats.name.split(' - ')[0] : 'GEM-GRAB';
            
            // Refined icon logic: 
            // 1. Check if we already have a clean URL
            let finalIcon = (stats.icon && stats.icon !== "undefined" && stats.icon !== "") ? stats.icon : null;
            
            // 2. Try to generate from safety mapping if missing
            if (!finalIcon) {
                const normalizedMode = modeName.toUpperCase().replace(/[\s\-\.]+/g, '-');
                const modeId = MODE_ICON_MAP[normalizedMode] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '_')] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '')];
                if (modeId) {
                    finalIcon = `https://cdn.brawlify.com/game-modes/regular/${modeId}.png`;
                }
            }
            
            // 3. Absolute fallback
            if (!finalIcon) {
                finalIcon = 'https://cdn.brawlify.com/game-modes/regular/48000000.png';
            }

            return { ...stats, displayName: mapName, icon: finalIcon, winRate: Math.round((stats.wins / stats.matches) * 100) };
        })
        .sort((a, b) => {
            if (b.winRate === a.winRate) return b.matches - a.matches;
            return b.winRate - a.winRate;
        })
        .slice(0, 3);

    const modesList = document.getElementById('best-modes-list');
    modesList.innerHTML = '';
    sortedModes.forEach(m => {
        modesList.innerHTML += `
            <li style="display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
                <div class="mode-info" style="display: flex; align-items: center; gap: 1rem; flex: 1; min-width: 0;">
                    <div style="width: 44px; height: 44px; border-radius: var(--radius-sm); background-color: rgba(255,255,255,0.05); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0;">
                        <img src="${m.icon || 'https://cdn.brawlify.com/game-modes/regular/Unknown.png'}" style="width: 80%; height: 80%; object-fit: contain;">
                    </div>
                    <div style="min-width: 0;">
                        <strong style="display: block; font-size: 1rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${m.displayName}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted)">${m.matches} matches played</div>
                    </div>
                </div>
                <div class="win-rate-badge" style="text-align: right; min-width: fit-content; flex-shrink: 0; font-size: 1.1rem; color: var(--accent-yellow); line-height: 1.1;">
                    <div style="font-weight: 800;">${m.winRate}%</div>
                    <div style="font-size: 0.7rem; opacity: 0.8; letter-spacing: 1px;">WIN RATE</div>
                </div>
            </li>
        `;
    });
}

function renderAnalyticsBrawlerRows(sortedBrawlers) {
    analyticsBrawlersList.innerHTML = '';
    sortedBrawlers.forEach(b => {
        analyticsBrawlersList.innerHTML += `
            <li>
                <div class="brawler-info">
                    <img src="${b.icon || 'https://via.placeholder.com/40'}" class="brawler-avatar" onerror="this.src='https://via.placeholder.com/40'">
                    <div>
                        <strong>${b.name}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted)">${b.matches} matches (${b.wins}W - ${b.matches - b.wins}L)</div>
                    </div>
                </div>
                <span class="win-rate-badge" style="background-color: ${b.winRate >= 50 ? 'rgba(76, 219, 143, 0.1)' : 'rgba(235, 87, 87, 0.1)'}; color: ${b.winRate >= 50 ? 'var(--color-win)' : 'var(--color-loss)'}">${b.winRate}% WR</span>
            </li>
        `;
    });
}

// Render Analytics Tab (by map, overall, or matchup chart)
function updateAnalyticsData() {
    const mapSection = document.getElementById('analytics-map-section');
    const heading = document.getElementById('analytics-brawlers-heading');
    const matchupPanel = document.getElementById('analytics-matchup-panel');
    const rankedMatches = matches.filter(isRankedMatch);

    if (activeAnalyticsTab === 'matchups') {
        if (mapSection) mapSection.style.display = 'none';
        if (matchupPanel) matchupPanel.style.display = 'block';
        analyticsBrawlersList.style.display = 'none';
        if (heading) heading.textContent = 'Counter Picker (enemy -> your best picks)';
        populateMatchupTargetList(rankedMatches);
        const input = document.getElementById('matchup-target-input');
        const wrap = document.getElementById('matchup-table-container');
        const hasOppData = rankedMatches.some(m => Array.isArray(m.opponentBrawlers) && m.opponentBrawlers.length > 0);
        if (rankedMatches.length === 0 && wrap) {
            wrap.innerHTML = '<p class="empty-state" style="margin:0;">No ranked matches recorded yet.</p>';
        } else if (!hasOppData && wrap) {
            wrap.innerHTML = '<p class="empty-state" style="margin:0;">No synced ranked games include enemy brawler data yet. Run <strong>Sync Now</strong> after playing — matchups are filled from the API battle log.</p>';
        } else if (input && !input.value.trim() && wrap) {
            wrap.innerHTML = '<p class="empty-state" style="margin:0;">Type an enemy brawler name to get your best counter picks.</p>';
        } else if (wrap) {
            renderMatchupTable(rankedMatches);
        }
        return;
    }

    if (matchupPanel) matchupPanel.style.display = 'none';
    analyticsBrawlersList.style.display = '';

    if (activeAnalyticsTab === 'overall') {
        if (mapSection) mapSection.style.display = 'none';
        if (heading) heading.textContent = 'Overall win rate by brawler (all ranked maps)';

        if (rankedMatches.length === 0) {
            analyticsBrawlersList.innerHTML = '<li class="empty-state">No ranked matches recorded yet.</li>';
            return;
        }

        const brawlerStats = {};
        rankedMatches.forEach(m => {
            const key = brawlerStatsKey(m);
            if (!brawlerStats[key]) {
                brawlerStats[key] = { name: m.brawlerName, icon: m.brawlerIcon, matches: 0, wins: 0 };
            }
            brawlerStats[key].matches++;
            if (m.result === 'win') brawlerStats[key].wins++;
        });

        const sortedBrawlers = Object.values(brawlerStats)
            .map(b => ({ ...b, winRate: Math.round((b.wins / b.matches) * 100) }))
            .sort((a, b) => {
                if (b.winRate !== a.winRate) return b.winRate - a.winRate;
                return b.matches - a.matches;
            });

        renderAnalyticsBrawlerRows(sortedBrawlers);
        return;
    }

    if (mapSection) mapSection.style.display = '';
    if (heading) heading.textContent = 'Brawler performance (this map)';

    if (!selectedAnalyticsMap) {
        analyticsBrawlersList.innerHTML = '<li class="empty-state">Select a map above to see brawler win rates.</li>';
        return;
    }

    const mapMatches = rankedMatches.filter(m => matchesAnalyticsMap(m, selectedAnalyticsMap));
    const allOnMap = matches.filter(m => matchesAnalyticsMap(m, selectedAnalyticsMap));
    const excludedOnMap = allOnMap.length - mapMatches.length;

    if (mapMatches.length === 0) {
        const hint = excludedOnMap > 0
            ? `No ranked data for this map (${excludedOnMap} trophy/other match${excludedOnMap === 1 ? '' : 'es'} stored).`
            : 'No data available for this map.';
        analyticsBrawlersList.innerHTML = `<li class="empty-state">${hint}</li>`;
        return;
    }

    if (heading) {
        let title = `Brawler performance (${selectedAnalyticsMap.mapName}) — ${mapMatches.length} ranked match${mapMatches.length === 1 ? '' : 'es'}`;
        if (excludedOnMap > 0) {
            title += ` (${excludedOnMap} trophy excluded)`;
        }
        heading.textContent = title;
    }

    const brawlerStats = {};
    mapMatches.forEach(m => {
        const key = brawlerStatsKey(m);
        if (!brawlerStats[key]) {
            brawlerStats[key] = { name: m.brawlerName, icon: m.brawlerIcon, matches: 0, wins: 0 };
        }
        brawlerStats[key].matches++;
        if (m.result === 'win') brawlerStats[key].wins++;
    });

    const sortedBrawlers = Object.values(brawlerStats)
        .map(b => ({ ...b, winRate: Math.round((b.wins / b.matches) * 100) }))
        .sort((a, b) => {
            if (b.winRate === a.winRate) return b.matches - a.matches;
            return b.winRate - a.winRate;
        });

    renderAnalyticsBrawlerRows(sortedBrawlers);
}

// Render Collection Grid
function renderCollection(brawlersData) {
    if (!brawlersData || brawlersData.length === 0) {
        collectionGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); margin-top: 3rem;">No Brawler data mapped yet. Link an account first!</div>`;
        return;
    }
    
    collectionCount.textContent = `${brawlersData.length} Brawlers Unlocked`;
    
    // Sort logically: Power level descending, then alphabetically
    const sorted = [...brawlersData].sort((a, b) => {
        if (b.power !== a.power) return b.power - a.power;
        return a.name.localeCompare(b.name);
    });
    
    collectionGrid.innerHTML = '';

    // --- HD Portrait System ---
    // Brawltime.ninja serves 4x higher-res portraits than brawlify CDN.
    // However, 5 brawlers return empty 0-byte PNGs (200 status with no data).
    // For those, we skip HD entirely and go straight to the brawlify fallback.
    const BRAWLTIME_MISSING = new Set([
        '8-BIT', '8_BIT', '8BIT',
        'R-T', 'R_T', 'RT',
        'MR-P', 'MR_P', 'MR P', 'MR. P', 'MRP',
        'LARRY-LAWRIE', 'LARRY & LAWRIE', 'LARRY AND LAWRIE',
        'JAE-YONG', 'JAE_YONG', 'JAEYONG'
    ]);

    const SLUG_OVERRIDES = {
        'EL PRIMO': 'el_primo',
        'EL-PRIMO': 'el_primo',
        'BUZZ LIGHTYEAR': 'buzz_lightyear',
        'BUZZ-LIGHTYEAR': 'buzz_lightyear',
    };

    function toBrawltimeSlug(name) {
        const upper = name.toUpperCase().trim();
        if (SLUG_OVERRIDES[upper]) return SLUG_OVERRIDES[upper];
        return name.toLowerCase().trim()
            .replace(/[\s\-\.]+/g, '_')
            .replace(/[^a-z0-9_]/g, '');
    }

    function getPortraitUrl(name, globalBrawler) {
        const upper = name.toUpperCase().trim();
        // If this brawler is known to be missing on brawltime, skip HD entirely
        if (BRAWLTIME_MISSING.has(upper)) {
            return globalBrawler ? (globalBrawler.imageUrl2 || globalBrawler.imageUrl || '') : '';
        }
        const slug = toBrawltimeSlug(name);
        return `https://media.brawltime.ninja/brawlers/${slug}/avatar.png`;
    }

    const normalizeStr = str => String(str || '').toUpperCase().replace(/[\s\-\.]+/g, '').replace(/[^A-Z0-9]/g, '');

    /** Official player `gears` include `id`; Brawlify CDN mirrors game assets (see github.com/Brawlify/CDN). */
    function resolveGearIconUrl(gear, globalBrawler) {
        if (!gear) return null;
        const gid = gear.id != null ? Number(gear.id) : NaN;
        if (Number.isFinite(gid) && gid > 0) {
            return `https://cdn.brawlify.com/gears/regular/${gid}.png`;
        }
        if (gear.name && globalBrawler && Array.isArray(globalBrawler.gears)) {
            const m = globalBrawler.gears.find(g => normalizeStr(g.name) === normalizeStr(gear.name));
            if (m) {
                if (m.imageUrl) return m.imageUrl;
                const mid = m.id != null ? Number(m.id) : NaN;
                if (Number.isFinite(mid) && mid > 0) return `https://cdn.brawlify.com/gears/regular/${mid}.png`;
            }
        }
        return null;
    }

    function gearSlotHtml(active, imageUrl) {
        const ringClass = active ? 'gear-active' : 'gear-locked';
        if (imageUrl) {
            const safe = String(imageUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            return `<div class="gear-ring ${ringClass}"><img src="${safe}" class="gear-icon-img" alt="" loading="lazy" decoding="async" onerror="this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='block';"><div class="gear-inner" style="display:none"></div></div>`;
        }
        return `<div class="gear-ring ${ringClass}"><div class="gear-inner"></div></div>`;
    }
    
    sorted.forEach(b => {
        const normalizedPlayerName = normalizeBrawlerName(b.name);
        const globalBrawler = brawlers.find(gb => normalizeBrawlerName(gb.name) === normalizedPlayerName);
        const properName = globalBrawler ? globalBrawler.name : b.name;

        // Smart portrait URL: HD if available, fallback to brawlify
        const portraitUrl = getPortraitUrl(properName, globalBrawler);
        const fallbackUrl = resolveBrawlerIconUrl(b, globalBrawler);
        
        // Safety checks for API arrays
        const gCount = b.gadgets ? b.gadgets.length : 0;
        const spCount = b.starPowers ? b.starPowers.length : 0;
        const gearCount = b.gears ? b.gears.length : 0;

        // Try to map exact item graphics via normalized matching
        let gImage = null;
        if (gCount > 0 && b.gadgets[0] && globalBrawler && globalBrawler.gadgets) {
            const match = globalBrawler.gadgets.find(g => normalizeStr(g.name) === normalizeStr(b.gadgets[0].name));
            if (match) gImage = match.imageUrl;
        }

        let spImage = null;
        if (spCount > 0 && b.starPowers[0] && globalBrawler && globalBrawler.starPowers) {
            const match = globalBrawler.starPowers.find(sp => normalizeStr(sp.name) === normalizeStr(b.starPowers[0].name));
            if (match) spImage = match.imageUrl;
        }
        
        // Create Hero Card
        const card = document.createElement('div');
        card.className = 'brawler-hero-card';
        if (b.hasHypercharge) card.classList.add('hypercharged-card');
        if (b.power === 11) card.classList.add('maxed-card');
        
        // Revised Level Indicator
        const levelVisual = b.power === 11 
            ? `<div class="level-max-indicator">
                 MAX
                 <div class="level-max-glow"></div>
               </div>`
            : `<div class="level-number-indicator">
                    <span>${b.power}</span>
               </div>`;
        
        let gadgetNode = gImage 
            ? `<img src="${gImage}" class="stat-icon-img" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><div class="gadget-fallback" style="display:none; width: 14px; height: 14px; background: ${gCount > 0 ? '#1ada46' : '#111'}; border: 2px solid ${gCount > 0 ? '#0e8a2a' : '#000'}; transform: rotate(45deg);"></div>`
            : `<div style="width: 14px; height: 14px; background: ${gCount > 0 ? '#1ada46' : '#111'}; border: 2px solid ${gCount > 0 ? '#0e8a2a' : '#000'}; transform: rotate(45deg); box-shadow: 0 2px 4px rgba(0,0,0,0.5);"></div>`;

        let spNode = spImage 
            ? `<img src="${spImage}" class="stat-icon-img sp-icon" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><svg class="sp-fallback" style="display:none; width: 24px; height: 24px; color: ${spCount > 0 ? '#FFD700' : '#111'};" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`
            : `<svg style="width: 24px; height: 24px; color: ${spCount > 0 ? '#FFD700' : '#111'}; filter: drop-shadow(0 2px 2px rgba(0,0,0,0.5));" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;

        const g1Active = gearCount >= 1;
        const g2Active = gearCount >= 2;
        const gear1Url = gearCount >= 1 && b.gears[0] ? resolveGearIconUrl(b.gears[0], globalBrawler) : null;
        const gear2Url = gearCount >= 2 && b.gears[1] ? resolveGearIconUrl(b.gears[1], globalBrawler) : null;

        // Build the portrait with an onload check for empty 0-byte responses
        const escapedFallback = fallbackUrl.replace(/'/g, "\\'");

        card.innerHTML = `
            <!-- Top Portrait -->
            <div class="brawler-portrait-wrap" ${b.hasHypercharge ? 'style="animation: hyperPulse 1.5s infinite alternate;"' : ''}>
                <!-- Trophy Badge -->
                <div class="trophy-tag">
                    <img src="https://media.brawltime.ninja/assets/icon/trophy.png" class="trophy-img" alt="Trophies">
                    <span class="trophy-count">${b.trophies || 0}</span>
                </div>

                <img src="${portraitUrl}" 
                     class="brawler-portrait-img" 
                     alt="${properName}"
                     onload="if(this.naturalWidth<2||this.naturalHeight<2){this.src='${escapedFallback}';this.onload=null;}"
                     onerror="this.src='${escapedFallback}'; this.onerror=null;"
                     loading="lazy">
                ${b.hasHypercharge ? '<div class="hyper-badge">HYPER</div>' : ''}
                <div class="brawler-name-label">${properName}</div>
            </div>
            
            <!-- Bottom Stats Bar -->
            <div class="brawler-stats-bar">
                ${levelVisual}
                
                <div class="brawler-stat-icons">
                    ${gadgetNode}
                    ${spNode}
                    ${gearSlotHtml(g1Active, gear1Url)}
                    ${gearSlotHtml(g2Active, gear2Url)}
                </div>
            </div>
        `;
        collectionGrid.appendChild(card);
    });
}

// --- General Strategy & Tier Lists ---
const GUIDE_NOTES_KEY = 'brawl_guide_notes_v1';
const GUIDE_TIERLISTS_KEY = 'brawl_guide_tierlists_v1';
const GUIDE_DEFAULT_TIERS = [
    { label: 'S', color: '#ff4757' },
    { label: 'A', color: '#ffa502' },
    { label: 'B', color: '#eccc68' },
    { label: 'C', color: '#7bed9f' },
    { label: 'D', color: '#70a1ff' }
];

let guideTierLists = [];
let guideActiveTierListId = null;
let guideSelectedTierId = null;
let guideActiveTab = 'notes';
let guideNotesSaveTimer = null;
let guideTierSaveTimer = null;
let guideStrategyInitialized = false;

function isGuideViewActive() {
    return document.getElementById('guide')?.classList.contains('active') ?? false;
}

function guideNewId() {
    return `g_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function loadGuideTierLists() {
    try {
        const raw = JSON.parse(localStorage.getItem(GUIDE_TIERLISTS_KEY) || '{"lists":[]}');
        guideTierLists = (Array.isArray(raw.lists) ? raw.lists : []).map(list => ({
            ...list,
            tiers: Array.isArray(list.tiers) ? list.tiers.map(t => ({
                ...t,
                brawlers: Array.isArray(t.brawlers) ? t.brawlers : []
            })) : []
        }));
    } catch {
        guideTierLists = [];
    }
}

async function ensureGuideBrawlersLoaded() {
    return fetchBrawlersOnce();
}

function saveGuideTierListsToStorage() {
    localStorage.setItem(GUIDE_TIERLISTS_KEY, JSON.stringify({ lists: guideTierLists }));
}

function loadGuideNotesIntoForm() {
    const titleEl = document.getElementById('guide-notes-title');
    const bodyEl = document.getElementById('guide-notes-body');
    if (!titleEl || !bodyEl) return;
    try {
        const data = JSON.parse(localStorage.getItem(GUIDE_NOTES_KEY) || '{}');
        titleEl.value = data.title || '';
        bodyEl.value = data.body || '';
    } catch {
        titleEl.value = '';
        bodyEl.value = '';
    }
    setGuideNotesStatus('saved');
}

function saveGuideNotes(showFlash = true) {
    const titleEl = document.getElementById('guide-notes-title');
    const bodyEl = document.getElementById('guide-notes-body');
    if (!titleEl || !bodyEl) return;
    localStorage.setItem(GUIDE_NOTES_KEY, JSON.stringify({
        title: titleEl.value.trim(),
        body: bodyEl.value,
        updatedAt: new Date().toISOString()
    }));
    if (showFlash) setGuideNotesStatus('saved');
}

function setGuideNotesStatus(state) {
    const el = document.getElementById('guide-notes-status');
    if (!el) return;
    if (state === 'saved') {
        el.textContent = 'Saved';
        el.classList.remove('unsaved');
    } else {
        el.textContent = 'Unsaved';
        el.classList.add('unsaved');
    }
}

function setGuideTierListStatus(state) {
    const el = document.getElementById('guide-tierlist-status');
    if (!el) return;
    if (state === 'saved') {
        el.textContent = 'Saved';
        el.classList.remove('unsaved');
    } else {
        el.textContent = 'Unsaved';
        el.classList.add('unsaved');
    }
}

function getActiveGuideTierList() {
    return guideTierLists.find(t => t.id === guideActiveTierListId) || null;
}

function createDefaultTierList(name = 'New tier list') {
    return {
        id: guideNewId(),
        name,
        tiers: GUIDE_DEFAULT_TIERS.map(t => ({
            id: guideNewId(),
            label: t.label,
            color: t.color,
            brawlers: []
        })),
        updatedAt: new Date().toISOString()
    };
}

function brawlerChipPayload(b) {
    return {
        id: Number(b.id),
        name: b.name,
        icon: b.imageUrl || b.imageUrl2 || brawlifyBrawlerIconUrl(b.id)
    };
}

function findBrawlerInAllTiers(list, brawlerId) {
    for (const tier of list.tiers) {
        const idx = tier.brawlers.findIndex(x => Number(x.id) === Number(brawlerId));
        if (idx >= 0) return { tier, idx };
    }
    return null;
}

function addBrawlerToTier(list, tierId, payload) {
    const existing = findBrawlerInAllTiers(list, payload.id);
    if (existing) existing.tier.brawlers.splice(existing.idx, 1);
    const tier = list.tiers.find(t => t.id === tierId);
    if (!tier) return;
    if (!tier.brawlers.some(x => Number(x.id) === Number(payload.id))) {
        tier.brawlers.push(payload);
    }
    list.updatedAt = new Date().toISOString();
    scheduleGuideTierSave();
    renderGuideTierListEditor();
    renderGuideBrawlerPool();
}

function scheduleGuideNotesSave() {
    setGuideNotesStatus('unsaved');
    clearTimeout(guideNotesSaveTimer);
    guideNotesSaveTimer = setTimeout(() => saveGuideNotes(true), 800);
}

function scheduleGuideTierSave() {
    setGuideTierListStatus('unsaved');
    clearTimeout(guideTierSaveTimer);
    guideTierSaveTimer = setTimeout(() => {
        saveGuideTierListsToStorage();
        setGuideTierListStatus('saved');
        renderGuideTierListNav();
    }, 400);
}

function applyGuideTabPanels() {
    document.querySelectorAll('.guide-sub-tab').forEach(btn => {
        const active = btn.dataset.guideTab === guideActiveTab;
        btn.classList.toggle('active', active);
        const ind = btn.querySelector('.guide-tab-indicator');
        if (ind) ind.style.display = active ? 'block' : 'none';
    });
    document.getElementById('guide-notes-panel')?.classList.toggle('active', guideActiveTab === 'notes');
    document.getElementById('guide-tierlists-panel')?.classList.toggle('active', guideActiveTab === 'tierlists');
}

window.switchGuideTab = function(tabName) {
    if (tabName !== 'notes' && tabName !== 'tierlists') return;
    guideActiveTab = tabName;
    applyGuideTabPanels();
    renderGuideView();
};

function renderGuideTierListNav() {
    const nav = document.getElementById('guide-tierlist-nav');
    if (!nav) return;
    nav.innerHTML = '';
    if (guideTierLists.length === 0) {
        nav.innerHTML = '<li style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem;">No lists yet</li>';
        return;
    }
    guideTierLists.forEach(list => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = list.name || 'Untitled';
        btn.classList.toggle('active', list.id === guideActiveTierListId);
        btn.addEventListener('click', () => {
            guideActiveTierListId = list.id;
            guideSelectedTierId = list.tiers[0]?.id || null;
            renderGuideTierListNav();
            renderGuideTierListEditor();
        });
        li.appendChild(btn);
        nav.appendChild(li);
    });
}

function renderGuideBrawlerChip(b, tierId, list) {
    const chip = document.createElement('div');
    chip.className = 'guide-brawler-chip';
    chip.draggable = true;
    chip.dataset.brawlerId = String(b.id);
    chip.dataset.tierId = tierId;
    chip.innerHTML = `
        <img src="${b.icon || brawlifyBrawlerIconUrl(b.id)}" alt="" onerror="this.src='https://via.placeholder.com/28'">
        <span>${b.name}</span>
        <button type="button" class="chip-remove" title="Remove">&times;</button>
    `;
    chip.addEventListener('dragstart', e => {
        e.dataTransfer.setData('application/json', JSON.stringify({ brawlerId: b.id, fromTierId: tierId }));
        e.dataTransfer.effectAllowed = 'move';
    });
    chip.querySelector('.chip-remove').addEventListener('click', e => {
        e.stopPropagation();
        const tier = list.tiers.find(t => t.id === tierId);
        if (!tier) return;
        tier.brawlers = tier.brawlers.filter(x => Number(x.id) !== Number(b.id));
        scheduleGuideTierSave();
        renderGuideTierListEditor();
        renderGuideBrawlerPool();
    });
    return chip;
}

function renderGuideTierListEditor() {
    const emptyEl = document.getElementById('guide-tierlist-empty');
    const activeWrap = document.getElementById('guide-tierlist-active');
    const rowsEl = document.getElementById('guide-tier-rows');
    const nameInput = document.getElementById('guide-tierlist-name');
    const list = getActiveGuideTierList();
    if (!emptyEl || !activeWrap || !rowsEl) return;

    if (!list) {
        emptyEl.style.display = 'flex';
        activeWrap.style.display = 'none';
        return;
    }
    emptyEl.style.display = 'none';
    activeWrap.style.display = 'flex';
    if (nameInput && nameInput !== document.activeElement) nameInput.value = list.name || '';

    rowsEl.innerHTML = '';
    list.tiers.forEach(tier => {
        const row = document.createElement('div');
        row.className = 'guide-tier-row' + (tier.id === guideSelectedTierId ? ' selected' : '');
        row.dataset.tierId = tier.id;

        const labelWrap = document.createElement('div');
        labelWrap.className = 'guide-tier-label-wrap';
        const labelInput = document.createElement('input');
        labelInput.className = 'guide-tier-label-input';
        labelInput.value = tier.label;
        labelInput.maxLength = 4;
        labelInput.addEventListener('click', e => e.stopPropagation());
        labelInput.addEventListener('input', () => {
            tier.label = labelInput.value;
            scheduleGuideTierSave();
        });
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'guide-tier-color';
        colorInput.value = tier.color || '#70a1ff';
        colorInput.addEventListener('click', e => e.stopPropagation());
        colorInput.addEventListener('input', () => {
            tier.color = colorInput.value;
            row.style.borderLeftColor = tier.color;
            scheduleGuideTierSave();
        });
        labelWrap.appendChild(labelInput);
        labelWrap.appendChild(colorInput);

        const drop = document.createElement('div');
        drop.className = 'guide-tier-drop';
        drop.style.borderLeft = `4px solid ${tier.color || '#70a1ff'}`;
        tier.brawlers.forEach(b => drop.appendChild(renderGuideBrawlerChip(b, tier.id, list)));

        row.addEventListener('click', () => {
            guideSelectedTierId = tier.id;
            document.querySelectorAll('.guide-tier-row').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');
        });

        ['dragenter', 'dragover'].forEach(evt => {
            drop.addEventListener(evt, e => {
                e.preventDefault();
                row.classList.add('drag-over');
            });
        });
        drop.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        drop.addEventListener('drop', e => {
            e.preventDefault();
            row.classList.remove('drag-over');
            try {
                const data = JSON.parse(e.dataTransfer.getData('application/json'));
                const gb = brawlers.find(x => Number(x.id) === Number(data.brawlerId));
                const payload = gb ? brawlerChipPayload(gb) : { id: data.brawlerId, name: `Brawler ${data.brawlerId}`, icon: brawlifyBrawlerIconUrl(data.brawlerId) };
                addBrawlerToTier(list, tier.id, payload);
            } catch { /* ignore */ }
        });

        const actions = document.createElement('div');
        actions.className = 'guide-tier-row-actions';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'guide-tier-remove-btn';
        removeBtn.title = 'Remove tier row';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (list.tiers.length <= 1) return;
            if (!confirm('Remove this tier row? Brawlers in it will be unranked in the pool.')) return;
            list.tiers = list.tiers.filter(t => t.id !== tier.id);
            if (guideSelectedTierId === tier.id) guideSelectedTierId = list.tiers[0]?.id || null;
            scheduleGuideTierSave();
            renderGuideTierListEditor();
            renderGuideBrawlerPool();
        });
        actions.appendChild(removeBtn);

        row.appendChild(labelWrap);
        row.appendChild(drop);
        row.appendChild(actions);
        rowsEl.appendChild(row);
    });
}

async function renderGuideBrawlerPool() {
    const pool = document.getElementById('guide-brawler-pool');
    const searchEl = document.getElementById('guide-brawler-search');
    if (!pool || !isGuideViewActive() || guideActiveTab !== 'tierlists') return;
    const query = (searchEl?.value || '').toLowerCase().trim();
    const list = getActiveGuideTierList();
    const placedIds = new Set();
    if (list) {
        list.tiers.forEach(t => t.brawlers.forEach(b => placedIds.add(Number(b.id))));
    }

    pool.innerHTML = '';
    if (!brawlers.length) {
        pool.innerHTML = '<p class="guide-pool-empty">Loading brawlers…</p>';
        const ok = await ensureGuideBrawlersLoaded();
        if (!brawlers.length) {
            pool.innerHTML = ok
                ? '<p class="guide-pool-empty">No brawlers returned from API.</p>'
                : '<p class="guide-pool-empty">Could not load brawlers. Open via Vercel/Netlify or run the local proxy (Launch.bat).</p>';
            return;
        }
        pool.innerHTML = '';
    }
    if (!list) {
        pool.innerHTML = '<p class="guide-pool-empty">Select or create a tier list first.</p>';
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'guide-brawler-pool-grid';
    const filtered = brawlers.filter(b => !query || b.name.toLowerCase().includes(query));

    filtered.forEach(b => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'guide-pool-item';
        item.title = placedIds.has(Number(b.id)) ? `${b.name} (move from current tier)` : b.name;
        item.innerHTML = `
            <img src="${b.imageUrl || brawlifyBrawlerIconUrl(b.id)}" alt="" onerror="this.src='https://via.placeholder.com/36'">
            <span>${b.name}</span>
        `;
        item.addEventListener('click', () => {
            if (!guideSelectedTierId) {
                guideSelectedTierId = list.tiers[0]?.id || null;
            }
            if (!guideSelectedTierId) return;
            addBrawlerToTier(list, guideSelectedTierId, brawlerChipPayload(b));
        });
        grid.appendChild(item);
    });

    if (filtered.length === 0) {
        pool.innerHTML = '<p class="guide-pool-empty">No brawlers match your search.</p>';
        return;
    }
    pool.appendChild(grid);
}

function renderGuideView() {
    if (!document.getElementById('guide')) return;
    applyGuideTabPanels();
    loadGuideNotesIntoForm();
    renderGuideTierListNav();
    renderGuideTierListEditor();
    if (guideActiveTab === 'tierlists') {
        renderGuideBrawlerPool();
    }
}

function initGuideStrategy() {
    if (!document.getElementById('guide')) return;
    if (guideStrategyInitialized) return;
    guideStrategyInitialized = true;

    loadGuideTierLists();
    loadGuideNotesIntoForm();

    if (guideTierLists.length > 0 && !guideActiveTierListId) {
        guideActiveTierListId = guideTierLists[0].id;
        guideSelectedTierId = guideTierLists[0].tiers[0]?.id || null;
    }

    const subTabs = document.querySelector('.guide-sub-tabs');
    if (subTabs && !subTabs.dataset.guideWired) {
        subTabs.dataset.guideWired = '1';
        subTabs.addEventListener('click', e => {
            const btn = e.target.closest('.guide-sub-tab');
            if (!btn?.dataset.guideTab) return;
            switchGuideTab(btn.dataset.guideTab);
        });
    }

    document.getElementById('guide-notes-save-btn')?.addEventListener('click', () => saveGuideNotes(true));
    document.getElementById('guide-notes-title')?.addEventListener('input', scheduleGuideNotesSave);
    document.getElementById('guide-notes-body')?.addEventListener('input', scheduleGuideNotesSave);

    document.getElementById('guide-new-tierlist-btn')?.addEventListener('click', () => {
        const list = createDefaultTierList(`Tier list ${guideTierLists.length + 1}`);
        guideTierLists.unshift(list);
        guideActiveTierListId = list.id;
        guideSelectedTierId = list.tiers[0]?.id || null;
        saveGuideTierListsToStorage();
        switchGuideTab('tierlists');
        renderGuideView();
    });

    document.getElementById('guide-tierlist-name')?.addEventListener('input', e => {
        const list = getActiveGuideTierList();
        if (!list) return;
        list.name = e.target.value;
        scheduleGuideTierSave();
        renderGuideTierListNav();
    });

    document.getElementById('guide-add-tier-btn')?.addEventListener('click', () => {
        const list = getActiveGuideTierList();
        if (!list) return;
        list.tiers.push({ id: guideNewId(), label: '?', color: '#a4b0be', brawlers: [] });
        scheduleGuideTierSave();
        renderGuideTierListEditor();
    });

    document.getElementById('guide-delete-tierlist-btn')?.addEventListener('click', () => {
        const list = getActiveGuideTierList();
        if (!list) return;
        if (!confirm(`Delete tier list "${list.name}"?`)) return;
        guideTierLists = guideTierLists.filter(t => t.id !== list.id);
        guideActiveTierListId = guideTierLists[0]?.id || null;
        guideSelectedTierId = guideTierLists[0]?.tiers[0]?.id || null;
        saveGuideTierListsToStorage();
        renderGuideView();
    });

    document.getElementById('guide-brawler-search')?.addEventListener('input', renderGuideBrawlerPool);
}

// Start app
init();
