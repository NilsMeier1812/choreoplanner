-- ============================================================================
--  Choreo-Planer – Projekte privat schalten (einfache Variante)
--  Fügt der Tabelle "projects" ein Flag "is_private" hinzu. Ist es true, wird
--  das Projekt in der App nur angezeigt, wenn man angemeldet ist. Öffentliche
--  Projekte (is_private = false) sehen alle.
--
--  Hinweis: Das ist KEINE echte Zugriffssperre – die Filterung passiert im
--  Browser. Wer die Daten unbedingt will, könnte sie theoretisch trotzdem
--  abrufen. Für „einfach ausblenden" reicht das aber völlig.
--
--  Im Supabase SQL-Editor ausführen (Dashboard -> SQL Editor).
-- ============================================================================

alter table public.projects
  add column if not exists is_private boolean not null default false;
