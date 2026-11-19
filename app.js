import {
  STORAGE, SpotifyClient, SpotifyError, sleep, createAuthorization, validateCallback,
  trackOf, itemUri, analyzeDuplicates, makeDedupPlan, advanceListening, applyPlaylistPlan,
} from './core.js';
import { DEFAULT_CLIENT_ID } from './config.js';

const $ = id => document.getElementById(id);
const redirectUri = new URL('./', location.href).href;
const state = { client: null, user: null, job: null, controller: null, scan: null, install: null };

if (!localStorage.getItem(STORAGE.client) && DEFAULT_CLIENT_ID) localStorage.setItem(STORAGE.client, DEFAULT_CLIENT_ID);

function status(text) { $('status').textContent = text; }
function countLabel(value, singular, plural) { return `${value} ${value === 1 ? singular : plural}`; }
function log(text) {
  const row = document.createElement('li');
  row.textContent = `${new Date().toLocaleTimeString('it', { hour: '2-digit', minute: '2-digit' })}  ${text}`;
  $('log').prepend(row);
  while ($('log').children.length > 150) $('log').lastElementChild.remove();
}
function showError(error) {
  const message = error?.message || 'Operazione non completata. Riprova.';
  log(message);
  status(message);
  $('error-message').textContent = message;
  if (!$('error-dialog').open) $('error-dialog').showModal();
}
function confirm(title, message, button = 'Conferma') {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = message;
  $('confirm-yes').textContent = button;
  const dialog = $('confirm-dialog');
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}
function refreshControls() {
  const connected = !!state.user;
  const busy = !!state.job;
  for (const button of document.querySelectorAll('[data-auth]')) button.disabled = !connected || busy;
  const monitor = $('monitor');
  if (state.job === 'monitor') { monitor.disabled = false; monitor.textContent = 'Ferma'; }
  else monitor.textContent = 'Avvia';
  monitor.classList.toggle('running', state.job === 'monitor');
  $('stop').hidden = !busy || state.job === 'monitor';
  $('settings').disabled = busy;
  $('connect').hidden = connected;
  $('connect').disabled = busy;
  $('disconnect').hidden = !connected;
  $('disconnect').disabled = busy;
  $('connection-note').hidden = connected;
  $('clean').disabled = busy || !connected;
  $('resume').disabled = busy || !connected;
  $('restore').disabled = busy || !connected;
  for (const input of document.querySelectorAll('input[name=mode]')) input.disabled = busy;
  $('account-label').textContent = connected ? `Ciao, ${state.user.display_name || state.user.id}` : 'Pronta a collegarsi';
  refreshRecovery();
}

async function runJob(name, work) {
  if (state.job) return;
  if (!state.user) return openSettings();
  const execute = async lock => {
    if (lock === null) return showError(new Error('Un’altra finestra di Spotify P sta lavorando sul tuo account. Fermala prima di continuare.'));
    state.job = name;
    state.controller = new AbortController();
    refreshControls();
    try { await work(state.controller.signal); }
    catch (error) {
      if (error.name === 'AbortError') {
        log('Operazione fermata. Le modifiche già completate sono conservate.');
        status('Operazione fermata.');
      } else showError(error);
    } finally {
      state.job = null;
      state.controller = null;
      if (!state.client.tokens()) state.user = null;
      refreshControls();
    }
  };
  if (navigator.locks) await navigator.locks.request(`spotifyp-account-${state.user.id}`, { ifAvailable: true }, execute);
  else await execute(undefined);
}

function openSettings() {
  if (state.job) return;
  $('client-id').value = localStorage.getItem(STORAGE.client) || '';
  $('settings-error').textContent = '';
  $('settings-dialog').showModal();
}

async function authorize() {
  const clientId = localStorage.getItem(STORAGE.client);
  if (!clientId) return openSettings();
  location.assign(await createAuthorization(clientId, redirectUri));
}

