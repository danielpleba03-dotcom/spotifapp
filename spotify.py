import os
import time
import queue
import threading
import re
import unicodedata
import webbrowser
import tkinter as tk

from tkinter import messagebox, scrolledtext, ttk

import spotipy

from dotenv import load_dotenv
from spotipy.oauth2 import SpotifyPKCE
from spotipy.exceptions import SpotifyException


# ==========================================================
# CONFIGURAZIONE
# ==========================================================

CARTELLA = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(CARTELLA, ".env"))

CLIENT_ID = os.getenv("SPOTIPY_CLIENT_ID")

REDIRECT_URI = os.getenv(
    "SPOTIPY_REDIRECT_URI",
    "http://127.0.0.1:8888/callback"
)

CACHE_PATH = os.path.join(CARTELLA, ".cache")

SCOPES = (
    "user-read-playback-state "
    "user-read-currently-playing "
    "user-modify-playback-state "
    "user-library-read "
    "user-library-modify "
    "playlist-read-private "
    "playlist-modify-private "
    "playlist-modify-public"
)

DURATA_ASCOLTO = 120
INTERVALLO_CONTROLLO = 3

spotify = None
thread_lavoro = None
thread_duplicati = None
thread_playlist = None

stop_event = threading.Event()
messaggi = queue.Queue()


# ==========================================================
# CONNESSIONE A SPOTIFY
# ==========================================================

def connetti_spotify():
    global spotify

    if not CLIENT_ID:
        raise RuntimeError(
            "Client ID mancante nel file .env."
        )

    auth_manager = SpotifyPKCE(
        client_id=CLIENT_ID,
        redirect_uri=REDIRECT_URI,
        scope=SCOPES,
        cache_path=CACHE_PATH
    )

    spotify = spotipy.Spotify(
        auth_manager=auth_manager,
        requests_timeout=10,
        retries=0
    )

    utente = spotify.current_user()

    return utente.get(
        "display_name",
        "utente Spotify"
    )


# ==========================================================
# LETTURA DEL BRANO IN RIPRODUZIONE
# ==========================================================

def brano_corrente():
    stato = spotify.current_playback()

    if not stato or not stato.get("is_playing"):
        return None

    elemento = stato.get("item")

    if not elemento or elemento.get("type") != "track":
        return None

    artisti = elemento.get("artists", [])

    nome_artisti = ", ".join(
        artista.get("name", "")
        for artista in artisti
    )

    return {
        "id": elemento["id"],
        "nome": elemento.get(
            "name",
            "Brano sconosciuto"
        ),
        "artista": nome_artisti,
        "posizione_ms": stato.get("progress_ms")
    }


# ==========================================================
# GESTIONE DEL BRANO
# ==========================================================

def rimuovi_dai_preferiti(track_id):
    spotify._delete("me/library", uris=f"spotify:track:{track_id}")


def passa_al_successivo():
    spotify.next_track()


# ==========================================================
# NORMALIZZAZIONE DEI TITOLI E DEGLI ARTISTI
# ==========================================================

def normalizza(testo):
    """
    Ignora maiuscole, accenti, punteggiatura
    e spazi superflui.
    """

    testo = str(testo or "").casefold()

    testo = unicodedata.normalize(
        "NFKD",
        testo
    )

    testo = "".join(
        carattere
        for carattere in testo
        if not unicodedata.combining(carattere)
    )

    testo = re.sub(
        r"[^a-z0-9]+",
        " ",
        testo
    )

    return " ".join(testo.split())


def chiave_brano(track):
    """
    La chiave è composta dal titolo normalizzato
    e dall'insieme degli artisti normalizzati.

    Due ID Spotify diversi possono quindi essere
    identificati come possibili duplicati.
    """

    titolo = normalizza(
        track.get("name", "")
    )

    artisti = track.get("artists", [])

    nomi_artisti = sorted({
        normalizza(artista.get("name", ""))
        for artista in artisti
        if normalizza(artista.get("name", ""))
    })

    return titolo, tuple(nomi_artisti)


# ==========================================================
# SCANSIONE DEI BRANI PREFERITI
# ==========================================================

def trova_playlist_miei_brani(crea=False):
    utente_id = richiesta_playlist(spotify.current_user)["id"]
    trovate = []
    pagina = richiesta_playlist(spotify.current_user_playlists, limit=50)
    while pagina:
        trovate.extend(voce for voce in pagina.get("items", [])
            if voce and voce.get("name", "").strip().casefold() == "miei brani"
            and (voce.get("owner") or {}).get("id") == utente_id)
        pagina = richiesta_playlist(spotify.next, pagina) if pagina.get("next") else None
    if not trovate and crea:
        return richiesta_playlist(spotify._post, "me/playlists",
            payload={"name": "Miei brani", "public": False})
    if len(trovate) != 1:
        raise RuntimeError('Playlist "Miei brani" non trovata.' if not trovate else
            'Hai più playlist chiamate "Miei brani": rinomina quelle extra e riprova.')
    return trovate[0]


