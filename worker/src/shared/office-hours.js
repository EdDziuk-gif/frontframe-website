import { DAY_NAMES, formatTime12 } from "./runtime.js";
import { supabaseFetch } from "./supabase.js";

export async function getTodayOfficeHoursText(env) {
  try {
    const today     = getPhoenixDateStr();
    const dayOfWeek = getPhoenixDayOfWeek();
    const overrides = await supabaseFetch(env, "office_hours_overrides",
      `?override_date=eq.${today}&select=open_time,close_time,is_closed`);
    const hours = overrides?.length
      ? overrides[0]
      : (await supabaseFetch(env, "office_hours_schedule", `?day_of_week=eq.${dayOfWeek}&select=open_time,close_time,is_closed`))?.[0] ?? null;
    if (!hours) return "";
    const dayName   = DAY_NAMES[dayOfWeek];
    const dateLabel = new Date().toLocaleDateString("en-US", {
      timeZone: "America/Phoenix", month: "long", day: "numeric", year: "numeric",
    });
    if (hours.is_closed)
      return `[Office hours context: Today is ${dayName}, ${dateLabel}. FrontFrame is closed today. Responses will be provided the next business day. Share this when visitors ask about response times or hours.]`;
    const open  = formatTime12(hours.open_time);
    const close = formatTime12(hours.close_time);
    return `[Office hours context: Today is ${dayName}, ${dateLabel}. FrontFrame office hours: ${open} to ${close} Arizona time (no DST). Responses are typically provided within one business day during open hours. Share this when visitors ask about response times or hours.]`;
  } catch (e) {
    console.error("getTodayOfficeHoursText failed:", e.message);
    return "";
  }
}


// ════════════════════════════════════════════════════════════════════════════
