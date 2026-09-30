import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-083, achado 1: a foto de perfil vem de uma URL que o servidor do canal
 * devolve, e o servidor do canal (UAZAPI) é escolhido pela ORGANIZAÇÃO. O cron
 * baixava com `fetch` puro, seguindo redirect, e gravava os bytes no bucket
 * `whatsapp-media`, que a própria organização lê: um servidor falso apontava a
 * "foto" para `169.254.169.254` e lia a resposta interna.
 *
 * Aqui a régua de destino de organização roda DE VERDADE (só o DNS e a rede são
 * simulados), e o que se prova é o comportamento: destino interno, redirect e
 * conteúdo que não é imagem NÃO saem nem gravam; o controle positivo (destino
 * público, imagem de verdade) grava.
 */

const CONTATO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAMINHO = `${ORG}/avatars/${CONTATO}.jpg`;

/** O que o canal devolve como URL da foto; cada teste ajusta. */
let urlDaFoto = "";
/** O que a "rede" responde por URL. */
let respostas: Record<string, () => Response> = {};
const fetchCalls: { url: string; init: RequestInit | undefined }[] = [];
const uploads: { caminho: string; contentType: string; bytes: number }[] = [];
const carimbos: Record<string, unknown>[] = [];
const dnsPedidos: string[] = [];

/** Nome → endereços que o DNS de teste devolve. */
const DNS: Record<string, string[]> = {
  "cdn.publico.exemplo": ["93.184.216.34"],
  "rebinding.exemplo": ["10.0.0.5"],
};

vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => {
    dnsPedidos.push(host);
    const enderecos = DNS[host];
    if (!enderecos) throw new Error("ENOTFOUND");
    return enderecos.map((address) => ({ address, family: 4 }));
  };
  // O default é obrigatório: sem ele o vitest recusa o mock na coleta.
  return { lookup, default: { lookup } };
});

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste", IA_DESTINOS_INTERNOS_PERMITIDOS: "" },
}));

vi.mock("@/lib/channels", () => ({
  DEFAULT_CHANNEL_PROVIDER: "waha",
  getAdapter: () => ({ fetchProfilePictureUrl: async () => urlDaFoto }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const dados =
          tabela === "contacts"
            ? [{ id: CONTATO, organization_id: ORG, wa_identity: "phone:+5511999990000", avatar_storage_path: null }]
            : { waha_session_name: "sessao-de-teste", provider: "waha" };
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados, error: null }).then(ok);
              }
              if (prop === "maybeSingle") return async () => ({ data: dados, error: null });
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      update: (patch: Record<string, unknown>) => {
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "select") {
                return () => {
                  carimbos.push(patch);
                  return Promise.resolve({ data: [{ id: CONTATO }], error: null });
                };
              }
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      upsert: async () => ({ error: null }),
    }),
    storage: {
      from: () => ({
        upload: async (caminho: string, buf: Buffer, opcoes: { contentType: string }) => {
          uploads.push({ caminho, contentType: opcoes.contentType, bytes: buf.byteLength });
          return { error: null };
        },
      }),
    },
  }),
}));

import { POST } from "@/app/api/v1/cron/contact-avatars/route";
import { tipoDeImagemPelaAssinatura } from "@/lib/channels/avatar-download";

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20];

const imagem = (bytes: number[], extra = 0) =>
  new Response(new Uint8Array([...bytes, ...new Array(extra).fill(0)]), { status: 200 });

beforeEach(() => {
  urlDaFoto = "";
  respostas = {};
  fetchCalls.length = 0;
  uploads.length = 0;
  carimbos.length = 0;
  dnsPedidos.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, init });
      const resposta = respostas[url];
      if (!resposta) throw new Error(`rede: ninguém atende ${url}`);
      return resposta();
    }),
  );
});

async function rodar(): Promise<{ status: number; corpo: { data: { updated: number; failed: number } } }> {
  const res = await POST(
    new Request("http://localhost/api/v1/cron/contact-avatars", {
      method: "POST",
      headers: { authorization: "Bearer segredo-de-teste" },
    }) as never,
  );
  return { status: res.status, corpo: (await res.json()) as never };
}

/** Nenhum carimbo pode ter apontado um arquivo, e nada subiu ao bucket. */
function nadaGravado(): void {
  expect(uploads).toEqual([]);
  expect(carimbos.some((c) => "avatar_storage_path" in c)).toBe(false);
}

