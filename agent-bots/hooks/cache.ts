// Lógica pura de la caché de prompts (sin `$`). Ideas tomadas de
// davila7/claude-code-templates · observability/prompt-cache-control (MIT,
// commit 8da17d67), reescritas y simplificadas para el medidor:
//   - la caché vive 5 min por defecto y 1 h si se pide; cada lectura la renueva
//     gratis y la vida se cuenta desde el INICIO de la petición
//   - prompt = input_tokens (sin caché) + cache_read + cache_creation
//   - escribir cuesta 1,25× (5 min) o 2× (1 h) la entrada; leer ≈ 0,1×: lo caro es
//     que venza con un contexto grande
//   - un cambio del prefijo (modelo, esfuerzo, herramientas, system prompt,
//     CLAUDE.md) hace que la siguiente petición escriba en vez de leer
import type { Muestra, Ttl } from '../types'

export type Consejo = {
  tipo: 'fria' | 'sin-cache' | 'caliente' | 'pronto' | 'vencida' | 'fallo'
  texto: string
}

const HOLGURA_MS = 10_000

export const ttlMs = (ttl: Ttl) => (ttl === '1h' ? 3_600_000 : 300_000)
export const tokensPrompt = (m: Muestra) => m.leido + m.escrito + m.nuevo
export const aciertos = (m: Muestra) => (tokensPrompt(m) === 0 ? 0 : m.leido / tokensPrompt(m))

export function restanteMs(m: Muestra, ttl: Ttl, ahora: number): number {
  if (m.leido + m.escrito === 0) return 0
  return Math.max(0, m.inicio + ttlMs(ttl) - ahora)
}

/** Duración que pide Claude Code según el entorno y la cuenta (orden de su documentación). */
export function decidirTtl(
  env: { force5m?: string; ttlVar?: string; enable1h?: string },
  limites: { kind: string; percentUsed: number }[],
): { ttl: Ttl; fuente: string } {
  const si = (v?: string) => v === '1' || v?.toLowerCase() === 'true'
  if (si(env.force5m)) return { ttl: '5m', fuente: 'FORCE_PROMPT_CACHING_5M' }
  if (env.ttlVar === '5m' || env.ttlVar === '1h') return { ttl: env.ttlVar, fuente: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  if (si(env.enable1h)) return { ttl: '1h', fuente: 'ENABLE_PROMPT_CACHING_1H' }
  const plan = limites.filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
  if (plan.length === 0) return { ttl: '5m', fuente: 'sin suscripción visible' }
  if (plan.some(l => l.percentUsed >= 100)) return { ttl: '5m', fuente: 'créditos de uso' }
  return { ttl: '1h', fuente: 'suscripción' }
}

/**
 * Lo que el tráfico dice de la duración: un acierto más de 5 min después de la
 * petición anterior prueba 1 h; un fallo entre 5 y 60 min con el mismo modelo y
 * un prompt que no encogió apunta a 5 min (más débil: un prefijo cambiado se ve igual).
 */
export function observarTtl(prev: Muestra | undefined, cur: Muestra, conocido: Ttl | undefined): Ttl | undefined {
  if (!prev || prev.leido + prev.escrito === 0 || cur.modelo !== prev.modelo) return conocido
  const hueco = cur.inicio - prev.inicio
  const antes = tokensPrompt(prev)
  if (hueco <= ttlMs('5m') + HOLGURA_MS) return conocido
  if (cur.leido >= antes * 0.5) return '1h'
  if (conocido === '1h') return conocido
  const vencio = cur.escrito > 0 && tokensPrompt(cur) >= antes * 0.7 && hueco < ttlMs('1h') + HOLGURA_MS
  return vencio ? '5m' : conocido
}

/** Por qué una petición que debía leer la caché la escribió; undefined si no falló. */
export function causaFallo(prev: Muestra | undefined, cur: Muestra, ttl: Ttl): string | undefined {
  if (!prev) return undefined
  const antes = tokensPrompt(prev)
  // Un prompt que encogió es /compact o /clear, no un fallo.
  if (antes === 0 || tokensPrompt(cur) < antes * 0.7) return undefined
  if (cur.leido >= antes * 0.5 || cur.escrito === 0) return undefined
  if (cur.modelo !== prev.modelo) return 'cambió el modelo'
  if (cur.inicio - prev.inicio > ttlMs(ttl)) return `había vencido (${ttl === '1h' ? '1 h' : '5 min'})`
  return 'cambió el prefijo (esfuerzo, herramientas, system prompt o CLAUDE.md)'
}

export function aconsejar(
  ultima: Muestra | undefined,
  previa: Muestra | undefined,
  ttl: Ttl,
  ahora: number,
  avisoMs: number,
  compactarDesde: number,
): Consejo {
  if (!ultima) return { tipo: 'fria', texto: 'sin peticiones aún: la primera escribe la caché' }
  if (ultima.leido + ultima.escrito === 0) return { tipo: 'sin-cache', texto: 'esta petición no usó caché' }
  const resta = restanteMs(ultima, ttl, ahora)
  const tam = tokensPrompt(ultima)
  if (resta <= 0) {
    return tam >= compactarDesde
      ? { tipo: 'vencida', texto: `vencida: el próximo mensaje reescribe ${tokens(tam)}; /compact antes, o /clear si terminaste` }
      : { tipo: 'vencida', texto: `vencida: solo ${tokens(tam)} por reconstruir, sigue` }
  }
  if (resta <= avisoMs) return { tipo: 'pronto', texto: 'vence pronto: cualquier mensaje la renueva gratis' }
  const fallo = causaFallo(previa, ultima, ttl)
  if (fallo) return { tipo: 'fallo', texto: `falló: ${fallo}` }
  return { tipo: 'caliente', texto: 'caliente: sigue' }
}

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** m:ss, o h:mm:ss desde una hora. */
export function reloj(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const dos = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${dos(m)}:${dos(s)}` : `${m}:${dos(s)}`
}
