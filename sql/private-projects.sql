-- ============================================================================
--  Choreo-Planer – Projekte privat schalten (Row Level Security)
--  Ziel: Projekte und alle zugehörigen Daten sind NUR sichtbar, wenn man
--        angemeldet ist. Anonyme (nicht eingeloggte) Besucher sehen nichts.
--
--  WICHTIG:
--   * Diesen Code im Supabase SQL-Editor ausführen (Dashboard -> SQL Editor).
--   * Bearbeiten funktioniert weiterhin nur für angemeldete Nutzer (Editor).
--   * Das Skript ist idempotent – es kann gefahrlos mehrfach ausgeführt werden.
--     Es entfernt vorher ALLE bestehenden Policies der betroffenen Tabellen
--     (damit keine alte „für alle sichtbar"-Regel übrig bleibt) und legt sie
--     danach sauber neu an.
-- ============================================================================

do $$
declare
  t      text;
  pol    record;
  tables text[] := array[
    'projects',
    'tempo_sections',
    'persons',
    'parts',
    'group_memberships',
    'steps',
    'choreo_segments'
  ];
begin
  foreach t in array tables loop
    -- RLS aktivieren (blockt standardmäßig alles, bis eine Policy es erlaubt)
    execute format('alter table public.%I enable row level security;', t);

    -- Alle bereits vorhandenen Policies dieser Tabelle entfernen,
    -- damit garantiert keine alte anonyme Leseregel übrig bleibt.
    for pol in
      select policyname
      from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I;', pol.policyname, t);
    end loop;

    -- Nur angemeldete Nutzer dürfen lesen …
    execute format($f$
      create policy "auth_select_%1$s" on public.%1$I
        for select to authenticated using (true);
    $f$, t);

    -- … und nur angemeldete Nutzer dürfen schreiben (einfügen/ändern/löschen).
    execute format($f$
      create policy "auth_insert_%1$s" on public.%1$I
        for insert to authenticated with check (true);
    $f$, t);
    execute format($f$
      create policy "auth_update_%1$s" on public.%1$I
        for update to authenticated using (true) with check (true);
    $f$, t);
    execute format($f$
      create policy "auth_delete_%1$s" on public.%1$I
        for delete to authenticated using (true);
    $f$, t);
  end loop;
end $$;

-- ============================================================================
--  OPTIONAL: Audio-Dateien ebenfalls privat schalten
--  ----------------------------------------------------------------------------
--  Die Projekt-DATEN sind nach obigem Skript privat. Die zugehörigen
--  Audio-Dateien liegen im Storage-Bucket „audio-tracks". Ist dieser Bucket
--  öffentlich, könnte jemand mit direktem Datei-Link die Musik trotzdem laden
--  (die Projektliste bleibt aber verborgen).
--
--  Wenn auch die Audio-Dateien nur für Angemeldete erreichbar sein sollen:
--   1) Im Dashboard unter Storage den Bucket „audio-tracks" auf PRIVATE setzen
--      (Public-Schalter aus). Die App lädt dann über die authentifizierte
--      Session – für nicht angemeldete Besucher ist die Musik dann nicht mehr
--      abrufbar.
--   2) Zusätzlich diese Policies setzen (nur nötig, wenn keine passenden
--      Storage-Policies existieren):
--
--  drop policy if exists "auth_read_audio"   on storage.objects;
--  drop policy if exists "auth_write_audio"  on storage.objects;
--  drop policy if exists "auth_update_audio" on storage.objects;
--  drop policy if exists "auth_delete_audio" on storage.objects;
--
--  create policy "auth_read_audio" on storage.objects
--    for select to authenticated using (bucket_id = 'audio-tracks');
--  create policy "auth_write_audio" on storage.objects
--    for insert to authenticated with check (bucket_id = 'audio-tracks');
--  create policy "auth_update_audio" on storage.objects
--    for update to authenticated using (bucket_id = 'audio-tracks');
--  create policy "auth_delete_audio" on storage.objects
--    for delete to authenticated using (bucket_id = 'audio-tracks');
-- ============================================================================