def scansione_duplicati():
    """
    Legge tutti i brani della playlist personale Miei brani.

    Non modifica né elimina i brani.
    """

    global spotify

    if spotify is None:
        connetti_spotify()

    messaggi.put((
        "log",
        "Avvio scansione della playlist Miei brani..."
    ))

    playlist = trova_playlist_miei_brani()
    gruppi = {}
    offset = 0
    limite = 50
    totale = 0

    while True:

        pagina = richiesta_playlist(
            spotify._get, f"playlists/{playlist['id']}/items",
            limit=limite, offset=offset
        )

        elementi = pagina.get(
            "items",
            []
        )

        if offset == 0:
            totale = pagina.get(
                "total",
                0
            )

        if not elementi:
            break

        for elemento in elementi:

            track = elemento.get("item") or elemento.get("track")

            if not track:
                continue

            if not track.get("name"):
                continue

            if not track.get("artists"):
                continue

            chiave = chiave_brano(track)

            if not chiave[0] or not chiave[1]:
                continue

            voce = {
                "id": track.get("id"),
                "nome": track.get("name", ""),
                "artista": ", ".join(
                    artista.get("name", "")
                    for artista in track.get("artists", [])
                ),
                "url": track.get(
                    "external_urls",
                    {}
                ).get("spotify", "")
            }

            gruppi.setdefault(
                chiave,
                []
            ).append(voce)

        offset += len(elementi)

        messaggi.put((
            "log",
            f"Scansione: {min(offset, totale)} "
            f"di {totale} brani."
        ))

        if not pagina.get("next"):
            break

    duplicati = []

    for copie in gruppi.values():

        if len(copie) >= 2:
            duplicati.append({
                "nome": copie[0]["nome"],
                "artista": copie[0]["artista"],
                "numero": len(copie),
                "copie": copie
            })

    duplicati.sort(
        key=lambda voce: (
            -voce["numero"],
            normalizza(voce["nome"]),
            normalizza(voce["artista"])
        )
    )

    copie_extra = sum(
        voce["numero"] - 1
        for voce in duplicati
    )

    messaggi.put((
        "duplicati",
        {
            "risultati": duplicati,
            "totale": totale,
            "gruppi": len(duplicati),
            "copie_extra": copie_extra
        }
    ))

    messaggi.put((
        "log",
        f"Scansione completata. "
        f"Gruppi duplicati: {len(duplicati)}. "
        f"Copie aggiuntive: {copie_extra}."
    ))


# ==========================================================
# PULSANTE CERCA DUPLICATI
# ==========================================================

def avvia_ricerca_duplicati():
    global thread_duplicati

    if thread_playlist and thread_playlist.is_alive():
        return

    if thread_duplicati and thread_duplicati.is_alive():
        return

    pulsante_duplicati.config(
        state="disabled"
    )

    etichetta_stato.config(
        text="Scansione dei duplicati in corso..."
    )

    def lavoro():
        try:
            scansione_duplicati()

        except SpotifyException as errore:
            messaggi.put((
                "errore_duplicati",
                f"Errore Spotify: {errore}"
            ))

        except Exception as errore:
            messaggi.put((
                "errore_duplicati",
                str(errore)
            ))

    thread_duplicati = threading.Thread(
        target=lavoro,
        daemon=True
    )

    thread_duplicati.start()


# ==========================================================
# FINESTRA DEI RISULTATI
# ==========================================================

# ==========================================================
# COPIA DEI PREFERITI NELLA PLAYLIST
# ==========================================================

def richiesta_playlist(metodo, *args, **kwargs):
    """Rispetta Retry-After; non ritenta scritture dall'esito incerto."""
    while True:
        try:
            return metodo(*args, **kwargs)
        except SpotifyException as errore:
            if errore.http_status != 429:
                raise
            attesa = max(1, int((errore.headers or {}).get("Retry-After", 10)))
            messaggi.put(("log", f"Limite Spotify: attendo {attesa} secondi."))
            time.sleep(attesa)