describe("cron de fotos: destino escolhido pela organização", () => {
  it("URL de foto no metadata de nuvem (169.254.169.254) não sai e não grava", async () => {
    urlDaFoto = "https://169.254.169.254/latest/meta-data/iam/security-credentials/";
    respostas[urlDaFoto] = () => new Response('{"AccessKeyId":"x"}', { status: 200 });

    const { corpo } = await rodar();

    expect(fetchCalls).toEqual([]);
    nadaGravado();
    expect(corpo.data.updated).toBe(0);
    expect(corpo.data.failed).toBe(1);
  });

  it("serviço da rede do compose por IP privado não sai e não grava", async () => {
    urlDaFoto = "https://10.0.0.7:8000/interno";
    respostas[urlDaFoto] = () => imagem(JPEG);

    await rodar();

    expect(fetchCalls).toEqual([]);
    nadaGravado();
  });

  it("nome público que resolve para IP interno (rebinding) não sai e não grava", async () => {
    urlDaFoto = "https://rebinding.exemplo/foto.jpg";
    respostas[urlDaFoto] = () => imagem(JPEG);

    await rodar();

    expect(dnsPedidos).toContain("rebinding.exemplo");
    expect(fetchCalls).toEqual([]);
    nadaGravado();
  });

  it("URL pública que responde 302 para o interno: sai UMA vez, não segue o redirect e não grava", async () => {
    urlDaFoto = "https://cdn.publico.exemplo/foto.jpg";
    respostas[urlDaFoto] = () =>
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } });
    respostas["https://169.254.169.254/latest/meta-data/"] = () => imagem(JPEG);

    const { corpo } = await rodar();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(urlDaFoto);
    expect(fetchCalls[0]?.init?.redirect).toBe("manual");
    nadaGravado();
    expect(corpo.data.failed).toBe(1);
  });
});

describe("cron de fotos: o que vem só vale se for imagem", () => {
  it("destino público que devolve JSON (não imagem) não grava", async () => {
    urlDaFoto = "https://cdn.publico.exemplo/foto.jpg";
    respostas[urlDaFoto] = () =>
      new Response('{"AccessKeyId":"AKIA...","SecretAccessKey":"..."}', {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });

    await rodar();

    // Mesmo declarando `image/jpeg`: o cabeçalho é de quem controla o servidor.
    expect(fetchCalls).toHaveLength(1);
    nadaGravado();
  });

  it("HTML e SVG (que carrega script) não são imagem aceita", async () => {
    urlDaFoto = "https://cdn.publico.exemplo/foto.jpg";
    for (const texto of ["<html><body>oi</body></html>", '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>']) {
      respostas[urlDaFoto] = () => new Response(texto, { status: 200 });
      await rodar();
    }
    nadaGravado();
  });

  it("imagem acima do teto de 2 MB não grava", async () => {
    urlDaFoto = "https://cdn.publico.exemplo/foto.jpg";
    respostas[urlDaFoto] = () => imagem(JPEG, 2 * 1024 * 1024);

    const { corpo } = await rodar();

    nadaGravado();
    expect(corpo.data.failed).toBe(1);
  });

  it("corpo sem fim é interrompido no teto, sem esperar o fim do fluxo", async () => {
    urlDaFoto = "https://cdn.publico.exemplo/foto.jpg";
    let pedacosEnviados = 0;
    let cancelado = false;
    respostas[urlDaFoto] = () =>
      new Response(
        new ReadableStream({
          pull(controle) {
            pedacosEnviados++;
            controle.enqueue(new Uint8Array(512 * 1024).fill(0xff));
          },
          cancel() {
            cancelado = true;
          },
        }),
        { status: 200 },
      );

    await rodar();

    nadaGravado();
    expect(cancelado).toBe(true);
    // 2 MB de teto em pedaços de 512 KB: para logo depois do quinto, nunca lê para sempre.
    expect(pedacosEnviados).toBeLessThan(10);
  });

  it("corpo vazio não grava", async () => {
    urlDaFoto = "https://cdn.publico.exemplo/foto.jpg";
    respostas[urlDaFoto] = () => new Response(new Uint8Array(0), { status: 200 });

    await rodar();

    nadaGravado();
  });
});

describe("cron de fotos: controle positivo", () => {
  it.each([
    ["JPEG", JPEG, "image/jpeg"],
    ["PNG", PNG, "image/png"],
    ["GIF", GIF, "image/gif"],
    ["WebP", WEBP, "image/webp"],
  ])("destino público e %s de verdade: grava no caminho estável, com o tipo real", async (_nome, bytes, tipo) => {
    urlDaFoto = "https://cdn.publico.exemplo/foto.bin";
    respostas[urlDaFoto] = () => imagem(bytes);

    const { corpo } = await rodar();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.redirect).toBe("manual");
    expect(uploads).toEqual([{ caminho: CAMINHO, contentType: tipo, bytes: bytes.length }]);
    expect(carimbos.some((c) => c.avatar_storage_path === CAMINHO)).toBe(true);
    expect(corpo.data.updated).toBe(1);
  });
});

describe("assinatura de imagem", () => {
  it("reconhece as quatro e recusa o resto", () => {
    expect(tipoDeImagemPelaAssinatura(new Uint8Array(JPEG))).toBe("image/jpeg");
    expect(tipoDeImagemPelaAssinatura(new Uint8Array(PNG))).toBe("image/png");
    expect(tipoDeImagemPelaAssinatura(new Uint8Array(GIF))).toBe("image/gif");
    expect(tipoDeImagemPelaAssinatura(new Uint8Array(WEBP))).toBe("image/webp");
    // RIFF que não é WebP (um WAV), arquivo curto, vazio e texto.
    expect(tipoDeImagemPelaAssinatura(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(tipoDeImagemPelaAssinatura(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(tipoDeImagemPelaAssinatura(new Uint8Array(0))).toBeNull();
    expect(tipoDeImagemPelaAssinatura(new TextEncoder().encode("{}"))).toBeNull();
  });
});
