/**
 * D-174: registrar na API oficial da Meta o número que ficou `PENDING`, e mostrar o estado do número.
 * O Graph é um dublê de `fetch` (nenhuma chamada de rede); o que se prova é o que o CRM manda e como
 * traduz o que a Meta responde.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  gerarPinDeRegistro,
  lerEstadoDoNumero,
  pinDeRegistroValido,
  registrarNumero,
} from "@/lib/channels/meta/registro-do-numero";

const fetchMock = vi.fn();

function resposta(status: number, corpo: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PIN de registro", () => {
  it("o PIN gerado tem seis dígitos, sempre (inclusive com zeros à esquerda)", () => {
    for (let i = 0; i < 200; i++) expect(gerarPinDeRegistro()).toMatch(/^\d{6}$/);
  });

  it("só seis dígitos valem como PIN informado", () => {
    expect(pinDeRegistroValido("123456")).toBe(true);
    expect(pinDeRegistroValido("000000")).toBe(true);
    for (const ruim of ["12345", "1234567", "12345a", "", " 12345", "١٢٣٤٥٦"]) {
      expect(pinDeRegistroValido(ruim), ruim).toBe(false);
    }
  });
});

describe("lerEstadoDoNumero", () => {
  it("⭐ pergunta status e code_verification_status ao Graph, com o token no cabeçalho e prazo", async () => {
    fetchMock.mockResolvedValue(
      resposta(200, {
        status: "PENDING",
        code_verification_status: "VERIFIED",
        display_phone_number: "+55 11 97177-3528",
        quality_rating: "UNKNOWN",
      }),
    );
    const r = await lerEstadoDoNumero({ phoneNumberId: "111", token: "TOKEN" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/111\?fields=.*status/);
    expect(url).toContain("code_verification_status");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(r).toMatchObject({
      ok: true,
      status: "PENDING",
      codeVerificationStatus: "VERIFIED",
      precisaRegistrar: true,
    });
  });

  it("CONNECTED não precisa registrar", async () => {
    fetchMock.mockResolvedValue(resposta(200, { status: "CONNECTED", code_verification_status: "VERIFIED" }));
    const r = await lerEstadoDoNumero({ phoneNumberId: "111", token: "TOKEN" });
    expect(r).toMatchObject({ ok: true, status: "CONNECTED", precisaRegistrar: false });
  });

  it("token vencido (190) vira frase em português, sem o texto cru da Meta", async () => {
    fetchMock.mockResolvedValue(
      resposta(401, { error: { code: 190, message: "Error validating access token: Session has expired" } }),
    );
    const r = await lerEstadoDoNumero({ phoneNumberId: "111", token: "TOKEN" });
    expect(r).toEqual({ ok: false, motivo: expect.stringMatching(/token.*(venceu|revogado)/i) });
  });

  it("rede caída não é credencial ruim", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const r = await lerEstadoDoNumero({ phoneNumberId: "111", token: "TOKEN" });
    expect(r).toEqual({ ok: false, motivo: expect.stringMatching(/rede indispon/i) });
  });
});

describe("registrarNumero", () => {
  it("⭐ POST /{id}/register com messaging_product whatsapp e o PIN, com prazo", async () => {
    fetchMock.mockResolvedValue(resposta(200, { success: true }));
    const r = await registrarNumero({ phoneNumberId: "111", token: "TOKEN", pin: "123456" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/111\/register$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ messaging_product: "whatsapp", pin: "123456" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(r).toEqual({ ok: true });
  });

  it("recusa PIN que não tem seis dígitos SEM falar com a Meta", async () => {
    const r = await registrarNumero({ phoneNumberId: "111", token: "TOKEN", pin: "12" });
    expect(r).toMatchObject({ ok: false, codigo: "pin_invalido" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const casos: Array<[string, number, number, string, RegExp]> = [
    ["PIN diferente do cadastrado", 400, 133005, "pin_incorreto", /PIN/],
    ["número ainda sem código verificado", 400, 133006, "numero_nao_verificado", /verific/i],
    ["tentativas demais", 400, 133016, "limite_de_tentativas", /tentativas|aguarde/i],
    ["token vencido", 401, 190, "token_invalido", /token/i],
    ["token sem permissão", 403, 10, "sem_permissao", /permiss/i],
  ];
  for (const [nome, http, codigoMeta, codigo, frase] of casos) {
    it(`erro 4xx traduzido: ${nome}`, async () => {
      fetchMock.mockResolvedValue(resposta(http, { error: { code: codigoMeta, message: "mensagem crua em inglês" } }));
      const r = await registrarNumero({ phoneNumberId: "111", token: "TOKEN", pin: "123456" });
      expect(r).toMatchObject({ ok: false, codigo });
      if (r.ok === false) {
        expect(r.motivo).toMatch(frase);
        expect(r.motivo).not.toContain("mensagem crua em inglês");
      }
    });
  }

  it("⭐ o PIN nunca aparece no motivo devolvido, mesmo que a Meta o repita na mensagem", async () => {
    fetchMock.mockResolvedValue(
      resposta(400, { error: { code: 100, message: "Invalid pin 654321", error_data: { details: "pin 654321 inválido" } } }),
    );
    const r = await registrarNumero({ phoneNumberId: "111", token: "TOKEN", pin: "654321" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("654321");
  });

  it("erro desconhecido ainda diz o código da Meta, para quem for ao suporte", async () => {
    fetchMock.mockResolvedValue(resposta(500, { error: { code: 2, message: "x" } }));
    const r = await registrarNumero({ phoneNumberId: "111", token: "TOKEN", pin: "123456" });
    expect(r).toMatchObject({ ok: false, codigo: "recusado_pela_meta" });
    if (r.ok === false) expect(r.motivo).toContain("2");
  });

  it("rede caída vira 'rede indisponível', sem o PIN", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed pin=123456"));
    const r = await registrarNumero({ phoneNumberId: "111", token: "TOKEN", pin: "123456" });
    expect(r).toMatchObject({ ok: false, codigo: "rede" });
    expect(JSON.stringify(r)).not.toContain("123456");
  });
});