def copia_preferiti_playlist():
    # Il monitoraggio deve terminare prima di leggere i preferiti.
    if thread_lavoro and thread_lavoro.is_alive():
        thread_lavoro.join()
    # Riconnette anche per richiedere i nuovi permessi playlist.
    connetti_spotify()
    utente_id = richiesta_playlist(spotify.current_user)["id"]
    corrispondenze = []
    pagina = richiesta_playlist(spotify.current_user_playlists, limit=50)
    while pagina:
        corrispondenze.extend(
            voce for voce in pagina.get("items", [])
            if voce and voce.get("name", "").strip().casefold() == "miei brani"
            and (voce.get("owner") or {}).get("id") == utente_id
        )
        pagina = richiesta_playlist(spotify.next, pagina) if pagina.get("next") else None
    if len(corrispondenze) > 1:
        raise RuntimeError('Hai più playlist chiamate "Miei brani": rinomina quelle extra e riprova.')

    preferiti = []
    visti = set()
    esclusi = 0
    pagina = richiesta_playlist(spotify.current_user_saved_tracks, limit=50)
    while pagina:
        for elemento in pagina.get("items", []):
            track = elemento.get("track") or {}
            uri = track.get("uri", "")
            if track.get("is_local") or not uri.startswith("spotify:track:"):
                esclusi += 1
                continue
            if uri not in visti:
                preferiti.append(uri)
                visti.add(uri)
        messaggi.put(("log", f"Preferiti letti: {len(preferiti)}."))
        pagina = richiesta_playlist(spotify.next, pagina) if pagina.get("next") else None

    if not preferiti:
        return f"Nessun brano copiabile trovato. Brani non disponibili: {esclusi}."
    if corrispondenze:
        playlist = corrispondenze[0]
    else:
        playlist = richiesta_playlist(
            spotify._post, "me/playlists",
            payload={"name": "Miei brani", "public": False}
        )
    playlist_id = playlist["id"]
    presenti = set()
    pagina = richiesta_playlist(spotify._get, f"playlists/{playlist_id}/items", limit=50)
    while pagina:
        for elemento in pagina.get("items", []):
            track = elemento.get("item") or elemento.get("track") or {}
            for versione in (track, track.get("linked_from") or {}):
                if versione.get("uri"):
                    presenti.add(versione["uri"])
        pagina = richiesta_playlist(spotify.next, pagina) if pagina.get("next") else None
    mancanti = [uri for uri in preferiti if uri not in presenti]
    aggiunti = 0
    for inizio in range(0, len(mancanti), 100):
        blocco = mancanti[inizio:inizio + 100]
        richiesta_playlist(
            spotify._post, f"playlists/{playlist_id}/items", payload={"uris": blocco}
        )
        aggiunti += len(blocco)
        messaggi.put(("log", f'Copia in "Miei brani": {aggiunti} di {len(mancanti)}.'))
    return (
        f'Aggiunti {aggiunti} brani a "Miei brani". '
        f"Già presenti: {len(preferiti) - len(mancanti)}. "
        f"Non disponibili: {esclusi}.\n"
        "I preferiti sono stati mantenuti. Il monitoraggio resta fermo."
    )


def elimina_tutti_preferiti():
    if thread_lavoro and thread_lavoro.is_alive():
        thread_lavoro.join()
    if thread_duplicati and thread_duplicati.is_alive():
        thread_duplicati.join()
    connetti_spotify()
    # Legge prima tutte le pagine: cancellare durante la paginazione
    # sposterebbe gli offset, saltando parte dei brani.
    uris = []
    visti = set()
    esclusi = 0
    pagina = richiesta_playlist(spotify.current_user_saved_tracks, limit=50)
    while pagina:
        for elemento in pagina.get("items", []):
            track = elemento.get("track") or {}
            uri = track.get("uri", "")
            if not uri.startswith("spotify:track:"):
                esclusi += 1
                continue
            if uri not in visti:
                uris.append(uri)
                visti.add(uri)
        messaggi.put(("log", f"Preferiti da rimuovere letti: {len(uris)}."))
        pagina = richiesta_playlist(spotify.next, pagina) if pagina.get("next") else None
    rimossi = 0
    try:
        for inizio in range(0, len(uris), 40):
            if stop_event.is_set():
                return f"Rimozione fermata. Rimossi {rimossi} di {len(uris)} preferiti."
            blocco = uris[inizio:inizio + 40]
            richiesta_playlist(spotify._delete, "me/library", uris=",".join(blocco))
            rimossi += len(blocco)
            messaggi.put(("log", f"Preferiti rimossi: {rimossi} di {len(uris)}."))
    except Exception as errore:
        raise RuntimeError(
            f"Rimozione interrotta dopo {rimossi} rimozioni confermate. "
            "L'ultimo blocco potrebbe essere stato elaborato: puoi riprovare. "
            f"Dettaglio: {errore}"
        ) from errore
    return (
        f"Rimossi {rimossi} brani dai preferiti. Brani non disponibili: {esclusi}.\n"
        'Le playlist, inclusa "Miei brani", non sono state modificate. '
        "Il monitoraggio resta fermo."
    )


