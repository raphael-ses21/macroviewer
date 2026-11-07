-- =====================================================================
-- MacroViewer : base de données des groupes et concours de trading
-- À coller une seule fois dans Supabase : SQL Editor → New query → Run
-- =====================================================================

-- 1. Les groupes (un groupe = un concours)
create table if not exists public.groups (
  code        text primary key check (code ~ '^[A-Z0-9]{6}$'),
  name        text not null check (char_length(name) between 2 and 40),
  owner       uuid not null default auth.uid(),
  start_cash  numeric not null check (start_cash between 100 and 10000000),
  leverage    int not null default 1 check (leverage in (1, 2, 5, 10)),
  shorts      boolean not null default true,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz not null,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '366 days')
);

-- 2. Les participants et leur portefeuille dans le groupe
create table if not exists public.members (
  group_code  text not null references public.groups(code) on delete cascade,
  player_id   uuid not null default auth.uid(),
  pseudo      text not null check (char_length(pseudo) between 2 and 20),
  cash        numeric not null,
  pos         jsonb not null default '{}'::jsonb,
  trades      jsonb not null default '[]'::jsonb,
  value       numeric,
  joined_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (group_code, player_id)
);
create unique index if not exists members_pseudo_unique on public.members (group_code, lower(pseudo));

-- 3. Le journal de tous les ordres (pour vérifier qu'il n'y a pas de triche)
create table if not exists public.orders (
  id          bigint generated always as identity primary key,
  group_code  text not null,
  player_id   uuid not null default auth.uid(),
  asset       text not null,
  side        text not null check (side in ('buy', 'sell', 'short', 'cover', 'liquidation')),
  qty         numeric not null,
  amount_eur  numeric not null,
  at          timestamptz not null default now(),
  foreign key (group_code, player_id) references public.members (group_code, player_id) on delete cascade
);

-- 4. Est-ce que la personne connectée fait partie du groupe ?
create or replace function public.is_member(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where group_code = p_code and player_id = auth.uid());
$$;

-- 5. Rejoindre un groupe avec son code : le capital de départ est celui fixé par le créateur
create or replace function public.join_group(p_code text, p_pseudo text) returns public.members
language plpgsql security definer set search_path = public as $$
declare g public.groups; m public.members;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select * into g from public.groups where code = upper(trim(p_code));
  if not found then raise exception 'Code inconnu'; end if;
  if now() > g.ends_at then raise exception 'Ce concours est terminé'; end if;
  select * into m from public.members where group_code = g.code and player_id = auth.uid();
  if found then return m; end if;
  insert into public.members (group_code, player_id, pseudo, cash)
    values (g.code, auth.uid(), trim(p_pseudo), g.start_cash) returning * into m;
  return m;
end $$;

-- 6. Les règles d'accès
alter table public.groups  enable row level security;
alter table public.members enable row level security;
alter table public.orders  enable row level security;

drop policy if exists "voir mes groupes" on public.groups;
create policy "voir mes groupes" on public.groups for select to authenticated
  using (owner = auth.uid() or public.is_member(code));
drop policy if exists "créer un groupe" on public.groups;
create policy "créer un groupe" on public.groups for insert to authenticated
  with check (owner = auth.uid() and starts_at >= now() - interval '10 minutes');

drop policy if exists "voir le classement" on public.members;
create policy "voir le classement" on public.members for select to authenticated
  using (public.is_member(group_code));
-- on ne modifie que son propre portefeuille, et seulement pendant le concours
drop policy if exists "jouer pendant le concours" on public.members;
create policy "jouer pendant le concours" on public.members for update to authenticated
  using (player_id = auth.uid())
  with check (player_id = auth.uid() and exists (
    select 1 from public.groups g
    where g.code = members.group_code and now() between g.starts_at and g.ends_at + interval '5 minutes'));

drop policy if exists "voir les ordres du groupe" on public.orders;
create policy "voir les ordres du groupe" on public.orders for select to authenticated
  using (public.is_member(group_code));
drop policy if exists "enregistrer mes ordres" on public.orders;
create policy "enregistrer mes ordres" on public.orders for insert to authenticated
  with check (player_id = auth.uid() and public.is_member(group_code));

grant select, insert on public.groups to authenticated;
grant select, update on public.members to authenticated;
grant select, insert on public.orders to authenticated;
grant execute on function public.join_group(text, text) to authenticated;
grant execute on function public.is_member(text) to authenticated;

-- =====================================================================
-- 7. Classement quotidien sauvegardé (ajout du 7 novembre 2026)
--    Si la base existe déjà, il suffit de coller et lancer CETTE PARTIE.
--    Chaque jour du concours, le classement est enregistré : on peut ensuite
--    revoir le classement de n'importe quel jour passé.
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
-- p_rows : [{"player_id": "...", "value": 10234.5}, ...] ; le pseudo et le rang sont calculés ici.
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
