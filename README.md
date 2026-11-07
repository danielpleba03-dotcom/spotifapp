# Spotify P — spotifapp

Applicazione desktop Python per gestire i preferiti di Spotify e la playlist personale **Miei brani**.

## Funzioni

- Cerca possibili duplicati nella playlist Miei brani, confrontando titolo e artisti normalizzati; non elimina brani.
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
