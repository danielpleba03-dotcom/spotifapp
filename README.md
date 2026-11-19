# Spotify P — spotifapp

Applicazione desktop Python per gestire i preferiti di Spotify e la playlist personale **Miei brani**.

## App web installabile

Apri [Spotify P nel browser](https://danielpleba03-dotcom.github.io/spotifapp/). In Chrome premi **Installa app**, quando compare, oppure usa il comando di installazione del sito nel menu del browser.

Per il primo collegamento, nelle impostazioni della tua app Spotify for Developers aggiungi questo **Redirect URI**, compreso lo slash finale:

```text
https://danielpleba03-dotcom.github.io/spotifapp/
```

Il collegamento usa Authorization Code con PKCE. La configurazione include l’identificativo pubblico dell’app Spotify esistente e può essere cambiata dal pulsante Impostazioni. L’autorizzazione personale viene salvata nel browser.

Il conteggio di due minuti richiede che l’app sia aperta e visibile. Pause, cambi di brano, riavvii e sospensioni del browser fanno ripartire l’attesa.

La pulizia dei duplicati conserva la prima copia dei gruppi selezionati e riscrive l’elenco mantenendone l’ordine. Le date di aggiunta vengono aggiornate. Prima della modifica salva un backup locale e un piano riprendibile. Gli elementi locali o non disponibili impediscono la riscrittura automatica per evitare perdite.

Per verificare la logica web:

```text
node --test tests/web-core.test.mjs
```

## Installazione su Windows

Scarica [SpotifyP-Setup.exe](https://github.com/danielpleba03-dotcom/spotifapp/releases/latest/download/SpotifyP-Setup.exe), aprilo e segui la procedura guidata. Troverai **Spotify P** nel menu Start. Non serve installare Python.

L'installazione usa la cartella personale `%LOCALAPPDATA%\Programs\SpotifyP`. Configurazione e autorizzazione Spotify sono conservate separatamente in `%LOCALAPPDATA%\SpotifyP`.

In alternativa è disponibile il [pacchetto ZIP portatile](https://github.com/danielpleba03-dotcom/spotifapp/releases/latest/download/SpotifyP-Windows.zip).

## Funzioni

- Cerca possibili duplicati nella playlist Miei brani, confrontando titolo e artisti normalizzati; dai risultati puoi rimuovere le copie aggiuntive dopo conferma, conservando la prima copia di ogni gruppo.
- Copia tutti i preferiti nella playlist, saltando quelli già presenti; crea la playlist privata se manca.
- Modalità **Rimuovi preferiti**: dopo due minuti continui sullo stesso brano lo rimuove dai preferiti e passa al successivo.
- Modalità **Aggiungi a Miei brani**: dopo due minuti aggiunge il brano alla playlist, senza modificare i preferiti, e passa al successivo. I brani già presenti vengono saltati immediatamente.
- Se cambi brano prima dei due minuti, non viene aggiunto né rimosso. Una pausa o un riavvio del brano azzera l'attesa.
- Un unico pulsante Avvia/Ferma controlla il monitoraggio. Non viene usato il microfono.
- Il pulsante Elimina tutti i miei preferiti richiede conferma e non modifica le playlist. La rimozione non ha un comando Annulla.

## Avvio su Windows

1. Installa Python con il componente Tcl/Tk (tkinter).
2. Installa le dipendenze:

   ```powershell
   python -m pip install -r requirements.txt
   ```

3. Crea o usa una tua applicazione nel portale Spotify for Developers e registra il redirect `http://127.0.0.1:8888/callback`.
4. Copia `.env.example` in `.env` nella cartella dell'app e inserisci il tuo Client ID.
5. Avvia:

   ```powershell
   python spotify.py
   ```

6. Completa l'autorizzazione Spotify nel browser, poi avvia la riproduzione su Spotify e scegli l'operazione nell'app. Il controllo della riproduzione è soggetto ai requisiti del proprio account e dell'app Spotify.

## Copie precedenti

La cartella `backups/` contiene le versioni Python precedenti conservate durante le modifiche. Per l'uso normale avvia solo `spotify.py`: le versioni più vecchie possono avere tempi e comportamenti diversi e alcune richiedono le vecchie dipendenze audio.

## Dati locali

Il repository esclude `.env`, le cache OAuth di Spotify e i token. La configurazione e l'autorizzazione vanno ricreate su un altro computer. Questo salvataggio riguarda il codice: non è una copia dei brani o dei dati dell'account Spotify.

Il controllo del brano durante l'attesa avviene ogni secondo; in caso di errore di connessione l'app registra l'errore e riprende i controlli.
