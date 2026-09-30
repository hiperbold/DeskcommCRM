import { describe, it, expect, vi } from "vitest";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";

describe("assertSafeOutboundUrl", () => {
  it("https público passa", () => expect(() => assertSafeOutboundUrl("https://hooks.zapier.com/x")).not.toThrow());
  it("http passa apenas fora de produção", () => {
    // NODE_ENV=test aqui — http permitido (self-host dev); produção nega.
    expect(() => assertSafeOutboundUrl("http://example.com/hook")).not.toThrow();
  });
  it("com httpsSempre, http nega mesmo sem NODE_ENV=production (imagem do worker não o define)", () => {
    // NODE_ENV=test aqui, e o worker real nem isso: o que recusa é a opção.
    expect(process.env.NODE_ENV).not.toBe("production");
    expect(() => assertSafeOutboundUrl("http://example.com/hook", { httpsSempre: true })).toThrow(
      "unsafe_url:https_required",
    );
    expect(() => assertSafeOutboundUrl("https://example.com/hook", { httpsSempre: true })).not.toThrow();
    // A opção só aperta: as demais recusas seguem valendo.
    expect(() => assertSafeOutboundUrl("https://10.0.0.5/x", { httpsSempre: true })).toThrow(
      "unsafe_url:private_host",
    );
  });
  it("em produção, http nega com ou sem a opção", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => assertSafeOutboundUrl("http://example.com/hook")).toThrow("unsafe_url:https_required");
      expect(() => assertSafeOutboundUrl("http://example.com/hook", { httpsSempre: false })).toThrow(
        "unsafe_url:https_required",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("loopback nega", () => expect(() => assertSafeOutboundUrl("https://127.0.0.1/x")).toThrow(/unsafe_url/));
  it("localhost nega", () => expect(() => assertSafeOutboundUrl("https://localhost/x")).toThrow(/unsafe_url/));
  it("IP privado nega", () => {
    expect(() => assertSafeOutboundUrl("https://10.0.0.5/x")).toThrow(/unsafe_url/);
    expect(() => assertSafeOutboundUrl("https://192.168.1.1/x")).toThrow(/unsafe_url/);
    expect(() => assertSafeOutboundUrl("https://172.16.0.1/x")).toThrow(/unsafe_url/);
    expect(() => assertSafeOutboundUrl("https://169.254.1.1/x")).toThrow(/unsafe_url/);
  });
  it("esquema não-http nega", () => expect(() => assertSafeOutboundUrl("file:///etc/passwd")).toThrow(/unsafe_url/));
  it("url inválida nega", () => expect(() => assertSafeOutboundUrl("not a url")).toThrow(/unsafe_url/));

  it("literal IPv6 nega — inclusive formas que escondem IP privado", () => {
    expect(() => assertSafeOutboundUrl("https://[::1]/x")).toThrow(/unsafe_url:ipv6_literal/);
    expect(() => assertSafeOutboundUrl("https://[::ffff:127.0.0.1]/x")).toThrow(/unsafe_url:ipv6_literal/);
    expect(() => assertSafeOutboundUrl("https://[::ffff:169.254.169.254]/x")).toThrow(/unsafe_url:ipv6_literal/);
    expect(() => assertSafeOutboundUrl("https://[fc00::1]/x")).toThrow(/unsafe_url:ipv6_literal/);
    expect(() => assertSafeOutboundUrl("https://[fe80::1]/x")).toThrow(/unsafe_url:ipv6_literal/);
  });
});
