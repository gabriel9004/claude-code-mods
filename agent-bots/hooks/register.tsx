import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { Bot, BotKind, BotMood, Limit, Muestra, Task, TaskStatus } from '../types'
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

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
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
    void $.clock.now().then(t => update($, now, () => t)).catch(() => {})
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
  await update($, now, () => t)
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
  await update($, now, () => t)
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

// Latido de esta copia; si otra copia late a la vez, el panel lo avisa.
function startBeat($: EngineInterface) {
  if (beat) return
  const pulse = async () => {
    const t = await $.clock.now()
    let alive = 0
    await update($, copies, l => {
      const next = [...l.filter(c => c.id !== INSTANCE && t - c.at < ALIVE_MS), { id: INSTANCE, at: t }]
      alive = next.length
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

// Une la lista viva del motor con lo que guardamos al lanzar cada agente.
async function sync($: EngineInterface): Promise<boolean> {
  const infos: AgentInfo[] = await $.agent.list()
  const t = await $.clock.now()
  let active = false
  await update($, bots, list => {
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
    active = next.some(b => !isEnded(b.status))
    return trim(next)
  })
  await update($, now, () => t)
  await tellEnds($).catch(() => {})
  return active
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    ticker = undefined
    quotaClock = undefined
    beat = undefined
    // Una copia que arranca borra los latidos viejos: tras una recarga, la copia anterior ya no está.
    await update($, copies, () => []).catch(() => {})
    startBeat($)
    await quietEnded($).catch(() => {})
    // La cuota se lee al arrancar; después llega sola con cada medición.
    await $.session.usage().then(u => readLimits($, u.rateLimits)).catch(() => {})
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

    return { text: 'Panel de agentes y tareas abierto.' }
  })

  on('command.run', { command: 'tareas' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await sync($)

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
            ? { ...b, action: text, calls: b.calls + 1, lastSeen: seen, status: isEnded(b.status) ? b.status : 'running' }
            : b,
        ),
      ).catch(() => {})
    }

    const ran = await next(e)

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
        await update($, now, () => inicio)
      }
    } catch {}
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await readLimits($, e.rateLimits).catch(() => {})
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
    const list = await read($, bots)
    const t = (await read($, now)) || (await $.clock.now())

    const order: Record<BotMood, number> = { run: 0, sleep: 1, fail: 2, done: 3 }
    const shown = [...list].sort(
      (a, b) => order[mood(a.status)] - order[mood(b.status)] || b.startedAt - a.startedAt,
    )
    const count = (m: BotMood) => list.filter(b => mood(b.status) === m).length
    const ended = list.some(b => isEnded(b.status))

    const todo = await read($, tasks)
    const done = todo.filter(x => x.status === 'completed').length
    const doing = todo.filter(x => x.status === 'in_progress')
    const left = todo.length - done - doing.length
    const tmood: BotMood = doing.length ? 'run' : todo.length && done === todo.length ? 'done' : 'sleep'
    const since = todo.reduce((min, x) => (x.startedAt !== undefined && x.startedAt < min ? x.startedAt : min), Infinity)
    const pct = todo.length ? Math.round((done / todo.length) * 100) : 0

    const quota = await read($, limits)
    const clock = await $.clock.now()

    // Caché de prompts: acierto de la última petición y cuánto le queda de vida (por minutos, para no distraer).
    const recent = await read($, samples)
    const last = recent[recent.length - 1]
    const ttl = await read($, cacheTtl)
    const left_ms = last ? restanteMs(last, ttl, clock) : 0
    const hit = last ? Math.round(aciertos(last) * 100) : undefined
    const cacheRamp: [string, string] = left_ms > 0 ? ['#5DCAA5', '#1D9E75'] : ['#B4B2A9', '#888780']
    const cacheLife = !last
      ? 'sin peticiones'
      : last.leido + last.escrito === 0
        ? 'sin caché'
        : left_ms > 0
          ? `⏱ ${left_ms < 60000 ? '<1 min' : `${Math.ceil(left_ms / 60000)} min`}`
          : 'vencida'
    // Corto a propósito: un texto más ancho que los de 5 h y semana ensancha la columna y agranda el anillo.
    const cacheDetail = last ? `${tokens(last.leido)} leído` : ''

    // Un robot que dice trabajar pero lleva demasiado sin dar señales.
    const silentFor = (b: Bot) => t - (b.lastSeen ?? b.startedAt)
    const isStalled = (b: Bot) =>
      mood(b.status) === 'run' && silentFor(b) > (b.kind === 'shell' ? STALL_SHELL_MS : STALL_AGENT_MS)
    const stalled = list.filter(isStalled).length
    const twice = await read($, duplicated)

    return (
      <Box flexDirection="column" gap={1}>
        {twice && (
          <Text color={WARN[1]} wrap="wrap">
            ⚠ agent-bots está cargado dos veces (p. ej. una copia en dev-mods y la instalada): los conteos salen dobles. Quita una y recarga.
          </Text>
        )}
        {(quota.length > 0 || last) && (
          <Box flexDirection="row" gap={2} justifyContent="space-around" alignItems="flex-start">
            {QUOTA.map(({ kind, label, ramp }) => {
              const l = quota.find(x => x.kind === kind)
              if (!l) return null
              const reset = resetIn(l.resetsAt, clock)
              const hot = l.percentUsed >= 90 ? HOT[1] : l.percentUsed >= 70 ? WARN[1] : undefined
              return (
                <Box key={`q:${kind}`} flexDirection={Svg ? 'column' : 'row'} alignItems="center" gap={Svg ? 0 : 1}>
                  {Svg ? (
                    <Svg source={gauge(l.percentUsed, ramp, kind)} alt={`Cuota ${label}: ${Math.round(l.percentUsed)} %`} width={72} height={72} />
                  ) : (
                    <Text color={hot ?? ramp[1]}>{`${label.padEnd(6)} ${bar10(l.percentUsed)} ${Math.round(l.percentUsed)}%`}</Text>
                  )}
                  {Svg && <Text bold>{label}</Text>}
                  {reset && <Text dimColor>{Svg ? `↻ ${reset}` : `· ↻ ${reset}`}</Text>}
                </Box>
              )
            })}
            {last && (
              <Box key="q:cache" flexDirection={Svg ? 'column' : 'row'} alignItems="center" gap={Svg ? 0 : 1}>
                {Svg ? (
                  <Svg source={gauge(hit ?? 0, cacheRamp, 'cache', false)} alt={`Caché: ${hit ?? 0} % de aciertos`} width={72} height={72} />
                ) : (
                  <Text color={cacheRamp[1]}>{`${'Caché'.padEnd(6)} ${bar10(hit ?? 0)} ${hit ?? 0}%`}</Text>
                )}
                {Svg && <Text bold>Caché</Text>}
                <Text dimColor>{Svg ? cacheLife : `· ${cacheLife}`}</Text>
                {Svg && cacheDetail && <Text dimColor>{cacheDetail}</Text>}
              </Box>
            )}
          </Box>
        )}
        <Text dimColor>
          {count('run')} trabajando · {count('sleep')} esperando · {count('done')} listos
          {count('fail') ? ` · ${count('fail')} fallidos` : ''}
          {stalled ? ` · ${stalled} ¿colgados?` : ''}
        </Text>
        {list.length === 0 && (
          <Text dimColor>Ningún agente ni comando todavía. Aparecerán aquí en cuanto se lance uno.</Text>
        )}
        {shown.map(b => {
          const hung = isStalled(b)
          // Colgado: se dibuja dormido y en ámbar, con cuánto lleva callado.
          const m = hung ? 'sleep' : mood(b.status)
          const [label, color] = hung ? ['¿Colgado?', WARN[1]] : LABEL[m]
          const shell = b.kind === 'shell'
          const who = shell ? 'Comando' : b.model ? modelName(b.model) : 'Modelo desconocido'
          return (
            <Box key={b.key} flexDirection="row" gap={1} alignItems="center">
              {Svg ? (
                <Svg source={robot(m, b.model, b.kind)} alt={`Robot ${label.toLowerCase()}`} width={56} height={56} isInteractive />
              ) : (
                <Text>{shell && m === 'run' ? '⚙️' : GLYPH[m]}</Text>
              )}
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text bold wrap="truncate-end">{b.description}</Text>
                  <Button
                    key={`x:${b.key}`}
                    plain
                    label="✕"
                    onPress={() => {
                      void update($, bots, l => l.filter(one => one.key !== b.key)).catch(() => {})
                    }}
                  />
                </Box>
                <Text wrap="truncate-end">
                  <Text color={color}>{label}</Text>
                  <Text dimColor>
                    {' · '}{who} · {elapsed((b.endedAt ?? t) - b.startedAt)}{shell ? '' : ` · ${b.calls} herramientas`}
                  </Text>
                </Text>
                <Text wrap="truncate-end" dimColor={m !== 'run'}>
                  {hung
                    ? `Sin señales hace ${elapsed(silentFor(b))} · ✕ para quitarlo`
                    : m === 'done' ? '✓ Terminado' : m === 'sleep' && b.calls === 0 ? 'zzz… esperando' : b.action}
                </Text>
              </Box>
            </Box>
          )
        })}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text dimColor>
            <Text color={RAMP.opus[1]}>●</Text> Opus <Text color={RAMP.sonnet[1]}>●</Text> Sonnet{' '}
            <Text color={RAMP.haiku[1]}>●</Text> Haiku <Text color={SHELL[1]}>●</Text> Comando
          </Text>
        </Box>
        {list.length > 0 && (
          <Box flexDirection="row" gap={1} justifyContent="flex-end">
            {ended && (
              <Button
                key="clear"
                label="Quitar terminados"
                onPress={() => {
                  void update($, bots, l => l.filter(b => !isEnded(b.status))).catch(() => {})
                }}
              />
            )}
            <Button
              key="clear-all"
              label="Limpiar todo"
              onPress={() => {
                void update($, bots, () => []).catch(() => {})
              }}
            />
          </Box>
        )}
        <Text dimColor>Tareas</Text>
        <Box flexDirection="row" gap={1} alignItems="center">
          {Svg ? (
            <Svg source={robot(tmood, 'sonnet')} alt={`Robot ${LABEL[tmood][0].toLowerCase()}`} width={52} height={52} isInteractive />
          ) : (
            <Text>{GLYPH[tmood]}</Text>
          )}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text bold wrap="truncate-end">
              {todo.length === 0 ? 'Sin tareas todavía' : `${done}/${todo.length} hechas · ${pct}%`}
            </Text>
            {todo.length > 0 && <Text color={tmood === 'done' ? '#639922' : '#378ADD'}>{bar(done, todo.length)}</Text>}
            <Text dimColor wrap="truncate-end">
              {todo.length === 0
                ? 'Aparecerán aquí cuando se arme un plan.'
                : `${doing.length} en curso · ${left} pendientes${since === Infinity ? '' : ` · ${elapsed(t - since)}`}`}
            </Text>
          </Box>
        </Box>
        {todo.map(x => {
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
                <Text bold={active} dimColor={!active} wrap="truncate-end">
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
        {todo.length > 0 && (
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
      </Box>
    )
  })
}
