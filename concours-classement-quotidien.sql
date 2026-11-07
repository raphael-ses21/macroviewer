-- =====================================================================
-- MacroViewer : classement quotidien des concours (ajout du 7 novembre 2026)
-- À coller une seule fois dans Supabase → SQL Editor, puis cliquer sur Run.
-- (C'est la partie 7 de concours.sql : inutile de relancer le reste.)
-- =====================================================================
create table if not exists public.daily_ranks (
  group_code  text not null references public.groups(code) on delete cascade,
  day         date not null,                -- jour (heure de Paris)
  player_id   uuid not null,
  pseudo      text not null,
  value       numeric not null,
  rank        int not null,
  saved_at    timestamptz not null default now(),
  primary key (group_code, day, player_id)
);
alter table public.daily_ranks enable row level security;
drop policy if exists "voir les classements du groupe" on public.daily_ranks;
create policy "voir les classements du groupe" on public.daily_ranks for select to authenticated
  using (public.is_member(group_code));
grant select on public.daily_ranks to authenticated;

-- Enregistre le classement du jour. Appelée par le site quand un participant regarde le concours.
-- Seul le jour en cours peut être réécrit : les jours passés sont figés.
-- Le dernier jour, le classement reste modifiable jusqu'à la fin du concours, puis il est figé.
create or replace function public.save_daily_rank(p_code text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare g public.groups; d date := (now() at time zone 'Europe/Paris')::date; n int;
begin
  if not public.is_member(p_code) then raise exception 'Réservé aux participants'; end if;
  select * into g from public.groups where code = p_code;
  if now() < g.starts_at then return 0; end if;                       -- pas encore commencé
  if now() > g.ends_at then
    d := (g.ends_at at time zone 'Europe/Paris')::date;               -- concours terminé : dernier jour
    if exists (select 1 from public.daily_ranks where group_code = p_code and day = d and saved_at > g.ends_at) then return 0; end if;
    if now() > g.ends_at + interval '1 day' then return 0; end if;
  end if;
  delete from public.daily_ranks where group_code = p_code and day = d;
  insert into public.daily_ranks (group_code, day, player_id, pseudo, value, rank)
    select p_code, d, m.player_id, m.pseudo, r.value,
           rank() over (order by r.value desc)
    from jsonb_to_recordset(p_rows) as r(player_id uuid, value numeric)
    join public.members m on m.group_code = p_code and m.player_id = r.player_id
    where r.value is not null and r.value >= 0 and r.value <= g.start_cash * 1000;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.save_daily_rank(text, jsonb) to authenticated;
