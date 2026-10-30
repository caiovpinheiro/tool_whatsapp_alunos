/**
 * Sliding-window rate limiter.
 *
 * Garante que no máximo `maxPerWindow` operações aconteçam dentro de qualquer
 * janela de `windowMs` milissegundos. Quando o teto é atingido, a próxima
 * chamada de `acquire()` espera até o slot mais antigo expirar.
 *
 * Uso típico para respeitar limite Meta WhatsApp (default Cloud API: 80
 * mensagens/s; este projeto usa cap conservador de 60/s, configurável via
 * env `WHATSAPP_MAX_SENDS_PER_SECOND`).
 *
 * Mantém estado em memória — válido para 1 processo Node. Se um dia houver
 * múltiplos workers, trocar por implementação backed por Redis/Postgres.
 *
 * @param {number} maxPerWindow - quantas operações são permitidas por janela
 * @param {number} [windowMs=1000] - duração da janela em ms
 */
export function createRateLimiter(maxPerWindow, windowMs = 1000) {
  const cap = Math.max(1, Math.floor(maxPerWindow));
  /** @type {number[]} timestamps (ms) das últimas operações */
  const recent = [];
  /** Pausa global (429 Retry-After). Não empilha: várias respostas estendem até o maior prazo. */
  let blockedUntil = 0;

  function pause(ms) {
    const wait = Math.max(0, Number(ms) || 0);
    const until = Date.now() + wait;
    if (until > blockedUntil) blockedUntil = until;
  }

  async function acquire() {
    while (true) {
      const now = Date.now();
      if (now < blockedUntil) {
        await new Promise((r) => setTimeout(r, blockedUntil - now));
        continue;
      }
      while (recent.length > 0 && now - recent[0] >= windowMs) {
        recent.shift();
      }
      if (recent.length < cap) {
        recent.push(Date.now());
        return;
      }
      const waitMs = windowMs - (now - recent[0]) + 1;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  return {
    acquire,
    pause,
    /** @returns {{ in_window: number, cap: number, window_ms: number }} */
    stats() {
      const now = Date.now();
      const inWindow = recent.filter((t) => now - t < windowMs).length;
      return { in_window: inWindow, cap, window_ms: windowMs };
    },
  };
}
