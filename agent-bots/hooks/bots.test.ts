import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-bots',
  component: 'Pane',
  requestId: 'agent-bots',
  props: {
    title: 'Agentes',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('un subagente aparece como robot trabajando con su última herramienta', async ($, on) => {
  const clock = mock.clock(on)
  let status: 'running' | 'completed' = 'running'
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('agent.list', async () => ({
    value: [{ id: 'a1', description: 'Auditar módulo de clientes', type: 'general-purpose', status }],
  }))
  on('tool.call', async () => ({ result: 'ok' }))

  await $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'x',
    description: 'Auditar módulo de clientes',
    subagentType: 'general-purpose',
    model: 'sonnet',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  // Simula una llamada hecha dentro del bucle del subagente.
  const fromAgent = { tool: 'Read', file_path: 'C:/reportes/informe.sql', agentId: 'a1' }
  await $.tool.call(fromAgent as Parameters<typeof $.tool.call>[0])
  await clock.advance(5000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Auditar módulo de clientes/ })).toBeDefined()
    expect(await ui.find({ text: /Trabajando/ })).toBeDefined()
    expect(await ui.find({ text: /Leyendo informe\.sql/ })).toBeDefined()
    expect(await ui.find({ text: /Sonnet 5\.5/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }

  status = 'completed'
  await clock.advance(1500)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Listo/ })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(await ui.find({ text: /Ningún agente/ })).toBeDefined()
  await ui.unmount()
})

test('al abrir el panel adopta un agente que ya corría antes de cargarse el mod', async ($, on) => {
  mock.clock(on)
  on('agent.list', async () => ({
    value: [{ id: 'old1', description: 'Resumen de pagos del mes', type: 'general-purpose', status: 'running' }],
  }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))

  const run = { command: 'bots', args: '', origin: 'person', presentation: {} }
  await $.command.run(run as unknown as Parameters<typeof $.command.run>[0])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Resumen de pagos del mes/ })).toBeDefined()
    expect(await ui.find({ text: /Modelo desconocido/ })).toBeDefined()
    expect(await ui.find({ text: /Ya estaba en marcha/ })).toBeDefined()
    await ui.unmount()
  }
})

test('un comando en segundo plano tiene su robot y termina cuando deja de estar en marcha', async ($, on) => {
  mock.clock(on)
  on('tool.call', async () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
  }))
  on('classic.Stop', async () => ({}))

  const call = { tool: 'Bash', command: 'psql -c "run report"', description: 'Ejecuta el reporte', run_in_background: true }
  await $.tool.call(call as Parameters<typeof $.tool.call>[0])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Ejecuta el reporte/ })).toBeDefined()
    expect(await ui.find({ text: /Comando/ })).toBeDefined()
    expect(await ui.find({ text: /psql/ })).toBeDefined()
    expect(await ui.find({ text: /Trabajando/ })).toBeDefined()
    await ui.unmount()
  }

  const stop = { stop_hook_active: false, background_tasks: [] }
  await $.classic.Stop(stop as unknown as Parameters<typeof $.classic.Stop>[0])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Listo/ })).toBeDefined()
  await ui.unmount()
})

test('el aviso de tarea terminada cierra el robot del comando y los botones limpian', async ($, on) => {
  mock.clock(on)
  on('tool.call', async ($, e) => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: e.tool === 'Bash' ? 'b2' : 'b1' },
  }))
  on('prompt.submit', async ($, e) => ({ text: e.text }))

  const first = { tool: 'PowerShell', command: 'msbuild App.sln', description: 'Compila App' }
  const second = { tool: 'Bash', command: 'psql -c "select 1"', description: 'Corre el script' }
  await $.tool.call(first as Parameters<typeof $.tool.call>[0])
  await $.tool.call(second as Parameters<typeof $.tool.call>[0])

  const notice = {
    text: '<task-notification><task-id>b1</task-id><tool-use-id>otro</tool-use-id><status>completed</status></task-notification>',
    origin: { kind: 'task-notification' },
    wait: false,
  }
  await $.prompt.submit(notice as unknown as Parameters<typeof $.prompt.submit>[0])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /1 trabajando · 0 esperando · 1 listos/ })).toBeDefined()
  await ui.press({ key: 'x:shell:b2' })
  expect(await ui.find({ text: /Corre el script/ })).toBeUndefined()
  expect(await ui.find({ text: /Compila App/ })).toBeDefined()
  await ui.press({ key: 'clear-all' })
  expect(await ui.find({ text: /Ningún agente/ })).toBeDefined()
  await ui.unmount()
})