def avvia_eliminazione_preferiti():
    global thread_playlist
    if thread_playlist and thread_playlist.is_alive():
        return
    if not messagebox.askyesno(
        "Elimina tutti i preferiti",
        'Vuoi rimuovere TUTTI i brani da "Brani che ti piacciono"?\n\n'
        'Le playlist, inclusa "Miei brani", resteranno intatte. '
        'Questa funzione non crea una copia dei brani.\n\n'
        "La rimozione non ha un comando Annulla. Procedere?",
        icon="warning", default="no"
    ):
        return
    stop_event.set()
    for pulsante in (pulsante_avvia, pulsante_duplicati, pulsante_playlist, pulsante_elimina):
        pulsante.config(state="disabled")
    etichetta_stato.config(text="Rimozione dei preferiti in corso...")

    def lavoro():
        try:
            # Attende l'arresto del monitoraggio prima di riusare l'evento
            # per consentire al pulsante Ferma di interrompere la rimozione.
            if thread_lavoro and thread_lavoro.is_alive():
                thread_lavoro.join()
            stop_event.clear()
            messaggi.put(("eliminazione_completata", elimina_tutti_preferiti()))
        except Exception as errore:
            messaggi.put(("errore_eliminazione", str(errore)))
        finally:
            stop_event.set()

    thread_playlist = threading.Thread(target=lavoro, daemon=True)
    thread_playlist.start()


def avvia_copia_playlist():
    global thread_playlist
    if thread_playlist and thread_playlist.is_alive():
        return
    stop_event.set()
    pulsante_elimina.config(state="disabled")
    pulsante_playlist.config(state="disabled")
    pulsante_avvia.config(state="disabled")
    pulsante_duplicati.config(state="disabled")
    etichetta_stato.config(text='Copia in "Miei brani" in corso...')

    def lavoro():
        try:
            if thread_duplicati and thread_duplicati.is_alive():
                thread_duplicati.join()
            messaggi.put(("playlist_completata", copia_preferiti_playlist()))
        except Exception as errore:
            messaggi.put(("errore_playlist", (
                f"Copia interrotta: {errore}\n"
                "Eventuali brani già copiati restano nella playlist. "
                "Puoi riprovare: i brani presenti saranno saltati."
            )))

    thread_playlist = threading.Thread(target=lavoro, daemon=True)
    thread_playlist.start()


def mostra_duplicati(dati):

    risultati = dati["risultati"]

    finestra_duplicati = tk.Toplevel(finestra)

    finestra_duplicati.title(
        'Duplicati • Miei brani'
    )

    finestra_duplicati.geometry(
        "850x480"
    )

    finestra_duplicati.minsize(
        650,
        350
    )

    contenitore = tk.Frame(
        finestra_duplicati,
        padx=15,
        pady=15
    )

    contenitore.pack(
        fill="both",
        expand=True
    )

    riepilogo = (
        f'Brani analizzati: {dati["totale"]} | '
        f'Gruppi duplicati: {dati["gruppi"]} | '
        f'Copie aggiuntive: {dati["copie_extra"]}'
    )

    tk.Label(
        contenitore,
        text=riepilogo,
        font=("Segoe UI", 10, "bold")
    ).pack(
        anchor="w",
        pady=(0, 10)
    )

    if not risultati:

        tk.Label(
            contenitore,
            text="Nessun duplicato trovato.",
            font=("Segoe UI", 12)
        ).pack(
            fill="both",
            expand=True
        )

        tk.Button(
            contenitore,
            text="Chiudi",
            command=finestra_duplicati.destroy
        ).pack(pady=10)

        return

    cornice = tk.Frame(contenitore)

    cornice.pack(
        fill="both",
        expand=True
    )

    colonne = (
        "titolo",
        "artista",
        "copie"
    )

    tabella = ttk.Treeview(
        cornice,
        columns=colonne,
        show="headings",
        selectmode="browse"
    )

    tabella.heading(
        "titolo",
        text="Titolo"
    )

    tabella.heading(
        "artista",
        text="Artista"
    )

    tabella.heading(
        "copie",
        text="Copie"
    )

    tabella.column(
        "titolo",
        width=300,
        minwidth=150
    )

    tabella.column(
        "artista",
        width=350,
        minwidth=150
    )

    tabella.column(
        "copie",
        width=70,
        minwidth=60,
        anchor="center"
    )

    barra_y = ttk.Scrollbar(
        cornice,
        orient="vertical",
        command=tabella.yview
    )

    barra_x = ttk.Scrollbar(
        cornice,
        orient="horizontal",
        command=tabella.xview
    )

    tabella.configure(
        yscrollcommand=barra_y.set,
        xscrollcommand=barra_x.set
    )

    tabella.grid(
        row=0,
        column=0,
        sticky="nsew"
    )

    barra_y.grid(
        row=0,
        column=1,
        sticky="ns"
    )

    barra_x.grid(
        row=1,
        column=0,
        sticky="ew"
    )

    cornice.rowconfigure(
        0,
        weight=1
    )

    cornice.columnconfigure(
        0,
        weight=1
    )

    collegamenti = {}

    for indice, voce in enumerate(risultati):

        iid = str(indice)

        tabella.insert(
            "",
            "end",
            iid=iid,
            values=(
                voce["nome"],
                voce["artista"],
                voce["numero"]
            )
        )

        collegamenti[iid] = voce["copie"]

    def apri_brano_selezionato(event=None):

        selezione = tabella.selection()

        if not selezione:
            return

        copie = collegamenti.get(
            selezione[0],
            []
        )

        if not copie:
            return

        url = copie[0].get("url")

        if url:
            webbrowser.open(url)

        else:
            messagebox.showinfo(
                "Collegamento non disponibile",
                "Spotify non ha restituito il collegamento."
            )

    tabella.bind(
        "<Double-1>",
        apri_brano_selezionato
    )

    tk.Label(
        contenitore,
        text=(
            "Doppio clic su un risultato per aprirlo su Spotify. "
            "Nessun brano viene eliminato."
        ),
        font=("Segoe UI", 9)
    ).pack(
        anchor="w",
        pady=(10, 5)
    )

    tk.Button(
        contenitore,
        text="Chiudi",
        command=finestra_duplicati.destroy
    ).pack(pady=(5, 0))


