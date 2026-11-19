export const SCOPES = [
  'user-read-playback-state', 'user-read-currently-playing',
  'user-modify-playback-state', 'user-library-read', 'user-library-modify',
  'playlist-read-private', 'playlist-modify-private', 'playlist-modify-public',
].join(' ');

export const STORAGE = {
  client: 'spotifyp-client-id', auth: 'spotifyp-auth-v1',
  transaction: 'spotifyp-pkce-v1', backup: 'spotifyp-playlist-backup-v1',
};

export class SpotifyError extends Error {
  constructor(message, status = 0, retryAfter = 0) {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function abortError() {
  return new DOMException('Operazione fermata.', 'AbortError');
}

export function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const finish = () => { signal?.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function createAuthorization(clientId, redirectUri, storage = sessionStorage) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  storage.setItem(STORAGE.transaction, JSON.stringify({ verifier, state, redirectUri, created: Date.now() }));
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri,
    scope: SCOPES, state, code_challenge_method: 'S256', code_challenge: base64url(new Uint8Array(digest)),
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

export function validateCallback(state, storage = sessionStorage, now = Date.now()) {
  const transaction = JSON.parse(storage.getItem(STORAGE.transaction) || 'null');
  storage.removeItem(STORAGE.transaction);
  if (!transaction || !state || transaction.state !== state || now - transaction.created > 600_000) {
    throw new Error('Il collegamento è scaduto. Premi di nuovo Collega Spotify.');
  }
  return transaction;
}

export function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLocaleLowerCase('it').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function trackOf(item) { return item?.item || item?.track || null; }
export function itemUri(item) {
  const track = trackOf(item);
  return track?.linked_from?.uri || track?.uri || null;
}
export function trackKey(track) {
  if (!track?.name || !track.artists?.length || track.type === 'episode') return null;
  const artists = [...new Set(track.artists.map(artist => normalize(artist.name)).filter(Boolean))].sort();
  const title = normalize(track.name);
  return title && artists.length ? JSON.stringify([title, artists]) : null;
}

export function analyzeDuplicates(items) {
  const groups = new Map();
  items.forEach((item, position) => {
    const track = trackOf(item);
    const key = trackKey(track);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { key, title: track.name, artists: track.artists.map(a => a.name).join(', '), copies: [] });
    groups.get(key).copies.push({ position, uri: itemUri(item), track });
  });
  return [...groups.values()].filter(group => group.copies.length > 1)
    .sort((a, b) => b.copies.length - a.copies.length || a.title.localeCompare(b.title, 'it'));
}

export function makeDedupPlan(items, selectedKeys) {
  const selected = new Set(selectedKeys);
  const seen = new Set();
  const original = [];
  const target = [];
  for (const item of items) {
    const uri = itemUri(item);
    if (!/^spotify:(track|episode):[A-Za-z0-9]+$/.test(uri || '') || item.is_local || trackOf(item)?.is_local) {
      throw new Error('La playlist contiene un elemento non disponibile o un file locale. Per conservarlo, la pulizia automatica è sospesa.');
    }
    original.push(uri);
    const key = trackKey(trackOf(item));
    if (selected.has(key)) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    target.push(uri);
  }
  return { original, target, removed: original.length - target.length };
}

export function sameList(a, b) { return a.length === b.length && a.every((item, index) => item === b[index]); }
export function isPrefix(prefix, list) { return prefix.length <= list.length && prefix.every((item, index) => item === list[index]); }

export function advanceListening(previous, playback, now) {
  const track = playback?.item;
  if (!playback?.is_playing || track?.type !== 'track' || !track.id) return null;
  const position = playback.progress_ms;
  if (!Number.isFinite(position)) return null;
  const fresh = { id: track.id, device: playback.device?.id || '', position, at: now, listened: 0 };
  if (!previous || previous.id !== fresh.id || previous.device !== fresh.device) return fresh;
  const elapsed = now - previous.at;
  const progress = position - previous.position;
  // A pause, seek, restart or browser suspension requires a new continuous interval.
  if (elapsed <= 0 || elapsed > 12_000 || progress < -1500 || progress > elapsed + 4000 || progress < elapsed - 4000) return fresh;
  return { ...fresh, listened: previous.listened + Math.max(0, Math.min(elapsed, progress)) };
}

export class SpotifyClient {
  constructor({ clientId, storage = localStorage, fetcher = fetch, onStatus = () => {} }) {
    this.clientId = clientId;
    this.storage = storage;
    this.fetcher = fetcher;
    this.onStatus = onStatus;
    this.refreshing = null;
  }
  tokens() { return JSON.parse(this.storage.getItem(STORAGE.auth) || 'null'); }
  saveTokens(value) {
    const previous = this.tokens();
    if (!value.access_token) throw new Error('Autorizzazione Spotify incompleta. Ricollega il tuo account.');
    this.storage.setItem(STORAGE.auth, JSON.stringify({
      access_token: value.access_token,
      refresh_token: value.refresh_token || previous?.refresh_token,
      expires_at: Date.now() + value.expires_in * 1000,
    }));
  }
  async tokenRequest(body) {
    const response = await this.fetcher('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 400) this.storage.removeItem(STORAGE.auth);
      throw new SpotifyError('Spotify non ha completato l’accesso. Controlla Client ID e indirizzo di ritorno, poi ricollega l’account.', response.status);
    }
    this.saveTokens(data);
  }
  async exchange(code, transaction) {
    await this.tokenRequest({ client_id: this.clientId, grant_type: 'authorization_code', code,
      redirect_uri: transaction.redirectUri, code_verifier: transaction.verifier });
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    const token = this.tokens()?.refresh_token;
    if (!token) throw new Error('Premi Collega Spotify per autorizzare l’app.');
    this.refreshing = this.tokenRequest({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: token });
    try { await this.refreshing; } finally { this.refreshing = null; }
  }
  async waitForRetry(seconds, signal) {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      this.onStatus(`Spotify chiede una pausa. Riprendo tra ${Math.ceil((until - Date.now()) / 1000)} s.`);
      await sleep(Math.min(1000, until - Date.now()), signal);
    }
  }
  async request(path, { method = 'GET', body, signal, retryRead = true, retryRate = true } = {}) {
    if (!this.tokens()) throw new Error('Collega prima il tuo account Spotify.');
    if (this.tokens().expires_at < Date.now() + 30_000) await this.refresh();
    let refreshed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted();
      const headers = { Authorization: `Bearer ${this.tokens().access_token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await this.fetcher(`https://api.spotify.com/v1/${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
      if (response.status === 401 && !refreshed) { await this.refresh(); refreshed = true; attempt--; continue; }
      const temporary = (response.status === 429 && retryRate) || (method === 'GET' && retryRead && [500, 502, 503, 504].includes(response.status));
      if (temporary && attempt < 4) {
        const header = Number(response.headers.get('Retry-After'));
        const delay = Number.isFinite(header) && header > 0 ? Math.ceil(header) : Math.min(60, 5 * 2 ** attempt);
        await this.waitForRetry(delay, signal);
        continue;
      }
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).error?.message || ''; } catch {}
        const message = response.status === 403 ? 'Spotify ha negato l’operazione. Controlla i permessi dell’app e i requisiti del tuo account.'
          : response.status === 404 ? 'Spotify non trova la risorsa o un dispositivo attivo. Avvia una canzone su Spotify.'
          : response.status === 429 ? 'Spotify richiede ancora una pausa. Riprova più tardi.'
          : `Spotify ha risposto con errore ${response.status}. ${detail}`;
        const retryAfter = Number(response.headers.get('Retry-After'));
        throw new SpotifyError(message, response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 0);
      }
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  }
  async all(path, signal, onProgress = () => {}) {
    const items = [];
    let next = path;
    while (next) {
      const page = await this.request(next, { signal });
      items.push(...page.items);
      onProgress(items.length, page.total);
      next = page.next ? page.next.replace('https://api.spotify.com/v1/', '') : null;
      if (next) await sleep(180, signal);
    }
    return items;
  }
  async ownPlaylist(userId, create, signal) {
    const playlists = await this.all('me/playlists?limit=50', signal);
    const matches = playlists.filter(playlist => playlist?.owner?.id === userId && playlist.name?.trim().toLocaleLowerCase('it') === 'miei brani');
    if (matches.length > 1) throw new Error('Hai più playlist chiamate “Miei brani”. Rinomina quelle extra e riprova.');
    if (matches.length) return matches[0];
    if (!create) throw new Error('La tua playlist “Miei brani” non è stata trovata. Puoi crearla con Copia preferiti.');
    return this.request('me/playlists', { method: 'POST', body: { name: 'Miei brani', public: false }, signal });
  }
  async playlistSnapshot(id, signal) {
    return (await this.request(`playlists/${id}?fields=snapshot_id`, { signal })).snapshot_id;
  }
  async readPlaylist(id, signal, onProgress) {
    const before = await this.playlistSnapshot(id, signal);
    const items = await this.all(`playlists/${id}/items?limit=50`, signal, onProgress);
    const after = await this.playlistSnapshot(id, signal);
    if (before !== after) throw new Error('La playlist è cambiata durante la lettura. Ripeti l’operazione.');
    return { id, snapshot: after, items };
  }
}

