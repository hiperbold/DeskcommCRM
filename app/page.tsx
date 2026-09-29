import { redirect } from "next/navigation";

// A raiz agora é servida pela página de vendas do HiperCRM (site estático em
// public/site), por um rewrite em next.config.ts que ganha desta rota. Este
// componente só roda se alguém acessar "/" sem passar pelo rewrite (não deve
// acontecer em produção). Mantido como fallback: manda pro painel, e o
// middleware redireciona visitante não autenticado para /login?next=/app.
export default function HomePage() {
  redirect("/app");
}