# ==========================================================
# CICLO PRINCIPALE
# ==========================================================

def attendi_minuto_brano(brano):
    """Richiede due minuti continuo dello stesso brano, controllato ogni secondo."""
    inizio = time.monotonic()
    posizione = brano.get("posizione_ms")
    while True:
        residuo = DURATA_ASCOLTO - (time.monotonic() - inizio)
        if stop_event.wait(min(1.0, max(0, residuo))):
            return False
        attuale = brano_corrente()
        if attuale is None or attuale["id"] != brano["id"]:
            messaggi.put(("log", "Riproduzione interrotta o brano cambiato prima dei due minuti: nessuna modifica."))
            return False
        nuova_posizione = attuale.get("posizione_ms")
        if posizione is not None and nuova_posizione is not None and nuova_posizione < posizione - 2000:
            messaggi.put(("log", "Brano riavviato: il conteggio riparte da zero."))
            return False
        posizione = nuova_posizione
        if time.monotonic() - inizio >= DURATA_ASCOLTO:
            return not stop_event.is_set()


def avvia_monitoraggio(modalita="rimuovi"):

    gia_processati = set()
    playlist_id = None
    presenti = set()
    if modalita == "aggiungi":
        playlist_id = trova_playlist_miei_brani(crea=True)["id"]
        pagina = richiesta_playlist(spotify._get, f"playlists/{playlist_id}/items", limit=50)
        while pagina:
            if stop_event.is_set():
                return
            for elemento in pagina.get("items", []):
                track = elemento.get("item") or elemento.get("track") or {}
                for versione in (track, track.get("linked_from") or {}):
                    if versione.get("uri"):
                        presenti.add(versione["uri"])
            pagina = richiesta_playlist(spotify.next, pagina) if pagina.get("next") else None

    messaggi.put((
        "stato",
        "Monitoraggio attivo."
    ))

    while not stop_event.is_set():

        try:
            brano = brano_corrente()

            if brano is None:
                stop_event.wait(INTERVALLO_CONTROLLO)
                continue

            track_id = brano["id"]

            if track_id in gia_processati:
                stop_event.wait(INTERVALLO_CONTROLLO)
                continue


            messaggi.put((
                "brano",
                f'{brano["nome"]}\n{brano["artista"]}'
            ))

            messaggi.put((
                "log",
                f'Brano in ascolto: {brano["nome"]} '
                f'— {brano["artista"]}'
            ))

            if modalita == "aggiungi" and f"spotify:track:{track_id}" in presenti:
                if stop_event.is_set():
                    break
                gia_processati.add(track_id)
                messaggi.put(("log", 'Già in "Miei brani": passaggio immediato al successivo.'))
                passa_al_successivo()
                continue

            azione = "Aggiunta a Miei brani" if modalita == "aggiungi" else "Rimozione dai preferiti"
            messaggi.put(("stato", f"{azione} dopo due minuti di ascolto. Skippa per evitare la modifica."))
            if not attendi_minuto_brano(brano):
                continue
            if stop_event.is_set():
                break

            brano_attuale = brano_corrente()

            if (
                brano_attuale is None
                or brano_attuale["id"] != track_id
            ):
                messaggi.put((
                    "log",
                    "Il brano è cambiato durante l'ascolto: "
                    "nessuna modifica."
                ))
                continue

            if modalita == "aggiungi":
                uri = f"spotify:track:{track_id}"
                if uri in presenti:
                    messaggi.put(("log", 'Brano già presente in "Miei brani": saltato.'))
                else:
                    if stop_event.is_set():
                        break
                    spotify._post(f"playlists/{playlist_id}/items", payload={"uris": [uri]})
                    presenti.add(uri)
                    messaggi.put(("log", 'Brano aggiunto a "Miei brani". Preferiti invariati.'))
            else:
                if stop_event.is_set():
                    break
                rimuovi_dai_preferiti(track_id)
                messaggi.put(("log", "Due minuti completati: brano rimosso dai preferiti."))

            gia_processati.add(track_id)
            if stop_event.is_set():
                break
            passa_al_successivo()

            messaggi.put((
                "log",
                "Passaggio al brano successivo."
            ))

            stop_event.wait(INTERVALLO_CONTROLLO)

        except SpotifyException as errore:

            if getattr(errore, "http_status", None) == 429:

                attesa = 10

                try:
                    attesa = int(
                        errore.headers.get("Retry-After", 10)
                    )
                except (AttributeError, TypeError, ValueError):
                    pass

                messaggi.put((
                    "log",
                    f"Limite richieste Spotify: "
                    f"attendo {attesa} secondi."
                ))

                stop_event.wait(attesa)

            else:

                messaggi.put((
                    "log",
                    f"Errore Spotify: {errore}"
                ))

                stop_event.wait(5)

        except Exception as errore:

            messaggi.put((
                "log",
                f"Errore: {errore}"
            ))

            stop_event.wait(5)

    messaggi.put((
        "stato",
        "Monitoraggio fermato."
    ))


