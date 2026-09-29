# Site de vendas na raiz do CRM

A raiz de `crm.hiperbold.com.br` (`/`) e `/precos` são a página de vendas do
HiperCRM, um site estático feito em Astro no repositório separado
`hipercrm-site` (`F:\github-projects\hipercrm-site`). O Next não builda esse
site: ele só serve os arquivos já prontos que moram em `public/site/`.

## De onde vem `public/site`

`public/site/` é gerado pelo build do `hipercrm-site` e copiado para cá. O
conteúdo em `public/site/` não é editado à mão neste repositório: qualquer
mudança de texto, preço ou layout da página de vendas é feita no
`hipercrm-site` e reexportada.

Arquivos que vivem em `public/site/`:
- `index.html` (home)
- `precos/index.html` (/precos)
- `_hipercrm/` (CSS e JS do build do Astro, nome escolhido para não colidir
  com `_next`)
- `og.png`, `favicon.svg`
- `sitemap-index.xml`, `sitemap-0.xml`
- `robots.txt` (escrito pelo próprio script de exportação, específico do CRM:
  libera `/` e bloqueia `/app`, `/admin`, `/api`)

Termos de Uso e Política de Privacidade do site de vendas NÃO entram aqui: o
CRM já tem as páginas legais dele em `/legal/terms` e `/legal/privacy`
(`app/legal/`), e o rodapé do site de vendas aponta para elas.

## Como atualizar

No repositório `hipercrm-site`:

```
npm run exportar:crm
```

Isso builda o Astro com `SITE_URL=https://crm.hiperbold.com.br` e copia o
resultado para `public/site/` deste repositório (por padrão, pelo caminho UNC
do WSL; aceita um caminho de destino como argumento). O script
(`scripts/exportar-para-crm.mjs`) limpa antes só os itens que ele mesmo copia,
não a pasta inteira.

Depois de rodar o export, revisar o `git diff` em `public/site/` e commitar
normalmente neste repositório (o `hipercrm-site` é outro repo, com seu
próprio commit separado).

## Roteamento

O Next serve essas páginas por `rewrites()` em `next.config.ts` (bloco
`beforeFiles`, para ganhar de `app/page.tsx`, que hoje redireciona `/` para
`/app`). `/precos` e os arquivos de topo (`robots.txt`, `sitemap*.xml`,
`og.png`, `favicon.svg`, `_hipercrm/**`) são reescritos para os arquivos
equivalentes dentro de `/site/`.

`/` e `/precos` são liberados sem sessão em `lib/auth/public-paths.ts` (o
matcher do `proxy.ts` já dispensa arquivos com extensão .css/.js/.svg/.png,
mas não .xml, por isso os dois sitemaps têm entrada própria ali).
