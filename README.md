# KyberFood Desktop

App desktop (Tauri + React + Vite) do KyberFood para **Windows**: recebe os
pedidos em tempo real e imprime a comanda na impressora térmica.

Este repositório é **público apenas para viabilizar o build grátis do instalador
Windows** via GitHub Actions (runner `windows-latest`). Ele contém somente o
**cliente desktop**, que fala com o Supabase pela chave **anon** (pública por
natureza, protegida por RLS) e com a API pública do KyberFood. Nenhum segredo de
backend vive aqui — o núcleo do SaaS permanece em repositório privado.

## Build automático

A cada push na `main`, o workflow **Build App Desktop (Windows)** gera o
instalador, incrementa o patch da versão e publica a Release fixa
`desktop-latest` — cujo link de download é sempre o mesmo:

- Instalador: `https://github.com/BrunoPaulinoF/kyberfood-desktop/releases/latest/download/KyberFood-Setup.exe`
- Manifesto de update: `.../releases/latest/download/latest.json`

O próprio app consulta o `latest.json` e oferece (sem obrigar) a atualização.

Também dá para disparar manualmente em **Actions → Build App Desktop → Run
workflow**, informando a versão, ou criando uma tag `desktop-v*`.

## Desenvolvimento

```bash
npm install
npm run tauri:dev     # app em modo dev (Vite na porta 1420)
npm run tauri:build   # gera o instalador localmente (precisa de toolchain Windows)
```

As variáveis `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` e `VITE_API_URL`
(arquivo `.env`, modelo em `.env.example`) são **opcionais**: sem elas, o app usa
os valores de produção embutidos (`FALLBACK_*` em `src/App.tsx`).