# ==========================================================
# PULSANTE AVVIA
# ==========================================================

def avvia():
    global thread_lavoro
    if thread_playlist and thread_playlist.is_alive():
        return
    if thread_lavoro and thread_lavoro.is_alive():
        ferma()
        return
    # Un solo worker rappresenta sia la connessione sia il monitoraggio.
    # Ferma funziona anche se l'autorizzazione è ancora in corso.
    modalita = modalita_monitoraggio.get()
    stop_event.clear()
    etichetta_stato.config(text="Connessione a Spotify...")

    def lavoro():
        try:
            nome = connetti_spotify()
            messaggi.put(("log", f"Connesso a Spotify come {nome}."))
            if not stop_event.is_set():
                avvia_monitoraggio(modalita)
        except Exception as errore:
            messaggi.put(("log", f"Errore monitoraggio: {errore}"))
            messaggi.put(("stato", "Monitoraggio interrotto."))
        finally:
            messaggi.put(("pulsante_avvia", "abilita"))

    thread_lavoro = threading.Thread(target=lavoro, daemon=True)
    thread_lavoro.start()
    aggiorna_pulsanti()


# ==========================================================
# PULSANTE FERMA E CHIUSURA
# ==========================================================

def ferma():
    stop_event.set()
    etichetta_stato.config(
        text="Arresto in corso..."
    )


def chiudi():
    stop_event.set()
    finestra.destroy()


# ==========================================================
# AGGIORNAMENTO INTERFACCIA
# ==========================================================

def scrivi_log(testo):

    area_log.configure(
        state="normal"
    )

    area_log.insert(
        tk.END,
        testo + "\n"
    )

    area_log.see(
        tk.END
    )

    area_log.configure(
        state="disabled"
    )


def aggiorna_pulsanti():
    occupato = bool(thread_playlist and thread_playlist.is_alive())
    monitoraggio = bool(thread_lavoro and thread_lavoro.is_alive())
    scansione = bool(thread_duplicati and thread_duplicati.is_alive())
    arresto = monitoraggio and stop_event.is_set()
    pulsante_avvia.config(
        text="Arresto in corso..." if arresto else ("Ferma" if monitoraggio else "Avvia"),
        state="disabled" if occupato or arresto else "normal",
        style="Stop.TButton" if monitoraggio else "Accent.TButton"
    )
    for selettore in selettori_modalita:
        selettore.config(state="disabled" if occupato or monitoraggio else "normal")
    pulsante_playlist.config(state="disabled" if occupato else "normal")
    pulsante_duplicati.config(state="disabled" if occupato or scansione else "normal")
    pulsante_elimina.config(state="disabled" if occupato else "normal")


