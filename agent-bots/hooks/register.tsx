import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { Bot, BotKind, BotMood, Change, Changes, Ctx, Limit, Muestra, Task, TaskStatus } from '../types'
import { aciertos, decidirTtl, observarTtl, restanteMs, tokens } from './cache'

const PANE = 'agent-bots'
const TITLE = 'Agentes y tareas'
const KEEP = 12

const bots = atom({ plugin: 'agent-bots', key: 'bots' } as const, [])
const tasks = atom({ plugin: 'agent-bots', key: 'tasks' } as const, [])
const limits = atom({ plugin: 'agent-bots', key: 'limits' } as const, [])
const replayed = atom({ plugin: 'agent-bots', key: 'replayed' } as const, false)
const samples = atom({ plugin: 'agent-bots', key: 'muestras' } as const, [])
const cacheTtl = atom({ plugin: 'agent-bots', key: 'ttl' } as const, '5m')
const copies = atom({ plugin: 'agent-bots', key: 'copias' } as const, [])
const duplicated = atom({ plugin: 'agent-bots', key: 'duplicado' } as const, false)
// Las tareas hechas se pueden ocultar sin borrarlas; la elección dura toda la sesión, recargas incluidas.
const hideDone = atom({ plugin: 'agent-bots', key: 'ocultarHechas' } as const, false)
// Cada sección se puede plegar desde su encabezado.
const foldAgents = atom({ plugin: 'agent-bots', key: 'plegarAgentes' } as const, false)
const foldTasks = atom({ plugin: 'agent-bots', key: 'plegarTareas' } as const, false)
// Con planes largos solo se ven las próximas pendientes; el resto, a demanda.
const allPending = atom({ plugin: 'agent-bots', key: 'verPendientes' } as const, false)
const PENDING_PREVIEW = 5
const foldBudget = atom({ plugin: 'agent-bots', key: 'plegarPresupuesto' } as const, false)
const foldChanges = atom({ plugin: 'agent-bots', key: 'plegarCambios' } as const, false)
// Los agentes terminados se pliegan en «Ver N listos»: la atención va a lo que sigue activo.
const showEnded = atom({ plugin: 'agent-bots', key: 'verListos' } as const, false)
const context = atom({ plugin: 'agent-bots', key: 'contexto' } as const, null)
const changes = atom({ plugin: 'agent-bots', key: 'cambios' } as const, null)
const diffView = atom({ plugin: 'agent-bots', key: 'diff' } as const, null)
// Agente desplegado y acción que espera confirmación («turn», «clear» o «stop:<clave>»).
const opened = atom({ plugin: 'agent-bots', key: 'abierto' } as const, null)
const confirming = atom({ plugin: 'agent-bots', key: 'confirmar' } as const, null)
// El hilo principal está en un turno; su modelo y lo último que hizo.
const busy = atom({ plugin: 'agent-bots', key: 'ocupado' } as const, false)
const mainModel = atom({ plugin: 'agent-bots', key: 'modelo' } as const, '')
const mainAction = atom({ plugin: 'agent-bots', key: 'accion' } as const, '')
const LOG_KEEP = 6
const CTX_WARN = 70
// Lo plegado se recuerda entre sesiones ($.store dura más que el estado de la sesión).
type FoldKey = 'plegarPresupuesto' | 'plegarAgentes' | 'plegarTareas' | 'plegarCambios'

// Sin señales en este tiempo, un robot que dice trabajar pasa a «¿Colgado?». Un comando
// (compilar, una consulta larga) no da señales mientras corre: se le da más margen.
const STALL_AGENT_MS = 10 * 60_000
const STALL_SHELL_MS = 20 * 60_000

// Cada carga del módulo es una copia; dos copias vivas cuentan todo doble.
const INSTANCE = Math.random().toString(36).slice(2, 10)
const BEAT_MS = 15_000
const ALIVE_MS = 40_000

// Las dos ventanas de cuota que se dibujan, en este orden.
const QUOTA: { kind: string; label: string; ramp: [string, string] }[] = [
  { kind: 'five_hour', label: '5 h', ramp: ['#AFA9EC', '#7F77DD'] },
  { kind: 'seven_day', label: 'Semana', ramp: ['#5DCAA5', '#1D9E75'] },
]
const WARN: [string, string] = ['#FAC775', '#EF9F27']
const HOT: [string, string] = ['#F09595', '#E24B4A']
const now = atom({ plugin: 'agent-bots', key: 'now' } as const, 0)

const TASK_LABEL: Record<TaskStatus, [string, string]> = {
  in_progress: ['En curso', '#378ADD'],
  pending: ['Pendiente', '#888780'],
  completed: ['Hecha', '#639922'],
}
const TASK_GLYPH: Record<TaskStatus, string> = { in_progress: '🔄', pending: '⏳', completed: '✅' }

// Herramientas de la app que mueven la lista de tareas (se reconocen por el sufijo del nombre).
const PLAN_TOOL = '__update_plan'
const WRAP_TOOL = '__wrap_up'

// Herramienta propia del mod, para las sesiones que no traen ninguna de tareas.
const OWN_TOOL = 'mcp__agent-bots__tareas'
const OWN_SPEC = {
  name: 'tareas',
  description:
    'Muestra al usuario, en un panel lateral, la lista de tareas de la sesión. Envía el plan completo con «items»; ' +
    'después marca el avance con «advance», «done» o «start». Un paso a la vez en curso.',
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'La lista completa de pasos, en orden; sustituye a la anterior.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'El paso, en pocas palabras.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
      advance: { type: 'boolean', description: 'Marca como hecho el paso en curso y pone en curso el siguiente pendiente.' },
      done: { type: 'array', items: { type: 'number' }, description: 'Números de paso (desde 1) que pasan a hechos.' },
      start: { type: 'number', description: 'Número de paso (desde 1) que pasa a en curso.' },
    },
  },
}
const OWN_PROMPT =
  `Dispones de la herramienta \`${OWN_TOOL}\`, que muestra al usuario la lista de tareas en un panel lateral. ` +
  'En un trabajo de varios pasos, envía el plan completo al empezar (items, cada uno con status pending, in_progress o completed), ' +
  'llama con advance: true al terminar cada paso y reenvía la lista completa si el plan cambia. No la uses para preguntas simples.'
// Si la sesión ya trae su propia herramienta de tareas, la del mod no se ofrece en el prompt.
const HOST_LISTS = (name: string) =>
  name.endsWith(PLAN_TOOL) || name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskUpdate'

// Relleno, trazo y tinta de cada familia de modelo (rampas del mockup).
type Ramp = [string, string, string]
type Family = 'opus' | 'sonnet' | 'haiku' | 'other'
const RAMP: Record<Family, Ramp> = {
  opus: ['#EEEDFE', '#7F77DD', '#3C3489'],
  sonnet: ['#E6F1FB', '#378ADD', '#0C447C'],
  haiku: ['#E1F5EE', '#1D9E75', '#085041'],
  other: ['#F1EFE8', '#888780', '#444441'],
}
const FAIL: Ramp = ['#FCEBEB', '#E24B4A', '#791F1F']
const SHELL: Ramp = ['#FAEEDA', '#BA7517', '#633806']

const LABEL: Record<BotMood, [string, string]> = {
  run: ['Trabajando', '#378ADD'],
  sleep: ['Esperando', '#BA7517'],
  done: ['Listo', '#639922'],
  fail: ['Falló', '#E24B4A'],
}
const GLYPH: Record<BotMood, string> = { run: '🤖', sleep: '😴', done: '✅', fail: '💥' }

function family(model: string): Family {
  const m = model.toLowerCase()
  for (const f of ['opus', 'sonnet', 'haiku'] as const) if (m.includes(f)) return f
  return 'other'
}

function modelName(model: string): string {
  const f = family(model)
  if (f === 'other') return model || '?'
  const v = /(\d+)[-.](\d+)/.exec(model)
  return f.charAt(0).toUpperCase() + f.slice(1) + (v ? ` ${v[1]}.${v[2]}` : '')
}

function mood(status: string): BotMood {
  if (status === 'running' || status === 'pending') return 'run'
  if (status === 'waiting' || status === 'idle') return 'sleep'
  if (status === 'completed') return 'done'
  return 'fail'
}

const isEnded = (status: string) => ['completed', 'failed', 'killed'].includes(status)

