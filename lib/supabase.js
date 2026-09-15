import { createClient } from '@supabase/supabase-js'

// Fallback a los valores públicos (anon key, protegida por RLS) para que el
// build funcione igual en hosts donde no configuramos las env vars de Vercel
// manualmente. Son seguras de exponer en el bundle del cliente.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mmlpgdqhtisznltcyeyd.supabase.co'
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1tbHBnZHFodGlzem5sdGN5ZXlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNjUwNjUsImV4cCI6MjEwMjc0MTA2NX0.LH99zd1MnzpKXqdwiMCV-VY8KKBJkiC6Q1ejo2Kdoo0'

let supabaseInstance = null

export const getSupabase = () => {
  if (!supabaseInstance) {
    supabaseInstance = createClient(supabaseUrl, supabaseAnonKey)
  }
  return supabaseInstance
}

export const supabase = getSupabase()