import { describe, expect, it } from "vitest";

/**
 * D-044: `resolveSessionRef` não tinha ramo para o provider `wacalls`. O union
 * `ChannelSessionRef` não incluía `wacalls`, então o switch "cobria" o tipo em
 * tempo de compilação sem ramo nenhum para ele, mas uma linha real de
 * `channel_sessions` com `provider = 'wacalls'` (que o CHECK do banco aceita
 * desde a migration 0233) caindo ali em tempo de execução saía com
 * `session_ref` `undefined`, em silêncio, porque a função devolve `string` e
 * nenhum `case` do switch casava.
 *
 * A coluna certa é `wacalls_session_id`: é ela que `lib/wacalls/session.ts`,
 * `lib/wacalls/calls.ts` e `lib/wacalls/events-bridge.ts` usam para casar
 * evento com sessão, e o CHECK `channel_sessions_provider_ref_check` já exige
 * que ela não seja nula quando o provider é `wacalls` (mesmo padrão de
 * `uazapi_instance_id`, `zernio_account_id` etc.).
 */
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef, type ChannelSessionRef } from "@/lib/channels/session-ref";

describe("resolveSessionRef, provider wacalls (D-044)", () => {
  it("devolve wacalls_session_id para uma sessão wacalls", () => {
    const sessao: ChannelSessionRef = { provider: "wacalls", wacalls_session_id: "wacalls-abc-123" };
    expect(resolveSessionRef(sessao)).toBe("wacalls-abc-123");
  });

  it("CHANNEL_SESSION_REF_COLUMNS traz wacalls_session_id: sem a coluna no select, o ramo acima recebe undefined mesmo com o código certo", () => {
    expect(CHANNEL_SESSION_REF_COLUMNS.split(", ")).toContain("wacalls_session_id");
  });

  it("continua exaustivo para os outros quatro providers conhecidos", () => {
    expect(resolveSessionRef({ provider: "waha", waha_session_name: "s1" })).toBe("s1");
    expect(resolveSessionRef({ provider: "meta_cloud", meta_phone_number_id: "p1" })).toBe("p1");
    expect(resolveSessionRef({ provider: "zernio", zernio_account_id: "z1" })).toBe("z1");
    expect(resolveSessionRef({ provider: "zernio_social", zernio_account_id: "z2" })).toBe("z2");
    expect(resolveSessionRef({ provider: "uazapi", uazapi_instance_id: "u1" })).toBe("u1");
  });
});
