-- Apply to the existing Steady project after its tables and policies are present.
-- The policy expressions preserve the existing owner-only access rules while
-- evaluating auth.uid() once per statement instead of once per row.

ALTER POLICY "Users manage their own data"
  ON public.user_data
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can view their own data"
  ON public.app_data
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can insert their own data"
  ON public.app_data
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can update their own data"
  ON public.app_data
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can delete their own data"
  ON public.app_data
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "select own subs"
  ON public.push_subscriptions
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "insert own subs"
  ON public.push_subscriptions
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "update own subs"
  ON public.push_subscriptions
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "delete own subs"
  ON public.push_subscriptions
  USING ((SELECT auth.uid()) = user_id);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON public.push_subscriptions (user_id);

