import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Medida, Modo, Muestra, Ttl, Ventana } from '../types'
import { aciertos, aconsejar, decidirTtl, observarTtl, reloj, restanteMs, tokens, tokensPrompt } from './cache'
import type { Consejo } from './cache'

const medida = atom({ plugin: 'medidor', key: 'medida' } as const, null)
const modelo = atom({ plugin: 'medidor', key: 'modelo' } as const, '')
const esfuerzo = atom({ plugin: 'medidor', key: 'esfuerzo' } as const, null)
const ahora = atom({ plugin: 'medidor', key: 'ahora' } as const, 0)
const modo = atom({ plugin: 'medidor', key: 'modo' } as const, 'completo')
const avisado = atom({ plugin: 'medidor', key: 'avisado' } as const, 0)
const muestras = atom({ plugin: 'medidor', key: 'muestras' } as const, [])
const ttlActual = atom({ plugin: 'medidor', key: 'ttl' } as const, '5m')
const ttlFuente = atom({ plugin: 'medidor', key: 'ttlFuente' } as const, 'por defecto')

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const MODOS: Modo[] = ['completo', 'compacto', 'oculto']
const AVISO_CACHE_MS = 60_000 // amarillo y aviso cuando falta esto para que venza
const COMPACTAR_DESDE = 100_000 // con más tokens, una caché vencida sugiere /compact
const AVISAR_DESDE = 20_000 // prompts menores no merecen aviso de vencimiento

// «claude-opus-5-5[1m]» → «Opus 5.5 · 1M»
function nombreModelo(id: string): string {
  if (!id) return '…'
  const largo = /\[1m\]/i.test(id) ? ' · 1M' : ''
  const limpio = id.replace(/\[.*?\]/g, '').replace(/^claude-/, '')
  const m = limpio.match(/^([a-z]+)-(\d+)(?:-(\d+))?/i)
  if (!m || !m[1] || !m[2]) return limpio + largo
  const familia = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return `${familia} ${m[2]}${m[3] && m[3].length <= 2 ? '.' + m[3] : ''}${largo}`
}

function color(pct: number | undefined): string {
  if (pct === undefined) return 'gray'
  if (pct >= 90) return 'red'
  if (pct >= 70) return 'yellow'
  return 'green'
}

function barra(pct: number | undefined, celdas: number): [string, string] {
  const llenas = Math.max(0, Math.min(celdas, Math.round(((pct ?? 0) / 100) * celdas)))
  return ['▰'.repeat(llenas), '▱'.repeat(celdas - llenas)]
}