def aggiorna_interfaccia():

    try:
        while True:

            tipo, testo = messaggi.get_nowait()

            if tipo == "stato":

                etichetta_stato.config(
                    text=testo
                )

            elif tipo == "brano":

                etichetta_brano.config(
                    text=testo
                )

            elif tipo == "log":

                scrivi_log(testo)

            elif tipo == "pulsante_avvia":

                pulsante_avvia.config(
                    state="normal"
                )

            elif tipo in ("eliminazione_completata", "errore_eliminazione"):
                for pulsante in (pulsante_avvia, pulsante_duplicati, pulsante_playlist, pulsante_elimina):
                    pulsante.config(state="normal")
                etichetta_stato.config(text="Rimozione terminata." if tipo == "eliminazione_completata" else "Rimozione interrotta.")
                scrivi_log(testo)
                if tipo == "eliminazione_completata":
                    messagebox.showinfo("Preferiti", testo)
                else:
                    messagebox.showerror("Errore rimozione preferiti", testo)

            elif tipo in ("playlist_completata", "errore_playlist"):
                pulsante_elimina.config(state="normal")
                pulsante_playlist.config(state="normal")
                pulsante_avvia.config(state="normal")
                pulsante_duplicati.config(state="normal")
                etichetta_stato.config(text="Copia completata." if tipo == "playlist_completata" else "Copia interrotta.")
                scrivi_log(testo)
                if tipo == "playlist_completata":
                    messagebox.showinfo("Miei brani", testo)
                else:
                    messagebox.showerror("Errore copia playlist", testo)

            elif tipo == "duplicati":

                pulsante_duplicati.config(
                    state="normal"
                )

                etichetta_stato.config(
                    text="Scansione duplicati completata."
                )

                mostra_duplicati(testo)

            elif tipo == "errore_duplicati":

                pulsante_duplicati.config(
                    state="normal"
                )

                etichetta_stato.config(
                    text="Scansione duplicati non riuscita."
                )

                messagebox.showerror(
                    "Errore nella scansione",
                    testo
                )

    except queue.Empty:
        pass

    aggiorna_pulsanti()

    finestra.after(
        200,
        aggiorna_interfaccia
    )


# ==========================================================
# CREAZIONE DELLA FINESTRA
# ==========================================================

finestra = tk.Tk()
finestra.title("Spotify P")
finestra.geometry("840x910")
finestra.minsize(740, 870)
BG = "#101813"
CARD = "#1b2820"
TEXT = "#f2f7f3"
MUTED = "#aec1b3"
GREEN = "#69e69a"
finestra.configure(bg=BG)
finestra.option_add("*Font", "{Segoe UI} 10")
stile = ttk.Style()
stile.theme_use("clam")
stile.configure("Accent.TButton", background=GREEN, foreground="#102017",
    padding=(20, 12), font=("Segoe UI", 10, "bold"), borderwidth=0)
stile.map("Accent.TButton", background=[("disabled", "#34463a"), ("active", "#90f4b6")],
    foreground=[("disabled", "#8c9e92")])
stile.configure("Stop.TButton", background="#f0bd85", foreground="#32200f",
    padding=(20, 12), font=("Segoe UI", 10, "bold"), borderwidth=0)
stile.map("Stop.TButton", background=[("disabled", "#34463a"), ("active", "#ffdab2")])
stile.configure("Treeview", background=CARD, fieldbackground=CARD, foreground=TEXT,
    rowheight=30, borderwidth=0)
stile.configure("Treeview.Heading", background="#304637", foreground=TEXT,
    font=("Segoe UI", 10, "bold"), padding=8)
stile.map("Treeview", background=[("selected", "#356849")])

menu = tk.Menu(finestra, tearoff=False)
strumenti = tk.Menu(menu, tearoff=False)
strumenti.add_command(label="Interrompi operazione", command=ferma)
menu.add_cascade(label="Strumenti", menu=strumenti)
finestra.config(menu=menu)
contenitore = tk.Frame(finestra, bg=BG, padx=28, pady=24)
contenitore.pack(fill="both", expand=True)
tk.Label(contenitore, text="SPOTIFY P", bg=BG, fg=GREEN,
    font=("Segoe UI", 11, "bold")).pack(anchor="w")
tk.Label(contenitore, text="La tua musica, in ordine.", bg=BG, fg=TEXT,
    font=("Segoe UI", 25, "bold")).pack(anchor="w", pady=(4, 2))
tk.Label(contenitore, text="Gestisci la playlist Miei brani e i tuoi preferiti.",
    bg=BG, fg=MUTED).pack(anchor="w", pady=(0, 18))
etichetta_stato = tk.Label(contenitore, text="Pronto.", bg=BG, fg=GREEN,
    font=("Segoe UI", 11), anchor="w")
etichetta_stato.pack(fill="x", pady=(0, 12))

def scheda(numero, titolo, descrizione, testo, comando):
    frame = tk.Frame(contenitore, bg=CARD, padx=18, pady=15)
    frame.pack(fill="x", pady=(0, 10))
    frame.columnconfigure(0, weight=1)
    tk.Label(frame, text=f"{numero}   {titolo}", bg=CARD, fg=TEXT,
        font=("Segoe UI", 12, "bold"), anchor="w").grid(row=0, column=0, sticky="w")
    tk.Label(frame, text=descrizione, bg=CARD, fg=MUTED, justify="left",
        wraplength=450, anchor="w").grid(row=1, column=0, sticky="w", pady=(5, 0))
    pulsante = ttk.Button(frame, text=testo, command=comando, style="Accent.TButton")
    pulsante.grid(row=0, column=1, rowspan=2, padx=(18, 0))
    return pulsante