test('un plan de la app se ve y avanza con advance, done y start', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', async () => ({ result: 'ok' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const call = (x: Record<string, unknown>) => $.tool.call(x as unknown as Parameters<typeof $.tool.call>[0])

  await call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Escribir mod', status: 'in_progress' },
      { content: 'Validar', status: 'pending' },
      { content: 'Instalar', status: 'pending' },
    ],
  })
  await clock.advance(5000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /0\/3 hechas/ })).toBeDefined()
    expect(await ui.find({ text: /Escribir mod/ })).toBeDefined()
    expect(await ui.find({ text: /En curso/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }

  await call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /1\/3 hechas/ })).toBeDefined()
  expect(await ui.find({ text: /1 en curso · 1 pendientes/ })).toBeDefined()
  await ui.unmount()

  await call({ tool: 'mcp__ccd_turn__update_plan', done: [2], start: 3 })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /2\/3 hechas/ })).toBeDefined()
  await ui.unmount()

  await call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'listo' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /3\/3 hechas · 100%/ })).toBeDefined()
  await ui.unmount()
})

test('un plan nuevo conserva los tiempos y las llamadas de un subagente no cuentan', async ($, on) => {
  mock.clock(on)
  on('tool.call', async () => ({ result: 'ok' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const call = (x: Record<string, unknown>) => $.tool.call(x as unknown as Parameters<typeof $.tool.call>[0])

  await call({ tool: 'TodoWrite', todos: [{ content: 'Paso A', status: 'in_progress', activeForm: 'Haciendo A' }] })
  await call({ tool: 'TodoWrite', agentId: 'a1', todos: [{ content: 'Del subagente', status: 'pending', activeForm: 'x' }] })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Paso A/ })).toBeDefined()
  expect(await ui.find({ text: /Del subagente/ })).toBeUndefined()
  await ui.unmount()
})

test('TaskCreate y TaskUpdate arman la lista por id y los botones limpian', async ($, on) => {
  mock.clock(on)
  let n = 0
  on('tool.call', async () => ({ result: { task: { id: String(++n), subject: 's' } } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const call = (x: Record<string, unknown>) => $.tool.call(x as unknown as Parameters<typeof $.tool.call>[0])

  await call({ tool: 'TaskCreate', subject: 'Primera', description: 'd' })
  await call({ tool: 'TaskCreate', subject: 'Segunda', description: 'd' })
  await call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' })

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /1\/1 hechas/ })).toBeDefined()
  expect(await ui.find({ text: /Segunda/ })).toBeUndefined()
  await ui.press({ key: 'tasks-clear-done' })
  expect(await ui.find({ text: /Sin tareas/ })).toBeDefined()
  await ui.unmount()
})

test('la herramienta propia arma la lista y avanza, y avisa al modelo del resultado', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const call = (x: Record<string, unknown>) => $.tool.call(x as unknown as Parameters<typeof $.tool.call>[0])

  const first = await call({
    tool: 'mcp__agent-bots__tareas',
    items: [
      { content: 'Paso uno', status: 'in_progress' },
      { content: 'Paso dos', status: 'pending' },
    ],
  })
  expect(first.result).toMatch(/0\/2 hechas; en curso: Paso uno/)
  const second = await call({ tool: 'mcp__agent-bots__tareas', advance: true })
  expect(second.result).toMatch(/1\/2 hechas; en curso: Paso dos/)
  expect((await call({ tool: 'mcp__agent-bots__tareas' })).result).toMatch(/Indica/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /1\/2 hechas/ })).toBeDefined()
  expect(await ui.find({ text: /Paso dos/ })).toBeDefined()
  await ui.unmount()
})

test('el prompt ofrece la herramienta propia solo si la sesión no trae otra de tareas', async ($, on) => {
  mock.clock(on)
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  const ids = async (tools: string[]) =>
    (await $.prompt.compose({ tools, model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: [], outputStyle: null, traits: [] })).sections.map(s => s.id)

  expect(await ids(['Read', 'Bash'])).toContain('agent-bots:tareas')
  expect(await ids(['Read', 'mcp__ccd_turn__update_plan'])).not.toContain('agent-bots:tareas')
  expect(await ids(['TodoWrite'])).not.toContain('agent-bots:tareas')
})