function duracion(ms: number): string {
  if (ms <= 0) return 'ya'
  const min = Math.floor(ms / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}

function hora(fecha: Date): string {
  return `${String(fecha.getHours()).padStart(2, '0')}:${String(fecha.getMinutes()).padStart(2, '0')}`
}

function reinicio(v: Ventana | undefined, t: number, conDia: boolean): string {
  if (!v?.resetsAt) return ''
  const f = new Date(v.resetsAt)
  const cuando = conDia ? `${DIAS[f.getDay()]} ${hora(f)}` : hora(f)
  return `${duracion(f.getTime() - t)} (${cuando})`
}

const COLOR_CONSEJO: Record<Consejo['tipo'], string> = {
  fria: 'gray',
  'sin-cache': 'gray',
  caliente: 'green',
  pronto: 'yellow',
  vencida: 'red',
  fallo: 'red',
}
const ICONO_CONSEJO: Record<Consejo['tipo'], string> = {
  fria: '○',
  'sin-cache': '○',
  caliente: '●',
  pronto: '▲',
  vencida: '✖',
  fallo: '✖',
}

async function medir($: EngineInterface) {
  const u = await $.session.usage()
  const m: Medida = {
    startedAt: u.startedAt,
    tokens: u.context.tokens,
    window: u.context.window,
    percent: u.context.percent,
    limites: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    usd: u.cost?.usd,
  }
  await update($, medida, () => m)
  await update($, ahora, () => Date.now())
  return m
}

export const register: Register = on => {
  // Variables del módulo: se reinician en cada recarga, a propósito.
  let env: { force5m?: string; ttlVar?: string; enable1h?: string } = {}
  let observado: Ttl | undefined
  let marcaReloj = ''
  let avisadaCache = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'medidor',
      description: 'Banda de uso: /medidor [completo|compacto|oculto] (sin argumento, alterna)',
    })
    const nada = () => undefined
    env = {
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(nada),
      ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(nada),
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(nada),
    }
    const id = await $.session.model()
    await update($, modelo, () => id)
    const m = await medir($)
    const base = decidirTtl(env, m.limites)
    await update($, ttlActual, () => base.ttl)
    await update($, ttlFuente, () => base.fuente)

    // Cada segundo: redibuja solo si cambió lo que se ve (minuto de los
    // reinicios o segundo de la cuenta regresiva de la caché), y avisa a 60 s.
    $.clock.every(1000, async () => {
      const t = Date.now()
      const lista = await read($, muestras)
      const ultima = lista[lista.length - 1]
      const ttl = await read($, ttlActual)
      const resta = ultima ? restanteMs(ultima, ttl, t) : 0
      const marca = `${Math.floor(t / 60_000)}|${Math.ceil(resta / 1000)}`
      if (marca !== marcaReloj) {
        marcaReloj = marca
        await update($, ahora, () => t)
      }
      if (ultima && tokensPrompt(ultima) >= AVISAR_DESDE && resta > 0 && resta <= AVISO_CACHE_MS && avisadaCache !== ultima.inicio) {
        avisadaCache = ultima.inicio
        $.ui.toast(`La caché vence en ${reloj(resta)}: cualquier mensaje la renueva; si no, se reescriben ${tokens(tokensPrompt(ultima))}`)
      }
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const m = await medir($)
    const cinco = m.limites.find(l => l.kind === 'five_hour')
    if (cinco) {
      const ya = await read($, avisado)
      const umbral = cinco.percentUsed >= 95 ? 95 : cinco.percentUsed >= 80 ? 80 : 0
      if (umbral > ya) $.ui.toast(`Límite de 5 h al ${cinco.percentUsed}%: se reinicia en ${reinicio(cinco, Date.now(), false)}`)
      if (umbral !== ya) await update($, avisado, () => umbral)
    }
    return next(e)
  })

  // Cada petición del hilo principal (los subagentes tienen su propio prefijo):
  // modelo, esfuerzo y qué hizo la caché con ella.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const inicio = Date.now()
    await update($, modelo, () => e.model)
    await update($, esfuerzo, () => (e.effort === undefined ? null : String(e.effort)))
    const r = yield* next(e)
    if (r.usage) {
      const nueva: Muestra = {
        modelo: r.usage.model || e.model,
        inicio,
        leido: r.usage.cache_read_input_tokens,
        escrito: r.usage.cache_creation_input_tokens,
        nuevo: r.usage.input_tokens,
      }
      const lista = [...(await read($, muestras)), nueva].slice(-2)
      await update($, muestras, () => lista)
      // La cuenta puede cambiar en plena sesión (suscripción agotada → créditos).
      const base = decidirTtl(env, ((await read($, medida))?.limites) ?? [])
      observado = observarTtl(lista[0] === nueva ? undefined : lista[0], nueva, observado)
      await update($, ttlActual, () => observado ?? base.ttl)
      await update($, ttlFuente, () => (observado ? 'observado en el tráfico' : base.fuente))
    }
    return r
  })

  on('command.run', { command: 'medidor' }, async ($, e) => {
    const pedido = e.args.trim().toLowerCase() as Modo
    const actual = await read($, modo)
    const nuevo = MODOS.includes(pedido) ? pedido : MODOS[(MODOS.indexOf(actual) + 1) % MODOS.length]
    await update($, modo, () => nuevo)
    await medir($)
    const ttl = await read($, ttlActual)
    const fuente = await read($, ttlFuente)
    return { text: `Medidor en modo ${nuevo}. Caché de ${ttl === '1h' ? '1 h' : '5 min'} (${fuente}).` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, medida)
    const vista = await read($, modo)
    // Solo en la terminal: en la app de escritorio lo muestra el panel de agent-bots (si lo tienes instalado).
    if (e.surface !== 'terminal') return next(e)
    if (e.props.hasSurvey || vista === 'oculto' || m === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const t = (await read($, ahora)) || Date.now()
    const id = await read($, modelo)
    const esf = await read($, esfuerzo)
    const ancho = e.viewport?.columns ?? 120
    const compacto = vista === 'compacto' || ancho < 100
    const celdas = compacto ? 5 : 8
    const sep = <Text dimColor> │ </Text>

    const ctx = m.percent
    const [cl, cv] = barra(ctx, celdas)
    const cinco = m.limites.find(l => l.kind === 'five_hour')
    const semana = m.limites.find(l => l.kind === 'seven_day')
    const otros = m.limites.filter(l => l.kind !== 'five_hour' && l.kind !== 'seven_day')

    // Caché de prompts
    const lista = await read($, muestras)
    const ultima = lista[lista.length - 1]
    const previa = lista.length > 1 ? lista[0] : undefined
    const ttl = await read($, ttlActual)
    const consejo = aconsejar(ultima, previa, ttl, t, AVISO_CACHE_MS, COMPACTAR_DESDE)
    const resta = ultima ? restanteMs(ultima, ttl, t) : 0
    const pctCache = ultima ? Math.round(aciertos(ultima) * 100) : undefined
    const colorReloj = resta <= AVISO_CACHE_MS ? 'red' : resta / (ttl === '1h' ? 3_600_000 : 300_000) <= 0.4 ? 'yellow' : 'green'
    const [kl, kv] = barra(pctCache, celdas)

    const limite = (etq: string, v: Ventana | undefined, conDia: boolean) => {
      if (!v) return <Text dimColor>{etq} —</Text>
      const [ll, lv] = barra(v.percentUsed, celdas)
      return (
        <Text>
          <Text bold>{etq} </Text>
          <Text color={color(v.percentUsed)}>{ll}</Text>
          <Text dimColor>{lv}</Text>
          <Text color={color(v.percentUsed)}> {v.percentUsed}%</Text>
          {v.resetsAt && <Text dimColor> ↻ {reinicio(v, t, conDia)}</Text>}
        </Text>
      )
    }

    const cache = ultima ? (
      <Text>
        <Text bold>caché </Text>
        <Text color={COLOR_CONSEJO[consejo.tipo]}>{kl}</Text>
        <Text dimColor>{kv}</Text>
        <Text color={COLOR_CONSEJO[consejo.tipo]}> {pctCache}%</Text>
        {!compacto && (
          <Text dimColor>
            {' '}leído {tokens(ultima.leido)} · escrito {tokens(ultima.escrito)} · nuevo {tokens(ultima.nuevo)}
          </Text>
        )}
        <Text color={colorReloj}> ⏱ {reloj(resta)}</Text>
        <Text dimColor> {ttl === '1h' ? '1h' : '5m'}</Text>
        <Text color={COLOR_CONSEJO[consejo.tipo]}> {ICONO_CONSEJO[consejo.tipo]} </Text>
        <Text color={consejo.tipo === 'caliente' ? undefined : COLOR_CONSEJO[consejo.tipo]} dimColor={consejo.tipo === 'caliente'}>
          {compacto ? consejo.texto.split(':')[0] : consejo.texto}
        </Text>
      </Text>
    ) : (
      <Text dimColor>caché ○ {consejo.texto}</Text>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Text>
            <Text color="magenta" bold>◆ {nombreModelo(id)}</Text>
            <Text dimColor> · </Text>
            <Text color="cyan">{esf ?? 'esfuerzo —'}</Text>
          </Text>
          {sep}
          <Text>
            <Text bold>ctx </Text>
            <Text color={color(ctx)}>{cl}</Text>
            <Text dimColor>{cv}</Text>
            <Text color={color(ctx)}> {ctx === undefined ? '—' : `${ctx}%`}</Text>
            {!compacto && m.tokens !== undefined && (
              <Text dimColor> {tokens(m.tokens)}/{tokens(m.window)}</Text>
            )}
          </Text>
          {sep}
          {limite('5h', cinco, false)}
          {sep}
          {limite('7d', semana, true)}
          {otros.map(o => (
            <Text key={o.kind}>
              <Text dimColor> │ </Text>
              {limite(o.kind, o, true)}
            </Text>
          ))}
          {!compacto && (
            <Text>
              <Text dimColor> │ </Text>
              {m.usd !== undefined && <Text color="green">${m.usd.toFixed(2)}</Text>}
              <Text dimColor> · {duracion(t - m.startedAt)}</Text>
            </Text>
          )}
        </Box>
        {cache}
      </Box>
    )
  })
}
