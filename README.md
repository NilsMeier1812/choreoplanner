# Choreo-Planer PWA

Mobiles Web-Tool zur Planung von Tanz-Choreografien. Oberes Drittel = Audio-Waveform
mit Taktraster, untere zwei Drittel = scrollbare Notizen/Sprungmarken. Kollaborativ
nutzbar mit Heartbeat-Locking, voll offline-fähig (App-Shell + Audio-Cache + Sync-Queue).

Tech-Stack (CDN, kein Build-Step): Vanilla HTML/CSS/JS · Alpine.js · Wavesurfer.js v7
(Timeline + Regions) · Dexie.js (IndexedDB) · Supabase.

## ⚠️ Einmaliger Setup-Schritt (erforderlich)

Tabellen, Indizes und der Storage-Bucket `audio-tracks` (public) sind bereits deployed.
Für die Anzeige **wer** ein Projekt gerade bearbeitet ("Wird von Anna bearbeitet")
braucht die `projects`-Tabelle **eine zusätzliche Spalte**. Bitte einmal im
Supabase SQL-Editor ausführen:

```sql
-- Name des Sperrenden (Anzeige "Wird von Anna bearbeitet")
ALTER TABLE projects ADD COLUMN IF NOT EXISTS locked_by_name TEXT;

-- Beat-Raster-Offset in Sekunden (z.B. Intro vor dem ersten Takt)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS grid_offset NUMERIC(8,3) DEFAULT 0;
```

Ohne `locked_by_name` schlägt das Wechseln in den Editor-Modus fehl (Sperre kann
nicht gesetzt werden). Ohne `grid_offset` lässt sich der Raster-Start nicht speichern.

Außerdem brauchen `anon`/`authenticated` Tabellen- und Storage-Rechte (RLS ist aus):

```sql
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;

-- Storage: Upload in den (öffentlichen) Bucket erlauben
create policy "audio-tracks anon all" on storage.objects
  for all to anon, authenticated
  using (bucket_id = 'audio-tracks') with check (bucket_id = 'audio-tracks');
```

## Dateien

| Datei | Zweck |
|-------|-------|
| `index.html` | UI, Off-Canvas-Menü, Alpine-Markup |
| `app.js` | Logik: Supabase-Client, Audio-Sync, Locking, Offline-Queue |
| `style.css` | Layout (100dvh, kein Body-Scroll) |
| `manifest.json` | PWA-Konfiguration |
| `sw.js` | Service Worker (App-Shell-Cache) |
| `assets/` | PWA-Icons (Platzhalter, austauschbar) + `gen_icons.py` |

## Bedienung

- **Menü (☰)**: Projekte wechseln/anlegen/löschen, Audio hochladen (mit Fortschritt
  & Abbrechen). Beim ersten Start wird einmalig nach dem Namen gefragt.
- **Training-Modus**: Notizen `readonly`; das aktive Segment scrollt automatisch
  zentriert ins Bild und wird hervorgehoben.
- **Editor-Modus**: holt die Sperre (oder übernimmt verwaiste "Zombie-Locks" nach
  30 s), Heartbeat alle 15 s. Auto-Scroll deaktiviert. „＋ Marke" setzt an der
  Cursor-Position eine Sprungmarke; Marken sind in der Waveform verschiebbar.
  Tippen wird mit 1 s Debounce gespeichert.
- **Raster-Start (Editor)**: verschiebt das Beat-Raster, falls das Lied ein Intro
  hat. An die gewünschte Stelle spulen → „🎯 hier starten", oder mit −/+ in 50-ms-
  Schritten feinjustieren. „⟲" setzt zurück. Wird in `projects.grid_offset` gespeichert.

> **Audioformat:** Es werden nur **MP3** und **WAV** akzeptiert. m4a/AAC wird
> bewusst abgelehnt, da die Web-Audio-Dekodierung der Waveform nicht in allen
> Browsern funktioniert.

## Offline-Verhalten

- App-Shell + CDN-Module werden vom Service Worker gecacht → UI startet ohne Netz.
- Audio wird beim ersten Laden als Blob in IndexedDB (Dexie) gespeichert → spätere
  Wiedergabe offline. Korrupte/verworfene Blobs (iOS-Eviction) werden erkannt und neu geladen.
- Editor-Änderungen ohne Netz landen in der `syncQueue` und werden bei
  `online`-Event automatisch nachgezogen. `visibilitychange` (Bildschirm aus /
  Seite verlassen) flusht offene Änderungen sofort per `keepalive`-Request.

## Icons austauschen

Eigene PNGs einfach unter `assets/icon-192.png` / `assets/icon-512.png` /
`assets/apple-touch-icon.png` ablegen. Die Platzhalter wurden mit
`python3 assets/gen_icons.py` erzeugt.

## Deployment

Statisches Hosting (Vercel) auf `main`. Kein Build nötig – alle Dateien liegen im Root.
Wichtig: über **HTTPS** ausliefern (Service Worker & PWA-Installation).
