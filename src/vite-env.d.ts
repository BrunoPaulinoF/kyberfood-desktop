/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_API_URL: string
  /** '1' só no build da versão Windows 7 (workflow desktop-build-win7.yml). */
  readonly VITE_KYBERFOOD_WIN7?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