async function connectAccount() {
  const clientId = localStorage.getItem(STORAGE.client);
  const params = new URLSearchParams(location.search);
  if (!clientId) {
    if (params.has('code') || params.has('error')) {
      history.replaceState({}, '', new URL('./', location.href));
      throw new Error('La configurazione è assente in questo browser. Inserisci il Client ID e ricollega Spotify.');
    }
    return;
  }
  state.client = new SpotifyClient({ clientId, onStatus: status });
  if (params.has('code') || params.has('error')) {
    history.replaceState({}, '', new URL('./', location.href));
    if (params.has('error')) {
      sessionStorage.removeItem(STORAGE.transaction);
      throw new Error('Il collegamento Spotify è stato annullato. Puoi riprovare quando vuoi.');
    }
    const transaction = validateCallback(params.get('state'));
    status('Sto completando il collegamento con Spotify…');
    await state.client.exchange(params.get('code'), transaction);
  }
  if (!state.client.tokens()) return;
  state.user = await state.client.request('me');
  log(`Account collegato: ${state.user.display_name || state.user.id}.`);
  status('Pronto. Scegli come gestire la tua musica.');
}

function progressLabel(verb) {
  return (count, total) => status(`${verb} ${count} di ${total} brani…`);
}

function updateTrack(playback) {
  const track = playback?.item;
  $('track-name').textContent = track?.name || 'In attesa di un brano';
  $('track-artists').textContent = track?.artists?.map(artist => artist.name).join(', ') || 'Apri Spotify e avvia la riproduzione.';
  const image = track?.album?.images?.find(item => item.width >= 160) || track?.album?.images?.[0];
  const safeImage = image?.url && /^https:\/\/[a-z0-9.-]+\.scdn\.co\//i.test(image.url);
  $('cover').hidden = !safeImage;
  $('cover-empty').hidden = !!safeImage;
  if (safeImage) $('cover').src = image.url;
}
function updateTimer(milliseconds = 0) {
  const elapsed = Math.min(120, Math.floor(milliseconds / 1000));
  const remaining = 120 - elapsed;
  $('timer').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  $('listen-progress').value = elapsed;
}

async function monitor(signal) {
  const mode = document.querySelector('input[name=mode]:checked').value;
  let playlist = null;
  let present = new Set();
  if (mode === 'add') {
    status('Sto leggendo Miei brani…');
    playlist = await state.client.ownPlaylist(state.user.id, true, signal);
    const data = await state.client.readPlaylist(playlist.id, signal, progressLabel('Lettura'));
    present = new Set(data.items.flatMap(item => [itemUri(item), trackOf(item)?.uri]).filter(Boolean));
  }
  let listening = null;
  const handled = new Set();
  log(mode === 'add' ? 'Avviata aggiunta dopo due minuti.' : 'Avviata rimozione dopo due minuti.');
  while (!signal.aborted) {
    if (document.visibilityState === 'hidden') {
      listening = null;
      updateTimer();
      status('App in secondo piano. Torna qui per riprendere l’ascolto continuo.');
      await sleep(4000, signal);
      continue;
    }
    const playback = await state.client.request('me/player', { signal });
    updateTrack(playback);
    const track = playback?.item;
    if (!playback?.is_playing || track?.type !== 'track' || !track.id) {
      listening = null;
      updateTimer();
      status('Avvia o riprendi una canzone su Spotify.');
      await sleep(4000, signal);
      continue;
    }
    if (handled.has(track.id)) {
      listening = null;
      await sleep(4000, signal);
      continue;
    }
    if (mode === 'add' && (present.has(track.uri) || present.has(track.linked_from?.uri))) {
      log(`Già in Miei brani: ${track.name}. Passaggio immediato al successivo.`);
      handled.add(track.id);
      await state.client.request('me/player/next', { method: 'POST', signal });
      listening = null;
      updateTimer();
      await sleep(1200, signal);
      continue;
    }
    const next = advanceListening(listening, playback, performance.now());
    if (!listening || next?.id !== listening.id || next?.listened === 0) log(`In ascolto: ${track.name}.`);
    listening = next;
    updateTimer(listening?.listened);
    status(mode === 'add' ? 'Ascolto in corso. Aggiunta al termine dei due minuti.' : 'Ascolto in corso. Rimozione al termine dei due minuti.');
    if (listening?.listened >= 120_000) {
      const current = await state.client.request('me/player', { signal });
      if (document.visibilityState !== 'visible' || !current?.is_playing || current.item?.id !== track.id || current.device?.id !== listening.device || current.progress_ms < listening.position - 1500) {
        listening = null;
        updateTimer();
        continue;
      }
      signal.throwIfAborted();
      if (mode === 'add') {
        await state.client.request(`playlists/${playlist.id}/items`, { method: 'POST', body: { uris: [track.uri] }, signal });
        present.add(track.uri);
        log(`Aggiunto a Miei brani: ${track.name}.`);
      } else {
        const uri = current.item.linked_from?.uri || current.item.uri;
        await state.client.request(`me/library?${new URLSearchParams({ uris: uri })}`, { method: 'DELETE', signal });
        log(`Rimosso dai preferiti: ${track.name}.`);
      }
      handled.add(track.id);
      await state.client.request('me/player/next', { method: 'POST', signal });
      listening = null;
      updateTimer();
      await sleep(1200, signal);
    } else await sleep(4000, signal);
  }
}

