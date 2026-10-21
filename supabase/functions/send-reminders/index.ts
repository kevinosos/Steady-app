// Steady — send-reminders
//
// This runs on Supabase's servers (not in anyone's browser), on a schedule.
// Each run: look at everyone who has reminders turned on, work out what's
// due right now in their own timezone, and push it to their device(s).
//
// Secrets this function needs (set once with `supabase secrets set`):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (service role — server-side only, never shipped to the browser)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. "mailto:you@example.com")

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

// How far back we're willing to look for a reminder we might have missed
// between runs. Keep this a little wider than the cron interval so a slow
// run never silently skips someone.
const WINDOW_MINUTES = 10;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function fmtDateInTz(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function hhmmInTz(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("hour")}:${get("minute")}`;
}
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function getMondayKey(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}
// Is `reminderHHMM` due right now, i.e. in the last WINDOW_MINUTES up to and including now?
function isDue(reminderHHMM: string, nowHHMM: string): boolean {
  const r = toMinutes(reminderHHMM);
  const n = toMinutes(nowHHMM);
  return r <= n && r > n - WINDOW_MINUTES;
}

async function alreadySent(userId: string, itemKey: string, dateKey: string): Promise<boolean> {
  const { data, error } = await sb
    .from("reminders_sent")
    .select("user_id")
    .eq("user_id", userId).eq("item_key", itemKey).eq("sent_date", dateKey)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}
async function markSent(userId: string, itemKey: string, dateKey: string) {
  const { error } = await sb
    .from("reminders_sent")
    .insert({ user_id: userId, item_key: itemKey, sent_date: dateKey });
  if (error) throw error;
}

async function pushToUser(subs: any[], payload: Record<string, unknown>): Promise<number> {
  const body = JSON.stringify(payload);
  let deliveredCount = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
      deliveredCount++;
    } catch (err: any) {
      // 404/410 = the browser has unsubscribed or the device is gone for good; stop trying it.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      } else {
        console.error("push failed for", sub.endpoint, err?.statusCode, err?.body || err?.message);
      }
    }
  }
  return deliveredCount;
}

Deno.serve(async () => {
  const now = new Date();
  const { data: subs, error } = await sb.from("push_subscriptions").select("*");
  if (error) return new Response("subscription query failed: " + error.message, { status: 500 });
  if (!subs || subs.length === 0) return new Response("no subscriptions", { status: 200 });

  const byUser = new Map<string, any[]>();
  for (const s of subs) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id)!.push(s);
  }

  let sentCount = 0;

  for (const [userId, userSubs] of byUser) {
    // Use the most recently added device's timezone as this user's timezone.
    const tz = userSubs.reduce((a, b) => (a.created_at > b.created_at ? a : b)).timezone || "UTC";
    const todayKey = fmtDateInTz(now, tz);
    const nowHHMM = hhmmInTz(now, tz);
    const mondayKey = getMondayKey(todayKey);

    const [{ data: habitsRow }, { data: weekRow }] = await Promise.all([
      sb.from("user_data").select("value").eq("user_id", userId).eq("key", "habits-global").maybeSingle(),
      sb.from("user_data").select("value").eq("user_id", userId).eq("key", "week:" + mondayKey).maybeSingle(),
    ]);

    // ---- habits: remind once a day, only if not already checked off ----
    const habitsData = habitsRow?.value || { habits: [], checks: {} };
    for (const h of habitsData.habits || []) {
      if (!h.reminderTime) continue;
      if (h.createdAt && todayKey < h.createdAt) continue;
      const checked = !!(habitsData.checks?.[todayKey]?.[h.id]);
      if (checked) continue;
      if (!isDue(h.reminderTime, nowHHMM)) continue;

      const itemKey = `habit:${h.id}`;
      if (await alreadySent(userId, itemKey, todayKey)) continue;

      const deliveredCount = await pushToUser(userSubs, {
        title: "Steady",
        body: h.type === "quit" ? `Stay clean today: ${h.name}` : `Reminder: ${h.name}`,
        tag: itemKey,
        url: "./",
      });
      if (deliveredCount > 0) {
        await markSent(userId, itemKey, todayKey);
        sentCount++;
      }
    }

    // ---- tasks: remind once, only if not already done ----
    const dayTasks = weekRow?.value?.[todayKey]?.tasks || [];
    for (const t of dayTasks) {
      if (!t.remind || !t.time || !t.id || t.done) continue;
      if (!isDue(t.time, nowHHMM)) continue;

      const itemKey = `task:${t.id}`;
      if (await alreadySent(userId, itemKey, todayKey)) continue;

      const deliveredCount = await pushToUser(userSubs, {
        title: "Steady",
        body: t.text,
        tag: itemKey,
        url: "./",
      });
      if (deliveredCount > 0) {
        await markSent(userId, itemKey, todayKey);
        sentCount++;
      }
    }
  }

  return new Response(`ok, sent ${sentCount} reminder(s)`, { status: 200 });
});