// Por minutos a propósito: con segundos el panel tendría que redibujarse cada segundo, y cada
// redibujo reinicia las animaciones de los SVG y repinta los botones (el parpadeo).
function elapsed(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '<1 min'
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// La hora que dibuja el panel solo avanza de minuto en minuto: lo que muestra no tiene más detalle.
async function tick($: EngineInterface, t: number) {
  const cur = await read($, now)
  if (Math.floor(cur / 60_000) !== Math.floor(t / 60_000)) await update($, now, () => t)
}

function bar(done: number, total: number, width = 16): string {
  const full = total ? Math.round((done / total) * width) : 0
  return '█'.repeat(full) + '░'.repeat(width - full)
}

function base(path: unknown): string {
  return typeof path === 'string' ? path.split(/[\\/]/).pop() || path : ''
}

function clip(text: unknown, n = 38): string {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// Lo que dice el bocadillo según la herramienta que el agente acaba de usar.
function action(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Read': return `📖 Leyendo ${base(input.file_path)}`
    case 'Write': return `✏️ Creando ${base(input.file_path)}`
    case 'Edit': return `✏️ Editando ${base(input.file_path)}`
    case 'Grep': return `🔍 Grep "${clip(input.pattern, 28)}"`
    case 'Glob': return `🗂️ Buscando ${clip(input.pattern, 28)}`
    case 'Bash':
    case 'PowerShell': return `⚙️ ${clip(input.command)}`
    case 'WebFetch':
    case 'WebSearch': return `🌐 ${clip(input.url ?? input.query)}`
    case 'Agent': return `🤖 Lanzando ${clip(input.description, 30)}`
    default: return `🔧 ${clip(tool.replace(/^mcp__[^_]+__/, ''), 34)}`
  }
}

function robot(m: BotMood, model: string, kind: BotKind = 'agent'): string {
  const [fill, stroke, ink] = m === 'fail' ? FAIL : kind === 'shell' ? SHELL : RAMP[family(model)]
  const loop = 'repeatCount="indefinite"'
  const bodyAnim =
    m === 'run' ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -3;0 0" dur="1.2s" ${loop}/>`
    : m === 'done' ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -8;0 0;0 0" keyTimes="0;0.2;0.4;1" dur="2.5s" ${loop}/>`
    : m === 'fail' ? `<animateTransform attributeName="transform" type="translate" values="0 0;-2 0;2 0;0 0" dur="0.4s" repeatCount="3"/>`
    : ''
  const blink = m === 'run' ? `<animate attributeName="opacity" values="1;0.2;1" dur="0.8s" ${loop}/>` : ''
  const look = m === 'run'
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 0;2.5 0;2.5 0;0 0" keyTimes="0;0.4;0.5;0.9;1" dur="3s" ${loop}/>`
    : ''
  const eyes =
    m === 'sleep' ? `<rect x="20" y="25" width="8" height="2" rx="1" fill="${ink}"/><rect x="36" y="25" width="8" height="2" rx="1" fill="${ink}"/>`
    : m === 'fail' ? `<path d="M20 22l7 6M27 22l-7 6M37 22l7 6M44 22l-7 6" stroke="${ink}" stroke-width="2"/>`
    : `<g>${look}<circle cx="24" cy="25" r="4" fill="${ink}"/><circle cx="40" cy="25" r="4" fill="${ink}"/><circle cx="25.5" cy="23.5" r="1.2" fill="#fff"/><circle cx="41.5" cy="23.5" r="1.2" fill="#fff"/></g>`
  const mouth =
    m === 'done' ? `<path d="M26 33q6 5 12 0" stroke="${ink}" stroke-width="2" fill="none"/>`
    : m === 'fail' ? `<path d="M26 36q6-5 12 0" stroke="${ink}" stroke-width="2" fill="none"/>`
    : `<rect x="27" y="33" width="10" height="2" rx="1" fill="${ink}"/>`
  const z = (x: number, y: number, size: number, begin: string) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-family="sans-serif" fill="${stroke}" opacity="0">z` +
    `<animate attributeName="opacity" values="0;1;0" dur="2.4s" begin="${begin}" ${loop}/>` +
    `<animateTransform attributeName="transform" type="translate" values="0 0;8 -14" dur="2.4s" begin="${begin}" ${loop}/></text>`
  const extra =
    m === 'sleep' ? z(46, 14, 11, '0s') + z(50, 10, 9, '1.2s')
    : m === 'done' ? `<circle cx="52" cy="52" r="7" fill="#639922"/><path d="M48.5 52l2.5 2.5 4-4.5" stroke="#fff" stroke-width="1.8" fill="none"/>`
    : ''
  // El robot de un comando lleva un engranaje en lugar de antena, que gira mientras corre.
  const spin = m === 'run'
    ? `<animateTransform attributeName="transform" type="rotate" values="0 32 7;360 32 7" dur="2s" ${loop}/>`
    : ''
  const top = kind === 'shell'
    ? `<g>${spin}<circle cx="32" cy="7" r="5" fill="none" stroke="${stroke}" stroke-width="3" stroke-dasharray="2.6 1.6"/>` +
      `<circle cx="32" cy="7" r="2.2" fill="${stroke}"/></g>`
    : `<line x1="32" y1="6" x2="32" y2="13" stroke="${stroke}" stroke-width="2"/>` +
      `<circle cx="32" cy="5" r="3" fill="${stroke}">${blink}</circle>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<g opacity="${m === 'done' ? 0.8 : 1}"><g>${bodyAnim}` +
    top +
    `<rect x="12" y="13" width="40" height="28" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
    eyes + mouth +
    `<rect x="20" y="43" width="24" height="14" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
    `<circle cx="32" cy="50" r="2.5" fill="${stroke}">${blink}</circle>` +
    `</g></g>${extra}</svg>`
  )
}

// Recorta la lista: primero se van los terminados más antiguos.
function trim(list: Bot[]): Bot[] {
  let out = list
  while (out.length > KEEP) {
    const i = out.findIndex(b => isEnded(b.status))
    out = out.filter((_, j) => j !== (i === -1 ? 0 : i))
  }
  return out
}

// Anillo de cuota, estático a propósito: el panel se redibuja cada segundo mientras hay tareas en curso
// y cualquier animación SMIL en el SVG se reinicia con cada redibujo (ese era el latido). El color avisa:
// ámbar desde el 70 % y rojo desde el 90 %, salvo en los anillos donde llenarse es bueno (caché).
function gauge(pct: number, ramp: [string, string], id: string, warn = true): string {
  const p = Math.max(0, Math.min(100, pct))
  const [light, deep] = warn && p >= 90 ? HOT : warn && p >= 70 ? WARN : ramp
  const c = 2 * Math.PI * 30
  const len = ((p / 100) * c).toFixed(1)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">` +
    `<defs><linearGradient id="q-${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${deep}"/></linearGradient></defs>` +
    `<circle cx="40" cy="40" r="30" fill="none" stroke="#888780" stroke-opacity="0.22" stroke-width="7"/>` +
    `<g transform="rotate(-90 40 40)"><circle cx="40" cy="40" r="30" fill="none" stroke="url(#q-${id})" stroke-width="7" ` +
    `stroke-linecap="round" stroke-dasharray="${len} ${c.toFixed(1)}"/></g>` +
    `<text x="40" y="46" text-anchor="middle" font-family="sans-serif" font-size="17" font-weight="600" fill="${deep}">${Math.round(p)}%</text>` +
    `</svg>`
  )
}

// Etiqueta de cada robot: el nombre del modelo sobre su color, legible sin mirar la leyenda.
function modelChip(b: Bot): { text: string; ramp: Ramp } {
  if (b.kind === 'shell') return { text: 'Comando', ramp: SHELL }
  if (!b.model) return { text: 'sin dato', ramp: RAMP.other }
  return { text: modelName(b.model), ramp: RAMP[family(b.model)] }
}

