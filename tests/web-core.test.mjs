import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE, SpotifyClient, SpotifyError, createAuthorization, validateCallback,
  analyzeDuplicates, makeDedupPlan, advanceListening, applyPlaylistPlan,
} from '../core.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function item(id, name = id, artist = 'Artista') {
  return { track: { id, uri: `spotify:track:${id}`, name, type: 'track', artists: [{ name: artist }] } };
}
function playback(id, position, playing = true) {
  return { is_playing: playing, progress_ms: position, item: { id, type: 'track' }, device: { id: 'device' } };
}

test('PKCE uses random state, SHA-256 and an exact redirect, then rejects replay', async () => {
  const memory = storage();
  const redirect = 'https://danielpleba03-dotcom.github.io/spotifapp/';
  const first = new URL(await createAuthorization('a'.repeat(32), redirect, memory));
  const transaction = JSON.parse(memory.getItem(STORAGE.transaction));
  assert.equal(first.searchParams.get('redirect_uri'), redirect);
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(first.searchParams.get('code_challenge').length, 43);
  assert.equal(validateCallback(transaction.state, memory).verifier, transaction.verifier);
  assert.throws(() => validateCallback(transaction.state, memory));
  await createAuthorization('a'.repeat(32), redirect, memory);
  assert.throws(() => validateCallback('wrong', memory));
  assert.equal(memory.getItem(STORAGE.transaction), null);
});

test('selected duplicate groups retain their first copy and keep other items in order', () => {
  const items = [item('a', 'Canzóne'), item('x', 'Altra'), item('a', 'CANZONE'), item('b', 'Canzone'), item('c', 'Terza')];
  const groups = analyzeDuplicates(items);
  assert.equal(groups.length, 1);
  const plan = makeDedupPlan(items, [groups[0].key]);
  assert.deepEqual(plan.target, ['spotify:track:a', 'spotify:track:x', 'spotify:track:c']);
  assert.equal(plan.removed, 2);
  assert.deepEqual(makeDedupPlan(items, []).target, plan.original);
  assert.throws(() => makeDedupPlan([...items, { track: null }], [groups[0].key]));
});

test('two minutes requires observed continuous playback, not wall clock or seeking', () => {
  let listening = advanceListening(null, playback('a', 0), 0);
  for (let time = 4000; time <= 120_000; time += 4000) listening = advanceListening(listening, playback('a', time), time);
  assert.equal(listening.listened, 120_000);
  assert.equal(advanceListening(listening, playback('b', 10_000), 124_000).listened, 0);
  assert.equal(advanceListening(listening, playback('a', 200_000), 124_000).listened, 0);
  assert.equal(advanceListening(listening, playback('a', 0), 124_000).listened, 0);
  assert.equal(advanceListening(listening, playback('a', 180_000), 180_000).listened, 0);
  assert.equal(advanceListening(listening, playback('a', 120_000, false), 124_000), null);
});

class PlaylistMock {
  constructor(uris) {
    this.uris = [...uris];
    this.snapshot = 's0';
    this.calls = [];
    this.failAfterWrite = false;
    this.rejectBeforeWrite = false;
    this.changed = false;
    this.waits = [];
  }
  async readPlaylist() { return { snapshot: this.snapshot, items: this.uris.map(uri => ({ track: { uri } })) }; }
  async playlistSnapshot() { return this.changed ? 'external-change' : this.snapshot; }
  async waitForRetry(seconds) { this.waits.push(seconds); }
  async request(path, options) {
    assert.equal(path, 'playlists/mine/items');
    assert.equal(options.retryRate, false);
    this.calls.push(options.method);
    if (this.rejectBeforeWrite) {
      this.rejectBeforeWrite = false;
      throw new SpotifyError('rate limit', 429, 17);
    }
    if (options.method === 'PUT') this.uris = [...options.body.uris];
    else this.uris.push(...options.body.uris);
    this.snapshot = `s${this.calls.length}`;
    if (this.failAfterWrite) {
      this.failAfterWrite = false;
      throw new SpotifyError('server', 502);
    }
    return { snapshot_id: this.snapshot };
  }
}

