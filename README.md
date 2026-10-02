# Painel Ricardo Mello · Exponential

Dashboard estático de performance (Meta Ads) que **se atualiza sozinho de hora em hora**.

```
index.html   →  lê  →  data.json        (GitHub Pages serve os dois)
                        ▲
                        │ commit automático a cada hora
              .github/workflows/update-data.yml
                        │
              scripts/fetch-meta.mjs  →  Meta Marketing API
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
O job puxa a Meta, reescreve `data.json` e faz commit — o Pages republica sozinho.

## Ajustes rápidos
- **Frequência:** edite o `cron` em `.github/workflows/update-data.yml` (`0 * * * *` = de hora em hora; `0 */6 * * *` = a cada 6h).
- **Período das métricas:** `date_preset` em `scripts/fetch-meta.mjs` (`last_30d`, `last_7d`…).
- **Visual / lógica de objetivo:** tudo em `index.html` (função `classify`).

## Próxima etapa
Integrar **RD Station** (venda faturada + conversas de WhatsApp) e habilitar **taxa de conexão** (evento LPV no pixel).

---

## Aba CRM / Comercial (leads por etapa do CRM)

Lê o `crm.json`, gerado a partir da exportação de cadastros do CRM. **Não** atualiza de hora em hora: muda quando uma nova exportação é importada.

Para atualizar:

```bash
node scripts/import-crm.mjs caminho/para/cadastros-AAAA-MM-DD.csv
git add crm.json && git commit -m "crm: exportação AAAA-MM-DD" && git push
```

O script tira os cadastros de teste da equipe e os descartados, junta quem preencheu mais de uma vez (vale a etapa mais recente no CRM) e **não leva o telefone** para o painel (só nome e e-mail).
A ordem das etapas fica em `CRM_STAGES` no `index.html`; etapa nova que aparecer na exportação entra sozinha antes de "Vendido".