async function copyFavorites(signal) {
  status('Sto leggendo i tuoi preferiti…');
  const favorites = await state.client.all('me/tracks?limit=50', signal, progressLabel('Preferiti letti'));
  const uris = [...new Set(favorites.map(itemUri).filter(uri => /^spotify:track:/.test(uri || '')))];
  if (!uris.length) { status('Nessun preferito copiabile trovato.'); return; }
  const playlist = await state.client.ownPlaylist(state.user.id, true, signal);
  const data = await state.client.readPlaylist(playlist.id, signal, progressLabel('Lettura playlist'));
  const present = new Set(data.items.flatMap(item => [itemUri(item), trackOf(item)?.uri]));
  const missing = uris.filter(uri => !present.has(uri));
  let added = 0;
  for (let index = 0; index < missing.length; index += 100) {
    const chunk = missing.slice(index, index + 100);
    await state.client.request(`playlists/${playlist.id}/items`, { method: 'POST', body: { uris: chunk }, signal });
    added += chunk.length;
    status(`Copiati ${added} di ${missing.length} brani…`);
  }
  const summary = `Brani aggiunti a Miei brani: ${added}. Già presenti: ${uris.length - missing.length}.`;
  log(summary);
  status(summary);
}

async function scanDuplicates(signal) {
  status('Cerco la tua playlist Miei brani…');
  const playlist = await state.client.ownPlaylist(state.user.id, false, signal);
  const data = await state.client.readPlaylist(playlist.id, signal, progressLabel('Brani analizzati'));
  state.scan = { ...data, groups: analyzeDuplicates(data.items) };
  renderDuplicates();
  const extra = state.scan.groups.reduce((count, group) => count + group.copies.length - 1, 0);
  const summary = `Scansione completata. ${countLabel(state.scan.groups.length, 'gruppo', 'gruppi')} e ${countLabel(extra, 'copia aggiuntiva', 'copie aggiuntive')}.`;
  status(summary);
  log(summary);
  $('duplicate-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderDuplicates() {
  const { groups, items } = state.scan;
  $('duplicate-results').hidden = false;
  $('results-summary').textContent = `${items.length} elementi analizzati. ${countLabel(groups.length, 'gruppo', 'gruppi')} con possibili doppioni.`;
  $('clean').hidden = groups.length === 0;
  $('groups').replaceChildren();
  if (!groups.length) {
    const text = document.createElement('p');
    text.textContent = 'Tutto in ordine. Nessun doppione trovato.';
    $('groups').append(text);
    return;
  }
  groups.forEach((group, index) => {
    const section = document.createElement('div');
    section.className = 'duplicate-group';
    const label = document.createElement('label');
    label.className = 'duplicate-choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(index);
    input.checked = true;
    const title = document.createElement('span');
    title.textContent = `${group.title} · ${group.copies.length} copie`;
    const artist = document.createElement('small');
    artist.textContent = group.artists;
    title.append(artist);
    label.append(input, title);
    section.append(label);
    group.copies.forEach((copy, copyIndex) => {
      const line = document.createElement('div');
      line.className = 'duplicate-copy';
      const text = document.createElement('span');
      const duration = Math.round((copy.track.duration_ms || 0) / 1000);
      text.textContent = `${copy.track.album?.name || 'Album non disponibile'} · ${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
      const badge = document.createElement('span');
      badge.textContent = copyIndex === 0 ? 'Conserva questa copia' : 'Copia aggiuntiva';
      if (copyIndex === 0) badge.className = 'keep';
      line.append(text, badge);
      section.append(line);
    });
    $('groups').append(section);
  });
}

function savedPlan() {
  try { return JSON.parse(localStorage.getItem(STORAGE.backup) || 'null'); } catch { return null; }
}
function savePlan(plan) {
  localStorage.setItem(STORAGE.backup, JSON.stringify(plan));
  refreshRecovery();
}
function refreshRecovery() {
  const plan = savedPlan();
  const visible = plan && state.user?.id === plan.userId;
  $('recovery').hidden = !visible;
  if (!visible) return;
  $('resume').hidden = plan.complete;
  $('recovery-title').textContent = plan.complete ? 'Backup della playlist conservato' : 'Una pulizia da completare';
  $('recovery-description').textContent = plan.complete
    ? 'Puoi scaricare il backup dell’elenco originale o ripristinarlo.'
    : 'Il piano e l’elenco originale sono salvati in questo browser. Riprendi per completare la playlist.';
}

async function applySavedPlan(plan, signal) {
  if (plan.userId !== state.user.id) throw new Error('Il backup appartiene a un altro account Spotify.');
  status('Sto preparando la playlist…');
  await applyPlaylistPlan(state.client, plan, {
    signal, save: savePlan,
    onProgress: (count, total) => status(`Playlist aggiornata: ${count} di ${total} brani…`),
  });
  state.scan = null;
  $('duplicate-results').hidden = true;
  log(`Playlist verificata. ${plan.target.length} elementi conservati nell’ordine previsto.`);
  status('Playlist aggiornata e verificata. Puoi cercare di nuovo i duplicati.');
}

async function cleanDuplicates() {
  if (!state.scan || state.job) return;
  const selected = [...$('groups').querySelectorAll('input:checked')].map(input => state.scan.groups[Number(input.value)].key);
  if (!selected.length) return showError(new Error('Seleziona almeno un gruppo da pulire.'));
  let plan;
  try { plan = makeDedupPlan(state.scan.items, selected); } catch (error) { return showError(error); }
  const previous = savedPlan();
  if (previous && !previous.complete && previous.userId === state.user.id) return showError(new Error('Completa o ripristina la pulizia precedente prima di iniziarne una nuova.'));
  const accepted = await confirm('Una copia per ogni brano.',
    `Rimuovere ${countLabel(plan.removed, 'copia aggiuntiva', 'copie aggiuntive')} da Miei brani?\n\nVerrà conservata la prima copia di ogni gruppo selezionato, rispettando l’ordine della playlist. L’elenco verrà riscritto e le date di aggiunta dei brani saranno aggiornate. Un backup dell’elenco originale resterà in questo browser.`, 'Elimina copie in più');
  if (!accepted) return;
  const data = { ...plan, id: state.scan.id, originalSnapshot: state.scan.snapshot,
    userId: state.user.id, created: new Date().toISOString(), complete: false };
  await runJob('clean', signal => applySavedPlan(data, signal));
}

async function clearFavorites() {
  if (state.job || !state.user) return;
  const accepted = await confirm('Elimina tutti i miei preferiti',
    'Vuoi rimuovere tutti i brani dall’elenco “Brani che ti piacciono”? La rimozione non ha un comando Annulla. Le playlist saranno conservate.', 'Elimina tutti i preferiti');
  if (!accepted) return;
  await runJob('clear', async signal => {
    const favorites = await state.client.all('me/tracks?limit=50', signal, progressLabel('Preferiti letti'));
    const uris = [...new Set(favorites.map(itemUri).filter(uri => /^spotify:track:/.test(uri || '')))];
    let removed = 0;
    for (let index = 0; index < uris.length; index += 40) {
      const chunk = uris.slice(index, index + 40);
      await state.client.request(`me/library?${new URLSearchParams({ uris: chunk.join(',') })}`, { method: 'DELETE', signal });
      removed += chunk.length;
      status(`Rimossi ${removed} di ${uris.length} preferiti…`);
    }
    const summary = `Brani rimossi dai preferiti: ${removed}.`;
    log(summary);
    status(summary);
  });
}

$('settings').addEventListener('click', openSettings);
$('redirect-uri').textContent = redirectUri;
$('settings-dialog').querySelector('[data-close]').addEventListener('click', () => $('settings-dialog').close());
$('copy-redirect').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(redirectUri); $('copy-redirect').textContent = 'Copiato'; }
  catch { $('settings-error').textContent = 'Seleziona l’indirizzo mostrato e copialo.'; }
});
for (const id of ['connect', 'connect-intro']) $(id).addEventListener('click', () => authorize().catch(showError));
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const value = $('client-id').value.trim();
  if (!/^[a-fA-F0-9]{32}$/.test(value)) { $('settings-error').textContent = 'Inserisci il Client ID Spotify di 32 caratteri.'; return; }
  if (localStorage.getItem(STORAGE.client) !== value) localStorage.removeItem(STORAGE.auth);
  localStorage.setItem(STORAGE.client, value);
  $('settings-dialog').close();
  try { await authorize(); } catch (error) { showError(error); }
});
$('disconnect').addEventListener('click', () => {
  localStorage.removeItem(STORAGE.auth);
  sessionStorage.removeItem(STORAGE.transaction);
  state.user = null;
  state.scan = null;
  $('duplicate-results').hidden = true;
  refreshControls();
  updateTrack(null);
  updateTimer();
  status('Account scollegato da Spotify P.');
});
$('monitor').addEventListener('click', () => {
  if (state.job === 'monitor') state.controller.abort();
  else runJob('monitor', monitor);
});
$('stop').addEventListener('click', () => state.controller?.abort());
$('copy').addEventListener('click', () => runJob('copy', copyFavorites));
$('scan').addEventListener('click', () => runJob('scan', scanDuplicates));
$('clean').addEventListener('click', cleanDuplicates);
$('clear').addEventListener('click', clearFavorites);
for (const radio of document.querySelectorAll('input[name=mode]')) radio.addEventListener('change', () => {
  $('monitor-description').textContent = radio.value === 'add'
    ? 'Aggiunge il brano dopo due minuti e passa al successivo. I brani già in playlist vengono saltati subito.'
    : 'Rimuove il brano dai preferiti dopo due minuti e passa al successivo. Se cambi canzone prima, il brano viene conservato.';
});
$('download-backup').addEventListener('click', () => {
  const plan = savedPlan();
  if (!plan || plan.userId !== state.user?.id) return;
  const blob = new Blob([JSON.stringify({ playlistId: plan.id, created: plan.created, uris: plan.original }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'Miei-brani-backup.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('resume').addEventListener('click', () => {
  const plan = savedPlan();
  if (plan) runJob('resume', signal => applySavedPlan(plan, signal));
});
$('restore').addEventListener('click', async () => {
  const backup = savedPlan();
  if (!backup || state.job || backup.userId !== state.user?.id) return;
  if (!await confirm('Ripristina l’elenco originale', 'La playlist tornerà all’elenco conservato nel backup. Eventuali modifiche successive saranno sostituite. Le date di aggiunta verranno aggiornate.', 'Ripristina playlist')) return;
  await runJob('restore', async signal => {
    const current = await state.client.readPlaylist(backup.id, signal);
    const plan = { ...backup, target: backup.original, original: current.items.map(itemUri), originalSnapshot: current.snapshot, complete: false };
    await applySavedPlan(plan, signal);
  });
});

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  state.install = event;
  $('install').hidden = matchMedia('(display-mode: standalone)').matches;
});
$('install').addEventListener('click', async () => {
  if (!state.install) return;
  await state.install.prompt();
  await state.install.userChoice;
  state.install = null;
  $('install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('install').hidden = true; log('Spotify P è installata. La trovi tra le tue app.'); });
window.addEventListener('offline', () => {
  state.controller?.abort();
  status('Connessione assente. Torna online per usare Spotify.');
});
window.addEventListener('beforeunload', event => {
  if (state.job) { event.preventDefault(); event.returnValue = ''; }
});

async function initialize() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => log('Installazione offline non disponibile in questo browser.'));
  try { await connectAccount(); } catch (error) { showError(error); }
  refreshControls();
}
initialize();