// Barra de avance de las tareas, redondeada y con el degradado de los anillos (estática: sin SMIL).
function progressBar(frac: number, complete: boolean): string {
  const w = 220
  const f = Math.round(w * Math.max(0, Math.min(1, frac)))
  const [a, b] = complete ? ['#97C459', '#639922'] : ['#85B7EB', '#378ADD']
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="10" viewBox="0 0 ${w} 10">` +
    `<defs><linearGradient id="pb" x1="0" x2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
    `<rect x="0" y="1" width="${w}" height="8" rx="4" fill="#888780" fill-opacity="0.22"/>` +
    (f > 0 ? `<rect x="0" y="1" width="${Math.max(8, f)}" height="8" rx="4" fill="url(#pb)"/>` : '') +
    `</svg>`
  )
}

// Barra fina de presupuesto (estática: sin SMIL, para que el redibujo no la haga latir).
function thinBar(pct: number, color: string, w = 84): string {
  const f = Math.round(w * Math.max(0, Math.min(1, pct / 100)))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6">` +
    `<rect x="0" y="0" width="${w}" height="6" rx="3" fill="#888780" fill-opacity="0.22"/>` +
    (f > 0 ? `<rect x="0" y="0" width="${Math.max(6, f)}" height="6" rx="3" fill="${color}"/>` : '') +
    `</svg>`
  )
}

// Color de una barra de presupuesto: el suyo, ámbar desde el 70 % y rojo desde el 90 %.
function budgetColor(pct: number, own: string): string {
  return pct >= 90 ? HOT[1] : pct >= CTX_WARN ? WARN[1] : own
}

// Minutos y segundos desde el arranque del agente, para su historial.
function offset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function bar10(pct: number): string {
  const full = Math.round(Math.max(0, Math.min(100, pct)) / 10)
  return '█'.repeat(full) + '░'.repeat(10 - full)
}

