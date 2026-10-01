/**
 * D-099: o cron que esvazia `storage_redaction_queue` só apaga objeto que é da
 * organização da linha, num bucket da lista. A linha pode ter sido escrita por um
 * membro (a tabela já foi gravável pelo PostgREST): a logo da instalação
 * (`brand-logos/platform/...`) e o arquivo de outra empresa não podem sair.
 *
 * O Storage e a tabela são falsos; o código sob teste (`drainStorageRedactionQueue`)
 * roda de verdade. O que se mede é o que SAIU do bucket e como a linha terminou.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const removes: { bucket: string; caminhos: string[] }[] = [];
const updates: { id: string | null; patch: Record<string, unknown> }[] = [];
let fila: Record<string, unknown>[] = [];

function chain(resolver: () => Promise<unknown>, idDoUpdate?: { id: string | null }): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) => resolver().then(ok, falha);
        }
        if (prop === "eq") {
          return (coluna: string, valor: string) => {
            if (idDoUpdate && coluna === "id") idDoUpdate.id = valor;
            return proxy;
          };
        }
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => chain(async () => ({ data: fila, error: null })),
      update: (patch: Record<string, unknown>) => {
        const alvo = { id: null as string | null };
        const c = chain(async () => {
          updates.push({ id: alvo.id, patch });
          return { error: null };
        }, alvo);
        return c;
      },
    }),
    storage: {
      from: (bucket: string) => ({
        remove: async (caminhos: string[]) => {
          removes.push({ bucket, caminhos });
          return { error: null };
        },
      }),
    },
  }),
}));

import { drainStorageRedactionQueue } from "@/lib/lgpd/storage-redaction-queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";

const linha = (id: string, bucket: string, object_path: string) => ({
  id,
  organization_id: ORG,
  bucket,
  object_path,
  attempts: 0,
});

beforeEach(() => {
  removes.length = 0;
  updates.length = 0;
  fila = [];
});

describe("drainStorageRedactionQueue: escopo do apagamento (D-099)", () => {
  it("CONTROLE POSITIVO: arquivo da própria organização no bucket de mídia é apagado", async () => {
    fila = [linha("ok", "whatsapp-media", `${ORG}/conv/msg.jpg`), linha("avatar", "whatsapp-media", `${ORG}/avatars/c.jpg`)];
    const stats = await drainStorageRedactionQueue({ limit: 10 });
    expect(removes.map((r) => r.caminhos[0])).toEqual([`${ORG}/conv/msg.jpg`, `${ORG}/avatars/c.jpg`]);
    expect(stats).toMatchObject({ attempted: 2, deleted: 2, skipped: 0 });
  });

  it("a logo da instalação em outro bucket NÃO é apagada, e a linha termina como skipped", async () => {
    fila = [linha("logo", "brand-logos", "platform/abc.png")];
    const stats = await drainStorageRedactionQueue({ limit: 10 });
    expect(removes).toEqual([]);
    expect(stats).toMatchObject({ attempted: 1, deleted: 0, skipped: 1 });
    expect(updates.find((u) => u.id === "logo")?.patch).toMatchObject({
      status: "skipped",
      error_message: "fora_do_escopo_da_organizacao",
    });
  });

  it("arquivo de outra organização no mesmo bucket NÃO é apagado", async () => {
    fila = [linha("alheio", "whatsapp-media", `${OUTRA}/conv/msg.jpg`)];
    await drainStorageRedactionQueue({ limit: 10 });
    expect(removes).toEqual([]);
    expect(updates.find((u) => u.id === "alheio")?.patch).toMatchObject({ status: "skipped" });
  });

  it("caminho com ../ que sai do prefixo NÃO é apagado", async () => {
    fila = [linha("trav", "whatsapp-media", `${ORG}/../${OUTRA}/conv/msg.jpg`)];
    await drainStorageRedactionQueue({ limit: 10 });
    expect(removes).toEqual([]);
  });

  it("skill-assets da plataforma também fica de fora, e as linhas boas da mesma rodada seguem", async () => {
    fila = [
      linha("skill", "skill-assets", "platform/x.png"),
      linha("boa", "whatsapp-media", `${ORG}/conv/ok.jpg`),
    ];
    const stats = await drainStorageRedactionQueue({ limit: 10 });
    expect(removes).toEqual([{ bucket: "whatsapp-media", caminhos: [`${ORG}/conv/ok.jpg`] }]);
    expect(stats).toMatchObject({ attempted: 2, deleted: 1, skipped: 1 });
  });
});
