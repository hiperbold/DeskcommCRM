import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TETO_DE_BYTES, criarFetchSeguro } from "@/lib/ai/mcp-externo/fetch-seguro";
import {
  CORTE_DA_RESPOSTA,
  abrirSessao,
  cabecalhoPermitido,
  chamarFerramenta,
  listarFerramentas,
  motivoLegivel,
  valorDeCabecalhoValido,
  type Sessao,
} from "@/lib/ai/mcp-externo/cliente";
import { servidorDeTeste } from "./_helpers/servidor-mcp-de-teste";

describe("cliente MCP externo", () => {
  it("lista as ferramentas com o que a tela e o turno precisam", async () => {
    const sessao = await servidorDeTeste();
    const lista = await listarFerramentas(sessao, "imoveis");
    const busca = lista.find((f) => f.nome === "buscar_imoveis");
    expect(busca).toMatchObject({
      id: "mcp_imoveis__buscar_imoveis",
      somente_leitura: true,
      recusada: null,
    });
    expect(lista.find((f) => f.nome === "cadastrar_visita")?.somente_leitura).toBe(false);
    await sessao.fechar();
  });

  it("chama e devolve o texto envelopado como dado externo", async () => {
    const sessao = await servidorDeTeste();
    const r = await chamarFerramenta(sessao, "buscar_imoveis", { bairro: "Centro" });
    expect(r).toMatchObject({ ok: true, dados: "3 imóveis em Centro" });
    expect(r.aviso).toMatch(/sistema externo/);
    await sessao.fechar();
  });

  it("corta resposta enorme", async () => {
    const sessao = await servidorDeTeste();
    const r = await chamarFerramenta(sessao, "enorme", {});
    expect(r.dados.length).toBeLessThanOrEqual(CORTE_DA_RESPOSTA + 40);
    expect(r.cortada).toBe(true);
    await sessao.fechar();
  });

  it("não prende o turno: servidor lento vira erro, não espera infinita", async () => {
    const sessao = await servidorDeTeste();
    const r = await chamarFerramenta(sessao, "demorada", {}, { prazoMs: 200 });
    expect(r).toMatchObject({ ok: false });
    expect(r.dados).toMatch(/não respondeu a tempo/);
    await sessao.fechar();
  }, 5_000);

  it("recusa de segurança chega a quem chamou e NÃO tenta de novo por SSE", async () => {
    // Prova que o SDK não esconde o erro do fetch seguro: se escondesse, o
    // recuo para SSE tentaria o mesmo endereço proibido por outro caminho.
    let chamadas = 0;
    const fetchQueRecusa = (async () => {
      chamadas++;
      throw new Error("unsafe_url:private_ip");
    }) as unknown as Parameters<typeof abrirSessao>[0] extends { fetch?: infer F } ? F : never;
    await expect(
      abrirSessao({ destino: { url: "https://interno.exemplo.com/mcp" }, fetch: fetchQueRecusa }),
    ).rejects.toThrow(/unsafe_url/);
    expect(chamadas).toBe(1);
  });

  it("resposta grande demais NÃO tenta de novo por SSE", async () => {
    // Mesmo raciocínio do teste de segurança acima: se o recuo tentasse de
    // novo, um servidor que devolve payload gigante na resposta de
    // `initialize` faria o cliente bater na mesma parede duas vezes (e
    // esperar o dobro do orçamento de conexão à toa).
    const buscarQueDevolveGrande = vi.fn<typeof fetch>(async () => {
      const r = new Response("{}", { status: 200 });
      r.headers.set("content-length", String(TETO_DE_BYTES + 1));
      return r;
    });
    const fetchSeguro = criarFetchSeguro({ validarHost: vi.fn(async () => {}), fetch: buscarQueDevolveGrande });
    await expect(
      abrirSessao({ destino: { url: "https://exemplo.com/mcp" }, fetch: fetchSeguro }),
    ).rejects.toThrow(/mcp_resposta_grande_demais/);
    expect(buscarQueDevolveGrande).toHaveBeenCalledTimes(1);
  });

  it("fecha o cliente Streamable E o SSE quando a conexão falha, para o EventSource não ficar reconectando sozinho com a credencial", async () => {
    // O SDK só fecha sozinho quando a falha é na requisição de `initialize`
    // (o `Client.connect()` do SDK já tem um `catch` que chama `close()` ali).
    // Quando quem falha é o `start()` do PRÓPRIO transporte (o caso do SSE:
    // o `EventSource` abre dentro de `start()`), o SDK NÃO fecha sozinho, e é
    // exatamente esse buraco que o `fecharSemErro` de `abrirSessao` tampa.
    // Por isso a prova certa não é contar chamadas (o SDK já chama `close()`
    // uma vez por conta própria no caminho do Streamable, o que tornaria a
    // contagem exata frágil e acoplada a um detalhe interno do SDK): é
    // registrar QUAIS instâncias de `Client` foram fechadas ao menos uma vez,
    // e provar que as DUAS (Streamable e SSE) entraram nesse conjunto.
    const closeOriginal = Client.prototype.close;
    const instanciasFechadas = new Set<Client>();
    Client.prototype.close = async function fechar(this: Client) {
      instanciasFechadas.add(this);
      return closeOriginal.call(this);
    };
    try {
      const fetchQueFalha = vi.fn<typeof fetch>(async () => {
        throw new Error("network_falhou");
      });
      await expect(
        abrirSessao({ destino: { url: "https://exemplo.com/mcp" }, fetch: fetchQueFalha }),
      ).rejects.toThrow();
      expect(instanciasFechadas.size).toBe(2);
    } finally {
      Client.prototype.close = closeOriginal;
    }
  });

  it("fecha o cliente Streamable quando a conexão TRAVA (POST nunca responde), caso que só o fechamento explícito cobre", async () => {
    // Diferente do teste acima (onde o fetch REJEITA e o próprio SDK fecha o
    // client Streamable sozinho, no catch interno do `Client.connect()`):
    // aqui o fetch nunca resolve NEM rejeita. A promessa de `connect()` fica
    // pendurada pra sempre; o SDK não tem chance de fechar nada sozinho. Só
    // quem fecha é o `fecharSemErro` chamado depois do timeout do orçamento
    // de conexão (aqui encurtado só pra este teste, via `prazoMs`).
    const closeOriginal = Client.prototype.close;
    const instanciasFechadas = new Set<Client>();
    Client.prototype.close = async function fechar(this: Client) {
      instanciasFechadas.add(this);
      return closeOriginal.call(this);
    };
    try {
      const fetchQuePendura = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
      await expect(
        abrirSessao({ destino: { url: "https://exemplo.com/mcp", prazoMs: 50 }, fetch: fetchQuePendura }),
      ).rejects.toThrow(/mcp_conexao_sem_resposta/);
      expect(instanciasFechadas.size).toBe(1);
    } finally {
      Client.prototype.close = closeOriginal;
    }
  }, 5_000);

  it("recua para SSE pelo MESMO fetch injetado quando o Streamable recusa (404/405)", async () => {
    const chamadas: Array<{ metodo: string; accept: string | null }> = [];
    const fetchFalso = vi.fn<typeof fetch>(async (_input, init) => {
      const metodo = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      chamadas.push({ metodo, accept: headers.get("accept") });
      if (metodo === "POST") {
        // Servidor que não fala Streamable HTTP: recusa a chamada inicial.
        return new Response("não encontrado", { status: 404 });
      }
      // GET do EventSource por baixo do SSEClientTransport. Fechar o stream
      // na hora já basta pra provar que o fetch chegou; não é preciso
      // completar o handshake inteiro (endpoint event) pra este teste.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    await expect(
      abrirSessao({ destino: { url: "https://exemplo.com/mcp" }, fetch: fetchFalso }),
    ).rejects.toThrow();
    const chamadaPost = chamadas.find((c) => c.metodo === "POST");
    const chamadaGet = chamadas.find((c) => c.metodo === "GET");
    expect(chamadaPost).toBeDefined();
    expect(chamadaGet?.accept).toMatch(/text\/event-stream/);
  });

  it("recusa ferramenta com esquema de entrada grande demais (id fica, recusada explica)", async () => {
    const sessao = await servidorDeTeste();
    const lista = await listarFerramentas(sessao, "imoveis");
    const gigante = lista.find((f) => f.nome === "schema_gigante");
    expect(gigante?.id).toBe("mcp_imoveis__schema_gigante");
    expect(gigante?.recusada).toMatch(/esquema.*grande demais/i);
    await sessao.fechar();
  });

  it("nome repetido na lista do servidor: só a primeira ocorrência fica ativa, a segunda é recusada (nunca some em silêncio)", async () => {
    // `McpServer.registerTool` real não deixa cadastrar o mesmo nome duas
    // vezes — por isso a sessão aqui é uma dublê mínima, só para simular um
    // servidor de terceiro mal comportado que devolve `name` repetido em
    // `tools/list`.
    const sessaoComNomeRepetido = {
      client: {
        listTools: async () => ({
          tools: [
            { name: "buscar_imoveis", description: "primeira", inputSchema: { type: "object" } },
            { name: "buscar_imoveis", description: "segunda, repetida", inputSchema: { type: "object" } },
          ],
        }),
      },
      fechar: async () => {},
    } as unknown as Sessao;

    const lista = await listarFerramentas(sessaoComNomeRepetido, "imoveis");
    const ocorrencias = lista.filter((f) => f.nome === "buscar_imoveis");
    expect(ocorrencias).toHaveLength(2);
    expect(ocorrencias[0]?.recusada).toBeNull();
    expect(ocorrencias[1]?.recusada).toMatch(/mais de uma vez/i);
  });

  it("usa o dado estruturado quando a ferramenta não devolve bloco de texto", async () => {
    const sessao = await servidorDeTeste();
    const r = await chamarFerramenta(sessao, "somente_estruturado", {});
    expect(r.ok).toBe(true);
    expect(r.dados).toBe(JSON.stringify({ bairro: "Centro", total: 3 }));
    await sessao.fechar();
  });

  describe("cabecalhoPermitido", () => {
    it.each(["Authorization", "authorization", "X-API-Key", "x-api-key", "X-Minha-Chave"])(
      "permite %s",
      (nome) => {
        expect(cabecalhoPermitido(nome)).toBe(true);
      },
    );

    it.each(["Host", "Content-Type", "Accept", "Mcp-Session-Id", "Cookie", "Connection"])(
      "recusa %s",
      (nome) => {
        expect(cabecalhoPermitido(nome)).toBe(false);
      },
    );
  });

  it("abrirSessao recusa nome de cabeçalho fora da lista permitida, antes de conectar", async () => {
    await expect(
      abrirSessao({ destino: { url: "https://exemplo.com/mcp", cabecalho: { nome: "Cookie", valor: "x" } } }),
    ).rejects.toThrow(/unsafe_url:cabecalho_proibido/);
  });

  describe("valorDeCabecalhoValido", () => {
    it.each(["chave-secreta-123", "Bearer abc.def.ghi", "x"])("permite %s", (valor) => {
      expect(valorDeCabecalhoValido(valor)).toBe(true);
    });

    it.each([
      ["quebra de linha", "chave\nsecreta"],
      ["espaço no início", " chave-secreta"],
      ["vazio", ""],
      ["tab no início", "\tchave"],
    ])("recusa %s", (_descricao, valor) => {
      expect(valorDeCabecalhoValido(valor)).toBe(false);
    });
  });

  it("abrirSessao recusa valor de cabeçalho com quebra de linha, SEM ecoar o valor no erro", async () => {
    // Colar a chave com um Enter no meio (comum ao copiar de um gerenciador
    // de senha) faria o `undici` (fetch do Node) lançar um erro que ecoa o
    // próprio valor na mensagem; a checagem aqui recusa ANTES de chegar lá.
    const valorComQuebra = "chave-secreta-de-verdade\nX-Injetado: 1";
    let erroCapturado: unknown;
    try {
      await abrirSessao({
        destino: { url: "https://exemplo.com/mcp", cabecalho: { nome: "Authorization", valor: valorComQuebra } },
      });
    } catch (err) {
      erroCapturado = err;
    }
    expect(erroCapturado).toBeInstanceOf(Error);
    expect((erroCapturado as Error).message).toMatch(/unsafe_url:cabecalho_invalido/);
    expect((erroCapturado as Error).message).not.toContain(valorComQuebra);
    expect((erroCapturado as Error).message).not.toContain("chave-secreta-de-verdade");
  });

  describe("motivoLegivel", () => {
    it("traduz recusa de segurança sem citar o endereço", () => {
      expect(motivoLegivel(new Error("unsafe_url:private_ip"))).toBe(
        "Este endereço não é permitido (só https, e nunca endereço interno da rede).",
      );
    });

    it("traduz cabeçalho com valor inválido, antes do genérico de unsafe_url", () => {
      expect(motivoLegivel(new Error("unsafe_url:cabecalho_invalido"))).toBe(
        "A chave de acesso tem caracteres inválidos (quebra de linha ou espaço no início). Cole de novo.",
      );
    });

    it("traduz redirecionamento recusado", () => {
      expect(motivoLegivel(new Error("mcp_redirecionamento_recusado"))).toBe(
        "O servidor tentou redirecionar para outro endereço; recusado.",
      );
    });

    it("traduz demora/timeout", () => {
      expect(motivoLegivel(new Error("mcp_conexao_sem_resposta"))).toBe(
        "O servidor não respondeu a tempo.",
      );
      expect(motivoLegivel(new Error("Request timed out"))).toBe(
        "O servidor não respondeu a tempo.",
      );
    });

    it("traduz resposta grande demais", () => {
      expect(motivoLegivel(new Error("mcp_resposta_grande_demais"))).toBe(
        "O servidor respondeu com dados grandes demais.",
      );
    });

    it("traduz recusa de credencial (401/403), sem repetir o texto do servidor", () => {
      expect(
        motivoLegivel(new StreamableHTTPError(401, "Server returned 401 after successful authentication")),
      ).toBe("O servidor recusou a chave de acesso.");
      expect(
        motivoLegivel(new StreamableHTTPError(403, "Server returned 403 after trying upscoping")),
      ).toBe("O servidor recusou a chave de acesso.");
    });

    it("cai no genérico para qualquer outro erro, sem vazar texto do servidor", () => {
      expect(motivoLegivel(new Error("segredo do servidor que não pode aparecer pro operador"))).toBe(
        "Não foi possível conectar ao servidor MCP.",
      );
    });
  });
});