function bigPlan() {
  const original = Array.from({ length: 251 }, (_, index) => `spotify:track:t${index}`);
  original.splice(1, 0, original[0]);
  return { id: 'mine', originalSnapshot: 's0', original, target: original.filter((uri, index) => index !== 1) };
}

test('playlist rewrite keeps one of identical URIs and verifies more than 100 retained tracks', async () => {
  const plan = bigPlan();
  const client = new PlaylistMock(plan.original);
  const saved = [];
  await applyPlaylistPlan(client, plan, { save: value => saved.push(value) });
  assert.deepEqual(client.uris, plan.target);
  assert.deepEqual(client.calls, ['PUT', 'POST', 'POST']);
  assert.equal(saved[0].complete, false);
  assert.deepEqual(saved[0].original, plan.original);
  assert.equal(saved.at(-1).complete, true);
});

test('ambiguous success is reconciled before another write, avoiding duplicate appends', async () => {
  const plan = bigPlan();
  const client = new PlaylistMock(plan.original);
  client.failAfterWrite = true;
  await applyPlaylistPlan(client, plan, { save() {} });
  assert.deepEqual(client.uris, plan.target);
  assert.deepEqual(client.calls, ['PUT', 'POST', 'POST']);
});

test('429 waits Retry-After and rereads before retrying a rewrite', async () => {
  const plan = bigPlan();
  const client = new PlaylistMock(plan.original);
  client.rejectBeforeWrite = true;
  await applyPlaylistPlan(client, plan, { save() {} });
  assert.deepEqual(client.waits, [17]);
  assert.deepEqual(client.uris, plan.target);
});

test('resumes partial playlist after a stopped operation without replacing its prefix', async () => {
  const plan = bigPlan();
  const client = new PlaylistMock(plan.target.slice(0, 100));
  client.snapshot = 's3';
  await applyPlaylistPlan(client, plan, { save() {} });
  assert.deepEqual(client.calls, ['POST', 'POST']);
  assert.deepEqual(client.uris, plan.target);
});

test('unrelated playlist changes stop before mutation', async () => {
  const plan = bigPlan();
  const client = new PlaylistMock(['spotify:track:unrelated']);
  await assert.rejects(applyPlaylistPlan(client, plan, { save() {} }));
  assert.equal(client.calls.length, 0);
  const second = new PlaylistMock(plan.original);
  second.changed = true;
  await assert.rejects(applyPlaylistPlan(second, plan, { save() {} }));
  assert.equal(second.calls.length, 0);
});

test('token refresh preserves the refresh token when Spotify returns only a new access token', async () => {
  const memory = storage();
  memory.setItem(STORAGE.auth, JSON.stringify({ access_token: 'old', refresh_token: 'refresh', expires_at: 0 }));
  const calls = [];
  const client = new SpotifyClient({ clientId: 'client', storage: memory, fetcher: async (url, options) => {
    calls.push([url, options]);
    if (url.includes('api/token')) return new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }));
    assert.equal(options.headers.Authorization, 'Bearer new');
    return new Response(JSON.stringify({ id: 'user' }));
  } });
  assert.deepEqual(await client.request('me'), { id: 'user' });
  assert.equal(client.tokens().refresh_token, 'refresh');
  assert.equal(calls.length, 2);
});

test('502 writes are surfaced once rather than silently replayed', async () => {
  const memory = storage();
  memory.setItem(STORAGE.auth, JSON.stringify({ access_token: 'test', expires_at: Date.now() + 3600_000 }));
  let calls = 0;
  const client = new SpotifyClient({ clientId: 'client', storage: memory, fetcher: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'server' } }), { status: 502 });
  } });
  await assert.rejects(client.request('playlists/mine/items', { method: 'POST', body: { uris: ['spotify:track:a'] } }), error => error.status === 502);
  assert.equal(calls, 1);
});