// Cuánto falta para que la ventana se reinicie: «45 min», «2h 14m» o «3d 4h».
function resetIn(iso: string | undefined, t: number): string {
  const at = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(at)) return ''
  const m = Math.max(0, Math.round((at - t) / 60000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// Guarda las ventanas de 5 h y semana; avisa una vez al cruzar el 90 %.
async function readLimits($: EngineInterface, fresh: readonly { kind: string; percentUsed: number; resetsAt?: string }[]) {
  const before = await read($, limits)
  const next: Limit[] = []
  for (const { kind, label } of QUOTA) {
    const got = fresh.find(l => l.kind === kind)
    if (!got) continue
    const old = before.find(l => l.kind === kind)
    next.push({ kind, percentUsed: got.percentUsed, prevPercent: old?.percentUsed ?? 0, resetsAt: got.resetsAt })
    if ((old?.percentUsed ?? 0) < 90 && got.percentUsed >= 90) {
      try {
        void $.ui.toast(`Cuota de ${label} al ${Math.round(got.percentUsed)} %`)
      } catch {}
    }
  }
  if (next.length) await update($, limits, () => next)
  startQuotaClock($)
}

let quotaClock: Timer | undefined

// La cuenta regresiva del reinicio se mueve aunque no haya agentes: un pulso por minuto.
function startQuotaClock($: EngineInterface) {
  if (quotaClock) return
  quotaClock = $.clock.every(60000, () => {
    void $.clock.now().then(t => tick($, t)).catch(() => {})
  })
}

function asStatus(value: unknown): TaskStatus {
  return value === 'in_progress' || value === 'completed' ? value : 'pending'
}

// El indicador de cada tarea: anillo que gira, visto verde o círculo punteado.
function taskMark(s: TaskStatus): string {
  const loop = 'repeatCount="indefinite"'
  const body =
    s === 'completed'
      ? `<circle cx="12" cy="12" r="10" fill="#639922"/><path d="M7.5 12.5l3 3 6-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      : s === 'in_progress'
        ? `<circle cx="12" cy="12" r="9" fill="none" stroke="#B5D4F4" stroke-width="3"/>` +
          `<g><animateTransform attributeName="transform" type="rotate" values="0 12 12;360 12 12" dur="1s" ${loop}/>` +
          `<path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="#378ADD" stroke-width="3" stroke-linecap="round"/></g>`
        : `<circle cx="12" cy="12" r="9" fill="none" stroke="#B4B2A9" stroke-width="2" stroke-dasharray="3 3"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`
}

// Recibe una lista nueva y conserva los tiempos de las tareas que ya estaban.
function fromItems(old: Task[], items: { content: string; status: TaskStatus }[], t: number): Task[] {
  const used = new Set<number>()
  return items.map((it, i) => {
    const j = old.findIndex((o, k) => !used.has(k) && o.content === it.content)
    if (j !== -1) used.add(j)
    const prev = j === -1 ? undefined : old[j]
    return {
      key: prev?.key ?? `p${t}:${i}`,
      ref: prev?.ref,
      content: it.content,
      status: it.status,
      startedAt: it.status === 'pending' ? undefined : (prev?.startedAt ?? t),
      endedAt: it.status === 'completed' ? (prev?.endedAt ?? t) : undefined,
    }
  })
}

function setStatus(task: Task, status: TaskStatus, t: number): Task {
  if (task.status === status) return task
  return {
    ...task,
    status,
    startedAt: status === 'pending' ? undefined : (task.startedAt ?? t),
    endedAt: status === 'completed' ? t : undefined,
  }
}

// update_plan de la app: «items» sustituye la lista; «advance», «done» y «start» mueven pasos.
function applyPlan(list: Task[], input: Record<string, unknown>, t: number): Task[] {
  if (Array.isArray(input.items)) {
    const items = (input.items as Record<string, unknown>[]).map(it => ({
      content: String(it?.content ?? ''),
      status: asStatus(it?.status),
    }))
    return fromItems(list, items, t)
  }
  const next = [...list]
  const at = (n: unknown) => (typeof n === 'number' ? n - 1 : -1)
  if (input.advance === true) {
    const cur = next.findIndex(x => x.status === 'in_progress')
    if (cur !== -1) next[cur] = setStatus(next[cur], 'completed', t)
    const nxt = next.findIndex(x => x.status === 'pending')
    if (nxt !== -1) next[nxt] = setStatus(next[nxt], 'in_progress', t)
  }
  if (Array.isArray(input.done)) {
    for (const n of input.done) if (next[at(n)]) next[at(n)] = setStatus(next[at(n)], 'completed', t)
  }
  if (next[at(input.start)]) next[at(input.start)] = setStatus(next[at(input.start)], 'in_progress', t)
  return next
}

// wrap_up cierra el turno: lo que seguía en curso queda hecho.
function applyWrap(list: Task[], t: number): Task[] {
  return list.map(x => (x.status === 'in_progress' ? setStatus(x, 'completed', t) : x))
}

function applyTodos(list: Task[], input: Record<string, unknown>, t: number): Task[] {
  const todos = Array.isArray(input.todos) ? (input.todos as Record<string, unknown>[]) : []
  return fromItems(
    list,
    todos.map(it => ({ content: String(it?.content ?? ''), status: asStatus(it?.status) })),
    t,
  )
}

function applyUpdate(list: Task[], input: Record<string, unknown>, t: number): Task[] {
  const id = String(input.taskId ?? '')
  if (input.status === 'deleted') return list.filter(x => x.ref !== id)
  return list.map(x => {
    if (x.ref !== id) return x
    const renamed = typeof input.subject === 'string' && input.subject ? { ...x, content: input.subject } : x
    return input.status ? setStatus(renamed, asStatus(input.status), t) : renamed
  })
}

// Qué le hace una llamada a la lista de tareas; undefined si la herramienta no es de tareas.
// «fresh» marca una lista nueva entera (abre el panel).
function step(tool: string, input: Record<string, unknown>, result: unknown, t: number):
  { apply: (list: Task[]) => Task[]; fresh: boolean } | undefined {
  if (tool.endsWith(PLAN_TOOL) || tool === OWN_TOOL) {
    return { apply: l => applyPlan(l, input, t), fresh: Array.isArray(input.items) }
  }
  if (tool.endsWith(WRAP_TOOL)) return { apply: l => applyWrap(l, t), fresh: false }
  if (tool === 'TodoWrite') return { apply: l => applyTodos(l, input, t), fresh: true }
  if (tool === 'TaskCreate') {
    const made = (result as { task?: { id?: unknown } } | null | undefined)?.task?.id
    const ref = typeof made === 'string' ? made : undefined
    return {
      apply: l => [...l, { key: `c${t}:${l.length}`, ref, content: String(input.subject ?? ''), status: 'pending' }],
      fresh: false,
    }
  }
  if (tool === 'TaskUpdate') return { apply: l => applyUpdate(l, input, t), fresh: false }
  return undefined
}

async function track($: EngineInterface, tool: string, input: Record<string, unknown>, result: unknown) {
  const t = await $.clock.now()
  const s = step(tool, input, result, t)
  if (!s) return
  const before = await read($, tasks)

  await update($, tasks, s.apply)
  await tick($, t)
  if (s.fresh || before.length === 0) void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
  const after = await read($, tasks)
  if (after.some(x => x.status === 'in_progress')) startTicker($)
  const allDone = (l: Task[]) => l.length > 0 && l.every(x => x.status === 'completed')
  if (allDone(after) && !allDone(before)) toast($, `✅ Plan terminado: ${after.length} tareas`)
}

// La primera vez que el mod se carga en una sesión, rehace la lista con las llamadas que ya
// hubo, para no arrancar vacío con un plan a medias. Una sola vez por sesión: si luego se
// limpia la lista, una recarga no la resucita.
async function replay($: EngineInterface) {
  if (await read($, replayed)) return
  await update($, replayed, () => true)
  if ((await read($, tasks)).length) return
  const t = await $.clock.now()
  let list: Task[] = []
  for (const m of await $.session.messages()) {
    for (const use of m.toolUses ?? []) {
      if (use.isError) continue
      const s = step(use.tool, use.input, use.result, t)
      if (s) list = s.apply(list)
    }
  }
  if (!list.length) return
  // El historial no trae horas: lo hecho queda sin duración y lo que sigue en curso cuenta desde ahora.
  list = list.map(x => (x.status === 'completed' ? { ...x, startedAt: undefined, endedAt: undefined } : x))
  await update($, tasks, () => list)
  await tick($, t)
  if (list.some(x => x.status === 'in_progress')) startTicker($)
}

function toast($: EngineInterface, text: string) {
  try {
    void $.ui.toast(text)
  } catch {}
}

// Avisa una sola vez de cada agente en segundo plano o comando que terminó o falló: lo de primer
// plano no, porque la sesión ya está esperándolo. «told» queda en el estado, así una recarga no repite.
async function tellEnds($: EngineInterface) {
  const list = await read($, bots)
  const fresh = list.filter(b => isEnded(b.status) && !b.told && (b.kind === 'shell' || b.background))
  if (!fresh.length) return
  await update($, bots, l => l.map(b => (fresh.some(f => f.key === b.key) ? { ...b, told: true } : b)))
  for (const b of fresh) {
    const what = b.kind === 'shell' ? 'Comando' : 'Agente'
    toast($, b.status === 'completed' ? `✅ ${what} terminado: ${clip(b.description, 50)}` : `💥 ${what} falló: ${clip(b.description, 50)}`)
  }
}

// Lo que ya había terminado al cargarse esta versión no se anuncia.
async function quietEnded($: EngineInterface) {
  await update($, bots, l => l.map(b => (isEnded(b.status) && !b.told ? { ...b, told: true } : b)))
}

let beat: Timer | undefined
// Cuándo arrancó esta copia y cuándo procesó su último evento de la sesión.
let bornAt = 0
let lastEvent = 0

// Latido de esta copia; si otra copia late a la vez, el panel lo avisa. Solo cuenta una copia que
// procesó eventos después de que arrancara esta: al recargar, la copia vieja aún da un último
// latido antes de apagarse, pero ya no recibe eventos, y eso no es un duplicado.
function startBeat($: EngineInterface) {
  if (beat) return
  const pulse = async () => {
    const t = await $.clock.now()
    let alive = 0
    await update($, copies, l => {
      const next = [
        ...l.filter(c => c.id !== INSTANCE && t - c.at < ALIVE_MS),
        { id: INSTANCE, at: t, ev: lastEvent },
      ]
      alive = next.filter(c => (c.ev ?? 0) > bornAt).length
      return next
    })
    const dup = alive > 1
    if (dup !== (await read($, duplicated))) {
      await update($, duplicated, () => dup)
      if (dup) toast($, '⚠ agent-bots está cargado dos veces: los conteos saldrán dobles')
    }
  }
  beat = $.clock.every(BEAT_MS, () => void pulse().catch(() => {}))
  void pulse().catch(() => {})
}

let seq = 0
let ticker: Timer | undefined

// Une la lista viva del motor con lo que guardamos al lanzar cada agente (sin efectos: la usa sync).
function merge(list: Bot[], infos: AgentInfo[], t: number): Bot[] {
  const taken = new Set(list.map(b => b.id).filter(Boolean))
  const next = list.map(b => {
    if (b.kind === 'shell') return b
    let info = b.id ? infos.find(i => i.id === b.id) : undefined
    if (!b.id) {
      info = infos.find(i => !taken.has(i.id) && i.description === b.description)
      if (info) taken.add(info.id)
    }
    if (!info) return b
    const ended = isEnded(info.status)
    return {
      ...b,
      id: info.id,
      status: info.status,
      endedAt: ended ? (b.endedAt ?? t) : undefined,
    }
  })
  // Adopta los agentes vivos cuyo arranque el mod no vio (lanzados antes de cargarse).
  // Su modelo no se conoce: salen en gris y sin hora de inicio exacta.
  for (const info of infos) {
    if (taken.has(info.id) || isEnded(info.status)) continue
    taken.add(info.id)
    next.push({
      key: `adopted:${info.id}`,
      kind: 'agent',
      id: info.id,
      description: info.description || info.name || info.type,
      type: info.type,
      model: '',
      status: info.status,
      startedAt: t,
      lastSeen: t,
      background: true,
      action: '👀 Ya estaba en marcha',
      calls: 0,
    })
  }
  return trim(next)
}

// Corre cada segundo mientras hay actividad: solo escribe si algo cambió de verdad, porque cada
// escritura redibuja el panel entero.
async function sync($: EngineInterface): Promise<boolean> {
  const infos: AgentInfo[] = await $.agent.list()
  const t = await $.clock.now()
  const current = await read($, bots)
  const seen = merge(current, infos, t)
  if (JSON.stringify(seen) !== JSON.stringify(current)) {
    await update($, bots, list => merge(list, infos, t))
  }
  await tick($, t)
  await tellEnds($).catch(() => {})
  return seen.some(b => !isEnded(b.status))
}

// Un solo reloj por carga del módulo; se apaga solo cuando no queda nadie activo.
function startTicker($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    sync($)
      .then(async active => {
        const doing = (await read($, tasks)).some(x => x.status === 'in_progress')
        if (!active && !doing && ticker) {
          ticker.cancel()
          ticker = undefined
        }
      })
      .catch(() => {})
  })
}

// Respaldo: al acabar un turno el motor puede entregar la lista de lo que sigue en marcha,
// y lo que falta en ella ya terminó. No siempre la trae; la señal principal es el aviso.
async function settleShells($: EngineInterface, inFlight: readonly { id: string }[] | undefined) {
  if (!Array.isArray(inFlight)) return
  const alive = new Set(inFlight.map(task => task.id))
  const t = await $.clock.now()
  await update($, bots, list =>
    list.map(b =>
      b.kind === 'shell' && !isEnded(b.status) && b.taskId && !alive.has(b.taskId)
        ? { ...b, status: 'completed', endedAt: t }
        : b,
    ),
  )
  await tellEnds($).catch(() => {})
}

// Cuando un comando en segundo plano termina, la sesión recibe un aviso de tarea
// (<task-notification>) con su id, la llamada que lo lanzó y cómo acabó.
function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)
  return m?.[1]?.trim() || undefined
}

async function finishFromNotice($: EngineInterface, text: string) {
  const taskId = tag(text, 'task-id')
  const toolUseId = tag(text, 'tool-use-id')
  const status = tag(text, 'status')
  if (!taskId && !toolUseId) return
  const ended = status === 'failed' || status === 'killed' ? status : 'completed'
  const t = await $.clock.now()
  await update($, bots, list =>
    list.map(b =>
      b.kind === 'shell' && !isEnded(b.status) &&
      ((taskId && b.taskId === taskId) || (toolUseId && b.toolUseId === toolUseId))
        ? { ...b, status: ended, endedAt: t }
        : b,
    ),
  )
  await tellEnds($).catch(() => {})
}

// Lo cambiado respecto a HEAD: «git diff --numstat» da las líneas exactas, no una cuenta de ediciones.
// Fuera de un repositorio (o sin git) la sección no se dibuja.
async function readChanges($: EngineInterface): Promise<Changes | null> {
  const cwd = await $.session.cwd()
  const diff = await $.process.run(['git', '-C', cwd, 'diff', '--numstat', 'HEAD'], { timeoutMs: 8000 })
  if (diff.exitCode !== 0) return null
  const files: Change[] = []
  for (const line of diff.stdout.split('\n')) {
    const [a, d, ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (!path) continue
    files.push({ path, add: Number(a) || 0, del: Number(d) || 0 })
  }
  files.sort((x, y) => y.add + y.del - (x.add + x.del))
  const extra = await $.process.run(['git', '-C', cwd, 'ls-files', '--others', '--exclude-standard'], { timeoutMs: 8000 })
  const untracked = extra.exitCode === 0 ? extra.stdout.split('\n').filter(Boolean).length : 0
  return {
    files,
    add: files.reduce((n, f) => n + f.add, 0),
    del: files.reduce((n, f) => n + f.del, 0),
    untracked,
  }
}

let changesTimer: Timer | undefined
// El turno del hilo principal que está corriendo, para poder detenerlo desde el panel.
let currentTurn: string | undefined
// Tras una edición se relee git una sola vez cada pocos segundos, aunque lleguen muchas seguidas.
function refreshChanges($: EngineInterface, wait = 1500) {
  if (changesTimer) return
  changesTimer = $.clock.after(wait, () => {
    changesTimer = undefined
    void readChanges($)
      .then(c => update($, changes, () => c))
      .catch(() => {})
  })
}

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Cada atom se nombra a mano: el escáner de estado necesita ver la clave literal en cada escritura.
async function loadFolds($: EngineInterface) {
  const get = async (key: FoldKey) => {
    const v = await $.store.get(key)
    return typeof v === 'boolean' ? v : undefined
  }
  const b = await get('plegarPresupuesto')
  if (b !== undefined) await update($, foldBudget, () => b)
  const a = await get('plegarAgentes')
  if (a !== undefined) await update($, foldAgents, () => a)
  const t = await get('plegarTareas')
  if (t !== undefined) await update($, foldTasks, () => t)
  const c = await get('plegarCambios')
  if (c !== undefined) await update($, foldChanges, () => c)
}

function toggleFold($: EngineInterface, key: FoldKey) {
  const save = (v: boolean) => $.store.set(key, v)
  const run = async () => {
    if (key === 'plegarPresupuesto') {
      await update($, foldBudget, v => !v)
      await save(await read($, foldBudget))
    } else if (key === 'plegarAgentes') {
      await update($, foldAgents, v => !v)
      await save(await read($, foldAgents))
    } else if (key === 'plegarTareas') {
      await update($, foldTasks, v => !v)
      await save(await read($, foldTasks))
    } else {
      await update($, foldChanges, v => !v)
      await save(await read($, foldChanges))
    }
  }
  void run().catch(() => {})
}

async function readContext($: EngineInterface, c: Ctx) {
  await update($, context, () => ({ tokens: c.tokens, window: c.window, percent: c.percent }))
}

// En la app de escritorio la sesión es de SDK: ahí el motor aún no deja a un mod compactar ni
// limpiar. Entonces se deja el comando escrito en la caja del prompt y basta con pulsar Enter.
async function viaPrompt($: EngineInterface, command: string): Promise<boolean> {
  const box = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
  if (box.text.trim()) {
    toast($, `Tu caja del prompt tiene texto: borra o envía antes de usar ${command}`)
    return false
  }
  const r = await $.prompt.fill({ text: command }).catch(() => ({ isFilled: false }))
  toast($, r.isFilled ? `${command} listo en la caja del prompt: pulsa Enter` : `Escribe ${command} en la caja del prompt`)
  return r.isFilled
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    ticker = undefined
    quotaClock = undefined
    beat = undefined
    bornAt = await $.clock.now()
    lastEvent = 0
    // Una copia que arranca borra los latidos viejos: tras una recarga, la copia anterior ya no está.
    await update($, copies, () => []).catch(() => {})
    startBeat($)
    await quietEnded($).catch(() => {})
    // La cuota se lee al arrancar; después llega sola con cada medición.
    await $.session.usage()
      .then(async u => {
        await readLimits($, u.rateLimits)
        await readContext($, u.context)
      })
      .catch(() => {})
    await loadFolds($).catch(() => {})
    await $.session.model().then(m => update($, mainModel, () => m)).catch(() => {})
    changesTimer = undefined
    currentTurn = undefined
    refreshChanges($, 0)
    await $.command.register({
      name: 'bots',
      description: 'Abre el panel de agentes y tareas',
    })
    await $.command.register({
      name: 'tareas',
      description: 'Abre el panel de agentes y tareas',
    })
    await $.tool.register(OWN_SPEC).catch(() => {})
    await replay($).catch(() => {})
    // Recoge también los agentes que ya corrían cuando el mod se cargó.
    void sync($)
      .then(active => {
        if (active) startTicker($)
      })
      .catch(() => {})

    return next(e)
  })

  on('command.run', { command: 'bots' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await sync($)
    refreshChanges($, 0)

    return { text: 'Panel de agentes y tareas abierto.' }
  })

  on('command.run', { command: 'tareas' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await sync($)
    refreshChanges($, 0)

    return { text: 'Panel de agentes y tareas abierto.' }
  })

  // Solo observa: el panel nunca debe impedir ni duplicar un lanzamiento, así que
  // lo suyo va en try y, si aun así algo falla, el .catch deja pasar el original.
  on('agent.spawn', async ($, e, next) => {
    const key = `${e.tool_use_id}:${++seq}`
    const model = e.fork ? e.parentModel : (e.model ?? e.parentModel)
    try {
      const bot: Bot = {
        key,
        description: e.description || e.subagentType,
        type: e.subagentType,
        model,
        status: 'pending',
        startedAt: await $.clock.now(),
        background: e.background,
        action: '💭 Pensando…',
        calls: 0,
      }
      bot.lastSeen = bot.startedAt
      await update($, bots, list => trim([...list, bot]))
      void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
      startTicker($)
    } catch {}

    const set = (patch: Partial<Bot>) =>
      update($, bots, list => list.map(b => (b.key === key ? { ...b, ...patch } : b))).catch(() => {})
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await set({ status: 'failed', action: '✗ No arrancó' })
      throw err
    }
    if (ran.deny) await set({ status: 'failed', action: `✗ ${clip(ran.deny, 40)}` })
    else await set({ id: ran.agentId, model: ran.model || model, status: 'running' })

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    void $.clock.now().then(t => (lastEvent = t)).catch(() => {})
    // Los parámetros de la herramienta vienen en el propio evento.
    const input = e as unknown as Record<string, unknown>
    const agentId = e.agentId

    // La herramienta propia la atiende el mod mismo: actualiza la lista y le contesta al modelo.
    if (e.tool === OWN_TOOL) {
      if (agentId) return { result: 'La lista de tareas la mantiene la sesión principal.' }
      if (!Array.isArray(input.items) && !input.advance && !Array.isArray(input.done) && typeof input.start !== 'number') {
        return { result: 'Indica «items» (lista completa), «advance», «done» o «start».' }
      }
      await track($, e.tool, input, undefined)
      const list = await read($, tasks)
      const doing = list.find(x => x.status === 'in_progress')
      const done = list.filter(x => x.status === 'completed').length
      return { result: `Lista actualizada: ${done}/${list.length} hechas${doing ? `; en curso: ${doing.content}` : ''}.` }
    }

    if (agentId) {
      const text = action(e.tool, input)
      const seen = await $.clock.now()
      void update($, bots, list =>
        list.map(b =>
          b.id === agentId
            ? {
                ...b,
                action: text,
                calls: b.calls + 1,
                lastSeen: seen,
                status: isEnded(b.status) ? b.status : 'running',
                log: [...(b.log ?? []), { at: seen, text }].slice(-LOG_KEEP),
              }
            : b,
        ),
      ).catch(() => {})
    }

    // Lo último que hizo el hilo principal, para la línea de estado de arriba.
    if (!agentId && !step(e.tool, input, undefined, 0) && e.tool !== 'Agent') {
      void update($, mainAction, () => action(e.tool, input)).catch(() => {})
    }

    const ran = await next(e)

    if (EDITS.has(e.tool)) refreshChanges($)

    // El texto final de un agente de primer plano llega al cerrarse su llamada: se guarda para copiarlo.
    if (e.tool === 'Agent' && !agentId) {
      const text = (ran as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) {
        const prefix = `${e.tool_use_id}:`
        void update($, bots, list =>
          list.map(b => (b.key.startsWith(prefix) ? { ...b, result: text.slice(0, 20000) } : b)),
        ).catch(() => {})
      }
    }

    // Un comando que quedó en segundo plano (pedido así o con Ctrl+B) recibe su propio robot.
    if (e.tool === 'Bash' || e.tool === 'PowerShell') {
      const result = ran.result as { backgroundTaskId?: unknown } | null | undefined
      const taskId = result && typeof result.backgroundTaskId === 'string' ? result.backgroundTaskId : undefined
      if (taskId) {
        try {
          const shell: Bot = {
            key: `shell:${taskId}`,
            kind: 'shell',
            taskId,
            toolUseId: e.tool_use_id,
            description: clip(input.description, 60) || clip(input.command, 60) || e.tool,
            type: e.tool,
            model: '',
            status: 'running',
            startedAt: await $.clock.now(),
            action: `⚙️ ${clip(input.command)}`,
            calls: 0,
          }
          shell.lastSeen = shell.startedAt
          await update($, bots, list => trim([...list.filter(b => b.key !== shell.key), shell]))
          void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
          startTicker($)
        } catch {}
      }
    }

    // La lista de tareas es la de la sesión: las llamadas de un subagente son de su propia lista.
    if (!agentId) {
      try {
        await track($, e.tool, input, ran.result)
      } catch {}
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Cada petición del hilo principal (los subagentes tienen su propio prefijo): qué hizo la caché con ella.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    currentTurn = e.turnId
    void update($, busy, () => true).catch(() => {})
    if (e.model) void update($, mainModel, () => e.model).catch(() => {})
    const inicio = await $.clock.now()
    const r = yield* next(e)
    try {
      if (r.usage) {
        const nueva: Muestra = {
          modelo: r.usage.model || e.model,
          inicio,
          leido: r.usage.cache_read_input_tokens,
          escrito: r.usage.cache_creation_input_tokens,
          nuevo: r.usage.input_tokens,
        }
        const lista = [...(await read($, samples)), nueva].slice(-2)
        await update($, samples, () => lista)
        const plan = (await read($, limits)).map(l => ({ kind: l.kind, percentUsed: l.percentUsed }))
        const env = {
          force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(() => undefined),
          ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(() => undefined),
          enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(() => undefined),
        }
        const observado = observarTtl(lista[0] === nueva ? undefined : lista[0], nueva, undefined)
        await update($, cacheTtl, () => observado ?? decidirTtl(env, plan).ttl)
        await tick($, inicio)
      }
    } catch {}
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await readLimits($, e.rateLimits).catch(() => {})
    if (e.changed.includes('context')) await readContext($, e.context).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const ran = await next(e)
    if (e.tools.some(HOST_LISTS)) return ran
    return { sections: [...ran.sections, { id: 'agent-bots:tareas', text: OWN_PROMPT, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') await finishFromNotice($, e.text).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    currentTurn = undefined
    await update($, busy, () => false).catch(() => {})
    await update($, mainAction, () => '').catch(() => {})
    await settleShells($, e.background_tasks).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    await settleShells($, e.background_tasks).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    // Línea divisoria entre secciones: caracteres de caja tenues al ancho del panel, que se ve
    // igual en la app y en la terminal (no hay borde de un solo lado en los elementos).
    const rule = (key: string) => (
      <Text key={key} dimColor wrap="truncate-end">
        {'─'.repeat(Math.max(8, e.props.bodyColumns || 40))}
      </Text>
    )
    const list = await read($, bots)
    const t = (await read($, now)) || (await $.clock.now())
    const clock = await $.clock.now()

    const order: Record<BotMood, number> = { run: 0, sleep: 1, fail: 2, done: 3 }
    const sorted = [...list].sort(
      (a, b) => order[mood(a.status)] - order[mood(b.status)] || b.startedAt - a.startedAt,
    )
    const count = (m: BotMood) => list.filter(b => mood(b.status) === m).length
    const live = sorted.filter(b => !isEnded(b.status))
    const finished = sorted.filter(b => isEnded(b.status))

    const todo = await read($, tasks)
    const hiding = await read($, hideDone)
    const done = todo.filter(x => x.status === 'completed').length
    const doing = todo.filter(x => x.status === 'in_progress')
    const left = todo.length - done - doing.length
    const tmood: BotMood = doing.length ? 'run' : todo.length && done === todo.length ? 'done' : 'sleep'
    const since = todo.reduce((min, x) => (x.startedAt !== undefined && x.startedAt < min ? x.startedAt : min), Infinity)
    const pct = todo.length ? Math.round((done / todo.length) * 100) : 0

    const quota = await read($, limits)
    const ctx = await read($, context)
    const ctxPct = ctx?.percent
    const recent = await read($, samples)
    const last = recent[recent.length - 1]
    const ttl = await read($, cacheTtl)
    const leftMs = last ? restanteMs(last, ttl, clock) : 0

    const silentFor = (b: Bot) => t - (b.lastSeen ?? b.startedAt)
    const isStalled = (b: Bot) =>
      mood(b.status) === 'run' && silentFor(b) > (b.kind === 'shell' ? STALL_SHELL_MS : STALL_AGENT_MS)
    const stalled = list.filter(isStalled).length
    const twice = await read($, duplicated)
    const foldB = await read($, foldBudget)
    const foldA = await read($, foldAgents)
    const foldT = await read($, foldTasks)
    const foldC = await read($, foldChanges)
    const showE = await read($, showEnded)
    const showAll = await read($, allPending)
    const openKey = await read($, opened)
    const asking = await read($, confirming)
    const isBusy = await read($, busy)
    const model = await read($, mainModel)
    const doingNow = await read($, mainAction)
    const ch = await read($, changes)
    const dv = await read($, diffView)

    const pendingCount = todo.filter(x => x.status === 'pending').length
    let pendingShown = 0
    const visibleTasks = todo.filter(x => {
      if (x.status === 'completed') return !hiding
      if (x.status === 'in_progress') return true
      pendingShown += 1
      return showAll || pendingShown <= PENDING_PREVIEW
    })
    const hiddenPending = showAll ? 0 : Math.max(0, pendingCount - PENDING_PREVIEW)

    const ask = (key: string | null) => {
      void update($, confirming, () => key).catch(() => {})
    }
    const no = <Button key="confirm-no" label="No" onPress={() => ask(null)} />
    const chip = (text: string, ramp: Ramp) => (
      <Text backgroundColor={ramp[0]} color={ramp[2]}>{` ${text} `}</Text>
    )

    // Estado de arriba: lo que está haciendo ahora y, si hace falta, cómo pararlo.
    const cur = doing[0]
    const stepNo = cur ? todo.indexOf(cur) + 1 : 0
    const headline = cur
      ? cur.content
      : isBusy ? 'Trabajando'
      : live.length ? `${live.length} en segundo plano`
      : 'En espera'
    const detail = [
      stepNo ? `Paso ${stepNo} de ${todo.length}` : '',
      cur?.startedAt !== undefined ? elapsed(t - cur.startedAt) : '',
      isBusy ? doingNow : '',
    ].filter(Boolean).join(' · ')

    // Presupuesto: 5 h, semana y contexto como barras finas en tres columnas.
    const cols: { key: string; label: string; pct: number; color: string; sub: string; alt: string }[] = []
    for (const { kind, label, ramp } of QUOTA) {
      const l = quota.find(x => x.kind === kind)
      if (!l) continue
      const reset = resetIn(l.resetsAt, clock)
      cols.push({ key: kind, label, pct: l.percentUsed, color: ramp[1], sub: reset ? `↻ ${reset}` : '', alt: `Cuota ${label}` })
    }
    if (ctx && ctxPct !== undefined) {
      cols.push({
        key: 'context',
        label: 'Contexto',
        pct: ctxPct,
        color: '#378ADD',
        sub: ctx.tokens !== undefined ? `${tokens(ctx.tokens)} / ${tokens(ctx.window)}` : '',
        alt: 'Contexto',
      })
    }
    const ctxHigh = ctxPct !== undefined && ctxPct >= CTX_WARN
    const cacheLine = !last
      ? ''
      : last.leido + last.escrito === 0
        ? 'Caché sin usar'
        : leftMs > 0
          ? `Caché caliente · vence en ${leftMs < 60000 ? '<1 min' : `${Math.ceil(leftMs / 60000)} min`} · ${tokens(last.leido)} leído`
          : `Caché vencida · ${tokens(last.leido)} por reescribir`

    const head = (fold: FoldKey, key: string, folded: boolean, title: string, extra?: unknown, right?: unknown) => (
      <Box key={`h:${key}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
          <Button key={key} plain label={`${folded ? '▸' : '▾'} ${title}`} onPress={() => toggleFold($, fold)} />
          {extra as never}
        </Box>
        {right as never}
      </Box>
    )

    const row = (b: Bot) => {
      const hung = isStalled(b)
      const m = hung ? 'sleep' : mood(b.status)
      const [label, color] = hung ? ['¿Colgado?', WARN[1]] : LABEL[m]
      const shell = b.kind === 'shell'
      const c = modelChip(b)
      const isOpen = openKey === b.key
      const target = shell ? b.taskId : b.background ? (b.id ?? b.description) : undefined
      const canStop = !isEnded(b.status) && !!target
      return (
        <Box key={b.key} flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            {Svg ? (
              <Svg source={robot(m, b.model, b.kind)} alt={`Robot ${label.toLowerCase()}`} width={36} height={36} isInteractive />
            ) : (
              <Text>{shell && m === 'run' ? '⚙️' : GLYPH[m]}</Text>
            )}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text bold wrap="truncate-end">{b.description}</Text>
                <Box flexDirection="row" gap={1}>
                  <Button
                    key={`open:${b.key}`}
                    plain
                    label={isOpen ? '▾' : '▸'}
                    onPress={() => {
                      void update($, opened, k => (k === b.key ? null : b.key)).catch(() => {})
                    }}
                  />
                  <Button
                    key={`x:${b.key}`}
                    plain
                    label="✕"
                    onPress={() => {
                      void update($, bots, l => l.filter(one => one.key !== b.key)).catch(() => {})
                    }}
                  />
                </Box>
              </Box>
              <Text wrap="truncate-end">
                <Text color={color}>{label}</Text>{' '}
                {chip(c.text, c.ramp)}
                <Text dimColor>
                  {' · '}{elapsed((b.endedAt ?? t) - b.startedAt)}{shell ? '' : ` · ${b.calls} 🔧`}
                </Text>
              </Text>
              <Text wrap="truncate-end" dimColor={m !== 'run'}>
                {hung
                  ? `Sin señales hace ${elapsed(silentFor(b))} · ✕ para quitarlo`
                  : m === 'done' ? '✓ Terminado' : m === 'sleep' && b.calls === 0 ? 'zzz… esperando' : b.action}
              </Text>
            </Box>
          </Box>
          {isOpen && (b.log ?? []).map((x, i) => (
            <Text key={`log:${b.key}:${i}`} dimColor wrap="truncate-end">
              {`    ${offset(x.at - b.startedAt)}  ${x.text}`}
            </Text>
          ))}
          {isOpen && !(b.log ?? []).length && <Text dimColor>{'    Sin acciones registradas todavía'}</Text>}
          {isOpen && asking === `stop:${b.key}` && (
            <Box flexDirection="row" gap={1} justifyContent="flex-end" alignItems="center">
              <Text color={HOT[1]}>¿Detener este {shell ? 'comando' : 'agente'}?</Text>
              <Button
                key={`stop-yes:${b.key}`}
                variant="primary"
                label="Sí, detener"
                onPress={() => {
                  ask(null)
                  void $.tool.call({ tool: 'TaskStop', task_id: target })
                    .then(async r => {
                      if (r.deny) return toast($, `No se pudo detener: ${clip(r.deny, 60)}`)
                      const at = await $.clock.now()
                      await update($, bots, l => l.map(one => (one.key === b.key ? { ...one, status: 'killed', endedAt: at, told: true } : one)))
                      toast($, `⏹ Detenido: ${clip(b.description, 50)}`)
                    })
                    .catch(() => toast($, 'No se pudo detener'))
                }}
              />
              {no}
            </Box>
          )}
          {isOpen && asking !== `stop:${b.key}` && (
            <Box flexDirection="row" gap={1} justifyContent="flex-end">
              {canStop && <Button key={`stop:${b.key}`} label="Detener" onPress={() => ask(`stop:${b.key}`)} />}
              <Button
                key={`ask:${b.key}`}
                label="Preguntar"
                onPress={() => {
                  const q = `¿En qué va «${b.description}» y qué le falta?`
                  void $.prompt.read()
                    .then(box => $.prompt.fill(box.text.trim() ? { text: `\n${q}`, mode: 'append' } : { text: q }))
                    .then(r => {
                      if (!r.isFilled) toast($, 'No se pudo escribir en la caja del prompt')
                    })
                    .catch(() => {})
                }}
              />
              {b.result && (
                <Button
                  key={`copy:${b.key}`}
                  label="Copiar resultado"
                  onPress={press => {
                    void $.ui.copy({ text: b.result ?? '', surface: press.surface })
                      .then(r => toast($, r.isCopied ? 'Resultado copiado' : 'No se pudo copiar'))
                      .catch(() => {})
                  }}
                />
              )}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {twice && (
          <Text color={WARN[1]} wrap="wrap">
            ⚠ agent-bots está cargado dos veces (p. ej. una copia en dev-mods y la instalada): los conteos salen dobles. Quita una y recarga.
          </Text>
        )}

        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text bold wrap="truncate-end">
              <Text color={isBusy || live.length ? '#378ADD' : '#888780'}>● </Text>
              {headline}
            </Text>
            <Text wrap="truncate-end">
              {model ? chip(modelName(model), RAMP[family(model)]) : null}
              <Text dimColor>{detail ? ` ${detail}` : ''}</Text>
            </Text>
          </Box>
          {isBusy && currentTurn && asking !== 'turn' && (
            <Button key="turn-stop" label="Detener" onPress={() => ask('turn')} />
          )}
        </Box>
        {asking === 'turn' && (
          <Box flexDirection="row" gap={1} justifyContent="flex-end" alignItems="center">
            <Text color={HOT[1]}>¿Detener el turno en curso?</Text>
            <Button
              key="turn-stop-yes"
              variant="primary"
              label="Sí, detener"
              onPress={() => {
                ask(null)
                const id = currentTurn
                if (id) void $.turn.abort({ turnId: id }).catch(() => toast($, 'No se pudo detener el turno'))
              }}
            />
            {no}
          </Box>
        )}

        {(cols.length > 0 || last) && rule('rule:budget')}
        {(cols.length > 0 || last) && head('plegarPresupuesto', 'fold-budget', foldB, 'Presupuesto')}
        {!foldB && cols.length > 0 && (
          <Box flexDirection="row" gap={2} justifyContent="space-between">
            {cols.map(c => {
              const color = budgetColor(c.pct, c.color)
              return (
                <Box key={`q:${c.key}`} flexDirection="column" flexShrink={1}>
                  <Text dimColor>{c.label}</Text>
                  <Text bold color={c.pct >= CTX_WARN ? color : undefined}>{`${Math.round(c.pct)} %`}</Text>
                  {Svg ? (
                    <Svg source={thinBar(c.pct, color)} alt={`${c.alt}: ${Math.round(c.pct)} %`} width={84} height={6} />
                  ) : (
                    <Text color={color}>{bar10(c.pct)}</Text>
                  )}
                  {c.sub && <Text dimColor wrap="truncate-end">{c.sub}</Text>}
                </Box>
              )
            })}
          </Box>
        )}
        {!foldB && cacheLine && (
          <Text color={leftMs > 0 ? '#5DCAA5' : '#888780'} wrap="truncate-end">{cacheLine}</Text>
        )}
        {!foldB && ctxHigh && (
          <Text color={WARN[1]} wrap="wrap">
            {`Contexto al ${Math.round(ctxPct ?? 0)} %: compactar libera espacio y conserva el hilo.`}
          </Text>
        )}
        {!foldB && ctxPct !== undefined && asking !== 'clear' && (
          <Box flexDirection="row" gap={1} justifyContent="flex-end">
            <Button
              key="ctx-compact"
              variant={ctxHigh ? 'primary' : undefined}
              label="Compactar"
              onPress={() => {
                void $.session.compact({})
                  .then(r => toast($, r && 'skip' in r && r.skip ? 'Otro mod canceló la compactación' : 'Conversación compactada'))
                  .catch(() => viaPrompt($, '/compact'))
              }}
            />
            <Button key="ctx-clear" label="Limpiar" onPress={() => ask('clear')} />
          </Box>
        )}
        {!foldB && asking === 'clear' && (
          <Box flexDirection="row" gap={1} justifyContent="flex-end" alignItems="center">
            <Text color={HOT[1]}>¿Borrar la conversación?</Text>
            <Button
              key="ctx-clear-yes"
              variant="primary"
              label="Sí, limpiar"
              onPress={() => {
                ask(null)
                void $.command.run({ command: 'clear' })
                  .catch(() => viaPrompt($, '/clear'))
              }}
            />
            {no}
          </Box>
        )}

        {rule('rule:agents')}
        {head(
          'plegarAgentes',
          'fold-agents',
          foldA,
          'Agentes',
          <Text dimColor wrap="truncate-end">
            · {count('run')} trabajando · {count('sleep')} esperando · {count('done')} listos
            {count('fail') ? ` · ${count('fail')} fallidos` : ''}
            {stalled ? ` · ${stalled} ¿colgados?` : ''}
          </Text>,
          list.length > 0 ? (
            <Button
              key="clear-all"
              label="Limpiar agentes"
              onPress={() => {
                void update($, bots, () => []).catch(() => {})
              }}
            />
          ) : undefined,
        )}
        {!foldA && list.length === 0 && (
          <Text dimColor>Ningún agente ni comando todavía. Aparecerán aquí en cuanto se lance uno.</Text>
        )}
        {!foldA && live.map(row)}
        {!foldA && finished.length > 0 && (
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Button
              key="agents-ended"
              plain
              label={showE ? `▾ Ocultar ${finished.length} terminados` : `▸ Ver ${finished.length} terminados`}
              onPress={() => {
                void update($, showEnded, v => !v).catch(() => {})
              }}
            />
            {showE && (
              <Button
                key="clear"
                label="Quitar terminados"
                onPress={() => {
                  void update($, bots, l => l.filter(b => !isEnded(b.status))).catch(() => {})
                }}
              />
            )}
          </Box>
        )}
        {!foldA && showE && finished.map(row)}

        {rule('rule:tasks')}
        {head(
          'plegarTareas',
          'fold-tasks',
          foldT,
          'Plan',
          todo.length > 0 ? <Text dimColor wrap="truncate-end">· {done}/{todo.length} hechas · {pct}%</Text> : undefined,
          done > 0 ? (
            <Button
              key="tasks-toggle-done"
              label={hiding ? `👁 Mostrar hechas (${done})` : '🙈 Ocultar hechas'}
              onPress={() => {
                void update($, hideDone, v => !v).catch(() => {})
              }}
            />
          ) : undefined,
        )}
        {!foldT && todo.length === 0 && (
          <Box flexDirection="column">
            <Text bold>Sin tareas todavía</Text>
            <Text dimColor>Aparecerán aquí cuando se arme un plan.</Text>
          </Box>
        )}
        {!foldT && todo.length > 0 && (
          <Box flexDirection="column">
            {Svg ? (
              <Svg source={progressBar(done / todo.length, tmood === 'done')} alt={`${pct} % hecho`} width={220} height={10} />
            ) : (
              <Text color={tmood === 'done' ? '#639922' : '#378ADD'}>{bar(done, todo.length)}</Text>
            )}
            <Text dimColor wrap="truncate-end">
              {`${doing.length} en curso · ${left} pendientes${since === Infinity ? '' : ` · ⏱ ${elapsed(t - since)} desde el inicio`}`}
            </Text>
          </Box>
        )}
        {!foldT &&
          visibleTasks.map(x => {
            const [label, color] = TASK_LABEL[x.status]
            const active = x.status === 'in_progress'
            return (
              <Box key={x.key} flexDirection="row" gap={1} alignItems="center">
                {Svg ? (
                  <Svg source={taskMark(x.status)} alt={label} width={22} height={22} />
                ) : (
                  <Text>{TASK_GLYPH[x.status]}</Text>
                )}
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text bold={active} dimColor={!active} wrap={active ? 'wrap' : 'truncate-end'}>
                    {x.content}
                  </Text>
                  <Text wrap="truncate-end">
                    <Text color={color}>{label}</Text>
                    {x.startedAt !== undefined && <Text dimColor>{' · '}{elapsed((x.endedAt ?? t) - x.startedAt)}</Text>}
                  </Text>
                </Box>
              </Box>
            )
          })}
        {!foldT && hiddenPending > 0 && (
          <Button
            key="tasks-more"
            plain
            label={`+ ${hiddenPending} pendientes más ▾`}
            onPress={() => {
              void update($, allPending, () => true).catch(() => {})
            }}
          />
        )}
        {!foldT && showAll && pendingCount > PENDING_PREVIEW && (
          <Button
            key="tasks-less"
            plain
            label="− Mostrar menos ▴"
            onPress={() => {
              void update($, allPending, () => false).catch(() => {})
            }}
          />
        )}
        {!foldT && todo.length > 0 && (
          <Box flexDirection="row" gap={1} justifyContent="flex-end">
            {done > 0 && (
              <Button
                key="tasks-clear-done"
                label="Quitar hechas"
                onPress={() => {
                  void update($, tasks, l => l.filter(x => x.status !== 'completed')).catch(() => {})
                }}
              />
            )}
            <Button
              key="tasks-clear"
              label="Limpiar tareas"
              onPress={() => {
                void update($, tasks, () => []).catch(() => {})
              }}
            />
          </Box>
        )}

        {ch && (ch.files.length > 0 || ch.untracked > 0) && rule('rule:changes')}
        {ch && (ch.files.length > 0 || ch.untracked > 0) &&
          head(
            'plegarCambios',
            'fold-changes',
            foldC,
            'Cambios',
            <Text dimColor wrap="truncate-end">
              {`· ${ch.files.length} ${ch.files.length === 1 ? 'archivo' : 'archivos'}`}
              {ch.untracked ? ` · ${ch.untracked} sin seguimiento` : ''}
            </Text>,
            <Text>
              <Text color="#6FCF8F">{`+${ch.add}`}</Text> <Text color={HOT[0]}>{`−${ch.del}`}</Text>
            </Text>,
          )}
        {ch && !foldC &&
          ch.files.slice(0, 4).map(f => (
            <Box key={`f:${f.path}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Button
                  key={`file:${f.path}`}
                  plain
                  label={`${dv?.path === f.path ? '▾' : '▸'} ${base(f.path)}`}
                  onPress={() => {
                    if (dv?.path === f.path) {
                      void update($, diffView, () => null).catch(() => {})
                      return
                    }
                    void $.session.cwd()
                      .then(cwd => $.process.run(['git', '-C', cwd, 'diff', 'HEAD', '--', f.path], { timeoutMs: 8000 }))
                      .then(r => {
                        const lines = r.stdout
                          .split('\n')
                          .filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
                          .slice(0, 12)
                        return update($, diffView, () => ({ path: f.path, lines }))
                      })
                      .catch(() => {})
                  }}
                />
                <Text>
                  <Text color="#6FCF8F">{f.add ? `+${f.add}` : ''}</Text>
                  <Text color={HOT[0]}>{f.del ? ` −${f.del}` : ''}</Text>
                </Text>
              </Box>
              {dv?.path === f.path &&
                dv.lines.map((l, i) => (
                  <Text key={`d:${i}`} color={l.startsWith('+') ? '#6FCF8F' : HOT[0]} wrap="truncate-end">
                    {`  ${l}`}
                  </Text>
                ))}
            </Box>
          ))}
        {ch && !foldC && ch.files.length > 4 && <Text dimColor>{`y ${ch.files.length - 4} más`}</Text>}
      </Box>
    )
  })
}
