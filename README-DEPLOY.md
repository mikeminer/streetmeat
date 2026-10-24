# streetmeatgame.com – Guida al deploy del sito (GitHub Pages + Register.it)

Questa cartella è il clone di `mikeminer/streetmeat` con le modifiche pronte (non ancora committate).
Il sito resta su GitHub Pages (workflow `.github/workflows/pages.yml`, cartella `docs/`); il DNS resta su **Register.it**.

## 1. Commit e push
```bash
cd streetmeatgame-site
git status            # controlla i file modificati/nuovi
git add -A
git commit -m "streetmeatgame.com: custom domain, assetlinks, favicon, Cloudflare RPC proxy in privacy"
git push origin main
```
(oppure applica la patch su un altro clone: `git apply --index streetmeatgame-site-v0.1.6.patch`).
Il workflow ora crea l'archivio con `tar` invece di `upload-pages-artifact`, perché quest'ultimo esclude le cartelle che iniziano con un punto e quindi **non pubblicherebbe `.well-known/assetlinks.json`**.
Controlla in **Actions** che il deploy "pages" sia verde.

## 2. GitHub Pages
Repo → **Settings → Pages**:
- *Source*: **GitHub Actions** (già così).
- *Custom domain*: `streetmeatgame.com` → **Save**. (Il file `docs/CNAME` è incluso ma con il deploy da Actions conta l'impostazione qui.)
- Facoltativo ma consigliato: verifica il dominio in **Settings del tuo account → Pages → Add a domain** (record TXT `_github-pages-challenge-mikeminer` da aggiungere su Register.it) per evitare che altri lo usino.

## 3. DNS su Register.it
Area clienti Register.it → **Domini** → `streetmeatgame.com` → **Gestione DNS** (DNS / record del dominio).
1. **Elimina** i record di parcheggio esistenti: il record **A** di `streetmeatgame.com` (@) e l'eventuale A/CNAME di `www`.
2. Aggiungi per il dominio principale (nome vuoto / `@`):

| Tipo | Nome | Valore |
|------|------|--------|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| AAAA | @ | 2606:50c0:8000::153 |
| AAAA | @ | 2606:50c0:8001::153 |
| AAAA | @ | 2606:50c0:8002::153 |
| AAAA | @ | 2606:50c0:8003::153 |
| CNAME | www | mikeminer.github.io. |

3. Lascia i nameserver `ns1.register.it` / `ns2.register.it`. Non serve nessun record per l'RPC (il proxy usa `*.workers.dev`).
4. Attendi la propagazione (da minuti a qualche ora). Controllo: `dig +short streetmeatgame.com` deve mostrare i 4 IP 185.199.x.153.

## 4. HTTPS
Settings → Pages: quando il controllo DNS diventa verde e il certificato è emesso (fino a ~1 ora), spunta **Enforce HTTPS**.

## 5. Verifiche
- https://streetmeatgame.com/ (homepage), https://streetmeatgame.com/privacy/ , https://streetmeatgame.com/terms/
- https://streetmeatgame.com/favicon.ico (icona che il wallet mostra per l'app)
- https://streetmeatgame.com/.well-known/assetlinks.json (deve restituire il JSON, `Content-Type: application/json`)
- Google Digital Asset Links:
  https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://streetmeatgame.com&relation=delegate_permission/common.handle_all_urls
  deve elencare `app.streetmeat.game` con l'impronta `6F:D7:80:9B:…:DD:BB:FB`.
- Il vecchio indirizzo https://mikeminer.github.io/streetmeat/ reindirizza automaticamente al dominio.
  **Jupiter:** l'endpoint del circulating supply diventa https://streetmeatgame.com/api/circulating-supply.json (il vecchio URL reindirizza; se Jupiter non segue i redirect, aggiorna l'URL da loro).

## 6. Dopo
- Pubblica il proxy RPC (`/workspace/streetmeatgame-rpc-proxy/README-DEPLOY.md`) e ricompila l'app v0.1.6 con l'URL `workers.dev`.
- Invia le richieste di verifica in `verification-requests.md` (Phantom, Blowfish, Blockaid) quando il sito è online.
- Valuta un indirizzo `support@streetmeatgame.com` al posto di `welcome@devfridge.cool` nelle pagine.
