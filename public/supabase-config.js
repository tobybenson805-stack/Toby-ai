const SUPABASE_URL = https://cczmbzakpoxcoikukiqp.supabase.co
const SUPABASE_PUBLISHABLE_KEY = "PASTE_YOUR_PUBLISHABLE_KEY";

window.tobySupabase = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);
