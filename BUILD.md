# Como gerar o instalador Windows do KyberFood Desktop

O app desktop é um projeto Tauri (Windows). O instalador `.exe`/`.msi` **precisa ser
gerado no Windows**. Há duas formas:

## Opção A — GitHub Actions (recomendada, sem precisar de máquina Windows)

Há um workflow pronto em `.github/workflows/desktop-build.yml` que builda no Windows
e disponibiliza o instalador para download.

**1. Configure os segredos do repositório** (uma vez só):
GitHub → Settings → Secrets and variables → Actions → New repository secret:

- `VITE_SUPABASE_URL` — URL do projeto Supabase
- `VITE_SUPABASE_ANON_KEY` — chave anon do Supabase
- `VITE_API_URL` — URL do app web em produção (ex.: `https://kyberfood.com.br`)

**2. Rode o workflow:**
GitHub → aba **Actions** → **Build App Desktop (Windows)** → **Run workflow**.

**3. Baixe o instalador:**
Ao terminar (~5–10 min), abra a execução e baixe o artefato
**`kyberfood-desktop-windows`** (contém o `.exe` do NSIS e o `.msi`).

Também é possível disparar publicando uma tag `desktop-v*` (ex.: `git tag desktop-v1.0.1 && git push origin desktop-v1.0.1`).

## Opção B — build local no Windows

Requisitos: Windows + Node 20 + Rust (via https://rustup.rs) + WebView2 (já vem no Windows 10/11).

```bash
cd kyberfood-desktop
# crie o .env de produção (veja .env.example)
npm install
npm run tauri:build
```

O instalador sai em `src-tauri/target/release/bundle/nsis/*.exe` e `.../msi/*.msi`.

## Link de download que os clientes usam (botão "Baixar App")

A página de Integrações mostra um botão **Baixar App** que abre a URL configurada em
`system_configurations` (chave `desktop_app_version`, campo `download_url_win`).

O workflow de Actions publica cada build numa **Release do GitHub** com nome de arquivo
FIXO (`KyberFood-Setup.exe`). Por isso, o link abaixo **serve sempre a versão mais nova**
automaticamente — configure uma vez e não precisa mexer a cada build:

```
https://github.com/BrunoPaulinoF/kyberfood/releases/latest/download/KyberFood-Setup.exe
```

Como configurar (uma vez): entre no painel **/admin** → seção **App Desktop** → cole o
link acima em "Link de download (Windows)" → **Salvar link**. (Também dá para hospedar o
`.exe` em outro lugar, ex.: seu próprio servidor/CDN, e colar essa URL — o botão abre o
que estiver salvo aqui.)

## Distribuição

Toda vez que você rodar o workflow (ou publicar uma tag `desktop-v*`), a Release
`desktop-latest` é atualizada com o instalador novo, e o botão "Baixar App" passa a
baixar a versão nova sem nenhuma alteração no painel. Instalar por cima da versão antiga
funciona. Esta versão passa a enviar o token de sessão nas chamadas à API — a versão
anterior recebia 401 ao listar/atualizar pedidos.