test('la cuota de 5 h y semana se dibuja con su reinicio y avisa al cruzar el 90 %', async ($, on) => {
  const clock = mock.clock(on)
  const t0 = clock.now()
  const iso = (ms: number) => new Date(t0 + ms).toISOString()
  on('session.usage', async () => ({
    value: {
      startedAt: t0,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: iso(2 * 3600e3 + 14 * 60e3) },
        { kind: 'seven_day', percentUsed: 31, resetsAt: iso(3 * 86400e3 + 4 * 3600e3) },
      ],
    },
  }))
  let toast = ''
  on('ui.toast', async ($, e) => {
    toast = String((e as unknown as { text?: string }).text ?? e)
    return { value: undefined }
  })
  on('command.register', async () => ({ value: undefined }))
  on('tool.register', async () => ({ value: undefined }))
  on('agent.list', async () => ({ value: [] }))
  on('session.start', async () => ({ cwd: 'C:/x' }))
  on('session.measure', async ($, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: 'C:/x' } as unknown as Parameters<typeof $.session.start>[0])
  await clock.advance(10)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Semana/ })).toBeDefined()
    expect(await ui.find({ text: /2h 14m/ })).toBeDefined()
    expect(await ui.find({ text: /3d 4h/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }

  const measure = {
    context: { window: 200000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 91, resetsAt: iso(3600e3) },
      { kind: 'seven_day', percentUsed: 33, resetsAt: iso(3 * 86400e3) },
    ],
    changed: ['rateLimits'],
  }
  await $.session.measure(measure as unknown as Parameters<typeof $.session.measure>[0])
  expect(toast).toMatch(/5 h al 91/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /1h 00m/ })).toBeDefined()
  expect(await ui.find({ text: /Contexto/ })).toBeUndefined()
  await ui.unmount()
})

test('al cargarse a mitad de un plan rehace la lista desde el historial, una sola vez', async ($, on) => {
  mock.clock(on)
  const plan = (input: Record<string, unknown>, isError?: true) => ({
    role: 'assistant', text: '',
    toolUses: [{ tool_use_id: 'u', tool: 'mcp__ccd_turn__update_plan', input, text: 'ok', ...(isError ? { isError } : {}) }],
  })
  on('session.messages', async () => ({
    value: [
      { role: 'user', text: 'hazlo', toolUses: [] },
      plan({ items: [{ content: 'Uno', status: 'in_progress' }, { content: 'Dos', status: 'pending' }, { content: 'Tres', status: 'pending' }] }),
      plan({ advance: true }),
      plan({ advance: true }, true),
    ],
  }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: [] } }))
  on('command.register', async () => ({ value: undefined }))
  on('tool.register', async () => ({ value: undefined }))
  on('agent.list', async () => ({ value: [] }))
  on('session.start', async () => ({ cwd: 'C:/x' }))
  await $.session.start({ cwd: 'C:/x' } as unknown as Parameters<typeof $.session.start>[0])

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /1\/3 hechas/ })).toBeDefined()
  expect(await ui.find({ text: /1 en curso · 1 pendientes/ })).toBeDefined()
  await ui.press({ key: 'tasks-clear' })
  await ui.unmount()

  // Una recarga del mod no resucita la lista que se limpió.
  await $.session.start({ cwd: 'C:/x' } as unknown as Parameters<typeof $.session.start>[0])
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Sin tareas todavía/ })).toBeDefined()
  await ui.unmount()
})

test('el panel de escritorio muestra la caché de la última petición', async ($, on) => {
  const clock = mock.clock(on)
  const usage = { model: 'claude-sonnet-5-5', input_tokens: 500, cache_read_input_tokens: 90000, cache_creation_input_tokens: 9500, output_tokens: 10 }
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('session.usage', async () => ({
    value: {
      startedAt: clock.now(),
      context: { window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(clock.now() + 3600e3).toISOString() }],
    },
  }))
  on('command.register', async () => ({ value: undefined }))
  on('tool.register', async () => ({ value: undefined }))
  on('agent.list', async () => ({ value: [] }))
  on('session.start', async () => ({ cwd: 'C:/x' }))
  await $.session.start({ cwd: 'C:/x' } as unknown as Parameters<typeof $.session.start>[0])
  await clock.advance(10)

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5' } as unknown as Parameters<typeof $.turn.step>[0])
  for await (const _chunk of stream) void _chunk

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /^Caché$/ })).toBeDefined()
  expect(await ui.find({ text: /60 min de 1 h/ })).toBeDefined()
  expect(await ui.find({ text: /leído 90k · escrito 9\.5k/ })).toBeDefined()
  await ui.unmount()

})
