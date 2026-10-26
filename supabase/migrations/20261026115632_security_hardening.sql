-- Restrict application table access to authenticated owners.
-- The browser uses the public anon key; it must not have direct table privileges.
begin;

revoke all privileges on table public.user_data from anon, authenticated;
revoke all privileges on table public.app_data from anon, authenticated;
revoke all privileges on table public.push_subscriptions from anon, authenticated;
revoke all privileges on table public.reminders_sent from anon, authenticated;

grant select, insert, update, delete on table public.user_data to authenticated;
grant select, insert, update, delete on table public.app_data to authenticated;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

drop policy if exists "Users can delete their own data" on public.app_data;
drop policy if exists "Users can insert their own data" on public.app_data;
drop policy if exists "Users can update their own data" on public.app_data;
drop policy if exists "Users can view their own data" on public.app_data;
create policy "Users can delete their own data" on public.app_data
  for delete to authenticated using ((select auth.uid()) = user_id);
create policy "Users can insert their own data" on public.app_data
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update their own data" on public.app_data
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users can view their own data" on public.app_data
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "delete own subs" on public.push_subscriptions;
drop policy if exists "insert own subs" on public.push_subscriptions;
drop policy if exists "select own subs" on public.push_subscriptions;
drop policy if exists "update own subs" on public.push_subscriptions;
create policy "delete own subs" on public.push_subscriptions
  for delete to authenticated using ((select auth.uid()) = user_id);
create policy "insert own subs" on public.push_subscriptions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "select own subs" on public.push_subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "update own subs" on public.push_subscriptions
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own data" on public.user_data;
create policy "Users manage their own data" on public.user_data
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- The server-side reminder function uses service_role. End users cannot access
-- this internal delivery ledger.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;

commit;
