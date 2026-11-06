# Painel Ricardo Mello · Exponential

Dashboard estático de performance (Meta Ads + RD Station) que **se atualiza sozinho de hora em hora**.

```
index.html   →  lê  →  data.json  (Meta)   +   rd.json  (RD Station, sem dados pessoais)
                        ▲                         ▲
                        │ commit automático a cada hora (mesmo workflow)
              .github/workflows/update-data.yml
                        │                         │
              scripts/fetch-meta.mjs       scripts/fetch-rd.mjs  →  API da RD Station Marketing
                                                  │
                                                  └→ ramo rd-dados: leads.enc (nome, e-mail, empresa,
                                                     criptografados com a senha do painel) e state.enc
```

O HTML é 100% estático — nenhum servidor, nenhuma chave exposta no navegador. Quem chama a Meta é o **GitHub Actions** (nos bastidores), usando um token guardado como *secret*.

---

## Passo a passo (3 etapas · ~10 min)

### 1) Gerar o token da Meta (System User — não expira)

1. Acesse **[business.facebook.com](https://business.facebook.com)** → **Configurações do Negócio**.
2. **Usuários → Usuários do sistema** → *Adicionar* → crie um System User (função **Admin**).
3. Em **Ativos atribuídos**, adicione a **conta de anúncios** `EXPONENTIAL NOVO 2025` (ID `2895948854126435`) com permissão total.
4. Clique em **Gerar novo token** → escolha o App → marque os escopos **`ads_read`** e **`read_insights`**.
5. Copie o token gerado. *(System User token não expira — ideal para automação.)*

### 2) Guardar o token como secret do repositório

No repositório: **Settings → Secrets and variables → Actions → New repository secret**
- **Name:** `META_TOKEN`  ·  **Value:** _(cole o token)_
- *(Opcional)* `AD_ACCOUNT_ID` = `2895948854126435` — já é o padrão no script, só use se mudar de conta.

### 3) Ligar o GitHub Pages

**Settings → Pages → Build and deployment → Source: _Deploy from a branch_ → Branch: `main` / `/ (root)` → Save.**
Em ~1 min o painel fica no ar em `https://<seu-usuario>.github.io/<repo>/`.

> **Visibilidade:** o GitHub Pages só publica de repositório **público** no plano grátis (ou **privado** com GitHub Pro). Como o painel expõe métricas do cliente, decida: manter privado (Pro) ou público com uma URL discreta.

---

## Rodar a atualização agora (sem esperar a hora cheia)

**Actions → Atualizar dados Meta Ads → Run workflow.**
O job puxa a Meta e a RD, reescreve `data.json` e `rd.json` e faz commit — o Pages republica sozinho.

## Ajustes rápidos
- **Frequência:** edite o `cron` em `.github/workflows/update-data.yml` (`0 * * * *` = de hora em hora; `0 */6 * * *` = a cada 6h).
- **Período das métricas:** `date_preset` em `scripts/fetch-meta.mjs` (`last_30d`, `last_7d`…).
- **Visual / lógica de objetivo:** tudo em `index.html` (função `classify`).

## Próxima etapa
Tempo até o primeiro contato e tempo parado em cada etapa: dependem de um token da **API do RD Station CRM** (a API do Marketing só mostra a etapa atual).

---

## RD Station: aba CRM / Comercial e jornada do lead (desde 06/11/2026)

`scripts/fetch-rd.mjs` roda no mesmo workflow, logo depois da Meta. Ele usa o app OAuth "App RD Corvo - Integração Exponencial" e:

- lê os contatos com conversão nova desde a última rodada (conversões, UTMs e campos do cadastro);
- relê a etapa, o dono, o valor e o motivo de perda do RD CRM (gravados no contato como `cf_plug_*`), cerca de 300 contatos por rodada, começando pelos recentes e pelos que ainda estão em aberto;
- grava `rd.json` no main, **sem nome, e-mail, telefone ou empresa**;
- grava no ramo `rd-dados` (um commit só, sobrescrito a cada rodada): `leads.enc`, com nome, e-mail e empresa criptografados com a senha do painel, e `state.enc`, o estado da sincronização criptografado com `RD_STATE_KEY`.

A lista de leads da aba CRM só mostra nome e e-mail depois que a pessoa digita a senha (o navegador baixa o `leads.enc` e abre com a senha). Telefone não entra no painel.

**Secrets do repositório:** `RD_CLIENT_ID`, `RD_CLIENT_SECRET`, `RD_REFRESH_TOKEN`, `RD_STATE_KEY` (32 bytes em base64) e `PAINEL_SENHA`. Os valores ficam também no `corvo-infra.env` da Corvo.

**Trocar a senha do painel:** mude o secret `PAINEL_SENHA` (e o `corvo-infra.env`). A próxima rodada recriptografa o `leads.enc`; quem tinha a senha antiga salva no aparelho precisa digitar a nova.

**Funil de cada lead:** vem do identificador da conversão (`diagnostico-dre` = Planilha DRE, `dre-inteligente*` = DRE Inteligente, `imersao*` = Imersão, `diag*` = Diagnóstico). Na Meta, o mesmo funil vem do nome da campanha (`classify` no `index.html`). O filtro "Funil / oferta" do painel usa os dois.

**Cadastros de teste** (e-mails internos, UTMs de teste) ficam fora pela lista `TEST` em `scripts/fetch-rd.mjs`.

A ordem das etapas fica em `CRM_STAGES` no `index.html`; etapa nova que aparecer no CRM entra sozinha antes de "Vendido".

O antigo `crm.json` (exportação manual em CSV, com nome e e-mail abertos) foi removido do repositório e do histórico em 06/11/2026.