pulsante_duplicati = scheda("01", "Cerca duplicati",
    'Trova i possibili doppioni nella tua playlist "Miei brani".\nNessun brano viene eliminato.',
    "Cerca duplicati", avvia_ricerca_duplicati)
pulsante_playlist = scheda("02", "Copia i tuoi preferiti",
    'Aggiunge i preferiti mancanti a "Miei brani".\nI brani restano anche nei preferiti.',
    'Copia preferiti in Miei brani', avvia_copia_playlist)
pulsante_avvia = scheda("03", "Gestisci i brani uno ad uno",
    "Scegli la modalità, poi premi Avvia. Ferma interrompe il ciclo.",
    "Avvia", avvia)
modalita_monitoraggio = tk.StringVar(value="rimuovi")
selettori_modalita = []
scelta_frame = tk.Frame(pulsante_avvia.master, bg=CARD)
scelta_frame.grid(row=2, column=0, columnspan=2, sticky="w", pady=(10, 0))
for valore, testo in (("rimuovi", "Rimuovi preferiti"), ("aggiungi", "Aggiungi a Miei brani")):
    selettore = tk.Radiobutton(scelta_frame, text=testo, value=valore,
        variable=modalita_monitoraggio, bg=CARD, fg=TEXT, selectcolor="#304637",
        activebackground=CARD, activeforeground=GREEN, highlightthickness=0)
    selettore.pack(side="left", padx=(0, 16))
    selettori_modalita.append(selettore)
testo_modalita = tk.Label(pulsante_avvia.master, bg=CARD, fg=MUTED,
    justify="left", wraplength=670, anchor="w", font=("Segoe UI", 9))
testo_modalita.grid(row=3, column=0, columnspan=2, sticky="w", pady=(5, 0))
def descrivi_modalita(*args):
    testo_modalita.config(text=(
        "Dopo due minuti rimuove il brano dai preferiti e passa al successivo.\nSe cambi brano prima dei due minuti, non lo rimuove."
        if modalita_monitoraggio.get() == "rimuovi" else
        "Dopo due minuti aggiunge il brano in ascolto alla playlist e passa al successivo.\n"
        "Se cambi brano prima dei due minuti, non lo aggiunge. Preferiti invariati. I brani già presenti vengono saltati subito."
    ))
modalita_monitoraggio.trace_add("write", descrivi_modalita)
descrivi_modalita()

elimina_frame = tk.Frame(contenitore, bg=BG)
elimina_frame.pack(fill="x", pady=(2, 10))
stile.configure("Danger.TButton", background="#4a252b", foreground="#ffbdc6",
    padding=(16, 10), font=("Segoe UI", 10, "bold"), borderwidth=0)
stile.map("Danger.TButton", background=[("disabled", "#34463a"), ("active", "#65333c")],
    foreground=[("disabled", "#8c9e92")])
pulsante_elimina = ttk.Button(elimina_frame, text="Elimina tutti i miei preferiti...",
    command=avvia_eliminazione_preferiti, style="Danger.TButton")
pulsante_elimina.pack(side="left")
tk.Label(elimina_frame, text="Richiede conferma. Le playlist restano intatte.",
    bg=BG, fg=MUTED, font=("Segoe UI", 9)).pack(side="left", padx=12)

brano_frame = tk.Frame(contenitore, bg=BG)
brano_frame.pack(fill="x", pady=(5, 12))
tk.Label(brano_frame, text="IN ASCOLTO", bg=BG, fg=MUTED,
    font=("Segoe UI", 9, "bold")).pack(anchor="w")
etichetta_brano = tk.Label(brano_frame, text="Nessun brano in riproduzione", bg=BG,
    fg=TEXT, font=("Segoe UI", 12), anchor="w", justify="left", wraplength=720)
etichetta_brano.pack(fill="x", pady=(3, 0))
tk.Label(contenitore, text="ATTIVITÀ", bg=BG, fg=MUTED,
    font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(0, 6))
area_log = scrolledtext.ScrolledText(contenitore, height=6, wrap="word", state="disabled",
    font=("Consolas", 10), bg="#142019", fg="#c4d8ca", insertbackground=GREEN,
    relief="flat", borderwidth=0, padx=12, pady=10)
area_log.pack(fill="both", expand=True)
finestra.protocol("WM_DELETE_WINDOW", chiudi)
aggiorna_interfaccia()
finestra.mainloop()
