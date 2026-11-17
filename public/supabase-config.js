const SUPABASE_URL = "https://cczmbzakpoxcoikukiqp.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_:[YOUR-PASSWORD:5432/postgres";

window.tobySupabase = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);