// Supported PUT/POST playlist API, with a durable plan and reconciliation after unknown outcomes.
// It avoids relying on the undocumented removal of individual URI positions.
export async function applyPlaylistPlan(client, plan, { signal, save, onProgress = () => {} }) {
  const initial = await client.readPlaylist(plan.id, signal);
  let current = initial.items.map(itemUri);
  let snapshot = initial.snapshot;
  if (sameList(current, plan.target)) { save({ ...plan, complete: true }); return; }
  if (!isPrefix(current, plan.target) && (!sameList(current, plan.original) || snapshot !== plan.originalSnapshot)) {
    throw new Error('La playlist è stata modificata. Il backup è conservato. Controlla la playlist prima di riprendere.');
  }
  save({ ...plan, complete: false });
  let replace = sameList(current, plan.original);
  let failures = 0;
  while (replace || current.length < plan.target.length) {
    signal?.throwIfAborted();
    if (await client.playlistSnapshot(plan.id, signal) !== snapshot) {
      throw new Error('La playlist è cambiata durante la pulizia. Il backup e il piano sono conservati per il recupero.');
    }
    const start = replace ? 0 : current.length;
    const chunk = plan.target.slice(start, start + 100);
    try {
      const response = await client.request(`playlists/${plan.id}/items`, {
        method: replace ? 'PUT' : 'POST', body: { uris: chunk }, signal, retryRate: false,
      });
      snapshot = response?.snapshot_id;
      if (!snapshot) throw new Error('Risposta Spotify incompleta.');
      current = replace ? chunk : [...current, ...chunk];
      replace = false;
      failures = 0;
      save({ ...plan, complete: false, completedItems: current.length });
      onProgress(current.length, plan.target.length);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.status && ![429, 500, 502, 503, 504].includes(error.status)) throw error;
      if (++failures > 4) throw new Error('Spotify continua a dare errori. Il backup è pronto e puoi riprendere la pulizia.');
      await client.waitForRetry(error.retryAfter || Math.min(60, 5 * 2 ** (failures - 1)), signal);
      const actual = await client.readPlaylist(plan.id, signal);
      current = actual.items.map(itemUri);
      snapshot = actual.snapshot;
      if (isPrefix(current, plan.target)) replace = false;
      else if (sameList(current, plan.original) && snapshot === plan.originalSnapshot) replace = true;
      else throw new Error('L’esito della richiesta richiede un controllo. Il backup è conservato e la playlist è stata lasciata nello stato ricevuto.');
    }
  }
  const verified = await client.readPlaylist(plan.id, signal);
  if (!sameList(verified.items.map(itemUri), plan.target)) throw new Error('La verifica finale non coincide con il piano. Il backup originale è disponibile.');
  save({ ...plan, complete: true });
}
