/**
 * D-135, três sobras pequenas:
 * - clique na bandeja: a origem se compara por `new URL(...).origin`, não por prefixo
 *   de texto (`https://crm.exemplo.com.br.evil.com` passava no `startsWith`);
 * - o service worker só abre destino da mesma origem;
 * - o log de envio sem Resend não publica destinatário nem prévia do corpo (que traz
 *   link de convite ou de recuperação de senha).
 *
 * A lógica de origem é extraída dos arquivos e EXECUTADA com URLs hostis.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ler = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

const ORIGEM = "https://crm.exemplo.com.br";

/** Reproduz o trecho do service worker que decide a URL de destino. */
function destinoDoServiceWorker(href: string): string {
  const fonte = ler("public/notify-sw.js");
  const ini = fonte.indexOf("let destino = null;");
  const fim = fonte.indexOf("const alvo = clientes.find");
  expect(ini, "o trecho de destino sumiu do notify-sw.js").toBeGreaterThan(-1);
  const trecho = fonte.slice(ini, fim);
  return new Function("href", "origem", `${trecho}\nreturn url;`)(href, ORIGEM) as string;
}

describe("notify-sw.js: destino do clique", () => {
  it.each([
    ["/app/inbox?c=1", `${ORIGEM}/app/inbox?c=1`],
    [`${ORIGEM}/app/leads`, `${ORIGEM}/app/leads`],
    ["", `${ORIGEM}/app/inbox`],
  ])("%j abre %j", (href, esperado) => {
    expect(destinoDoServiceWorker(href)).toBe(esperado);
  });

  it.each([
    ["https://crm.exemplo.com.br.evil.com/x"],
    ["https://evil.com/"],
    ["//evil.com/x"],
    ["http://crm.exemplo.com.br/x"],
    ["https://crm.exemplo.com.br@evil.com/x"],
  ])("destino de outra origem (%j) cai na caixa de entrada", (href) => {
    expect(destinoDoServiceWorker(href)).toBe(`${ORIGEM}/app/inbox`);
  });
});

describe("notify_open.ts", () => {
  const fonte = ler("lib/notifications/notify_open.ts");
  it("compara a origem pelo URL, não por prefixo de texto", () => {
    expect(fonte).not.toMatch(/startsWith\(window\.location\.origin\)/);
    expect(fonte).toContain("destino.origin !== window.location.origin");
  });
});

describe("lib/email/resend.ts: log de desenvolvimento", () => {
  const fonte = ler("lib/email/resend.ts");
  const aviso = fonte.slice(fonte.indexOf("envio desligado"), fonte.indexOf('error: "not_configured"'));
  it("não loga destinatário nem prévia do corpo", () => {
    expect(aviso.length).toBeGreaterThan(0);
    expect(aviso).not.toContain("args.to");
    expect(aviso).not.toContain("preview");
    expect(aviso).not.toMatch(/args\.(html|text)/);
  });
});
