export type BotMood = 'run' | 'sleep' | 'done' | 'fail'

export type BotKind = 'agent' | 'shell'

export type Bot = {
  key: string
  kind?: BotKind
  taskId?: string
  toolUseId?: string
  id?: string
  description: string
  type: string
  model: string
  status: string
  startedAt: number
  endedAt?: number
  action: string
  calls: number
  // Lanzado en segundo plano: al terminar avisa con una notificación.
  background?: boolean
  // Última señal de vida (lanzamiento o herramienta usada), para detectar los colgados.
  lastSeen?: number
  // Ya se avisó de su fin.
  told?: boolean
}

// Una copia cargada del mod y su último latido.
export type Copy = { id: string; at: number }

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  key: string
  // Id que el motor le dio con TaskCreate; las tareas de un plan no lo tienen.
  ref?: string
  content: string
  status: TaskStatus
  startedAt?: number
  endedAt?: number
}

// Una ventana de cuota de la cuenta (5 h o semana) con la lectura anterior, para animar el cambio.
export type Limit = {
  kind: string
  percentUsed: number
  prevPercent: number
  resetsAt?: string
}

export type Ttl = '5m' | '1h'

// Una petición del hilo principal, como la reportó la API: de ella sale el estado de la caché de prompts.
export type Muestra = {
  modelo: string
  // ms desde la época al empezar la petición: la vida de la caché cuenta desde aquí
  inicio: number
  leido: number
  escrito: number
  nuevo: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-bots': {
      bots: Bot[]
      tasks: Task[]
      limits: Limit[]
      replayed: boolean
      now: number
      muestras: Muestra[]
      ttl: Ttl
      copias: Copy[]
      duplicado: boolean
      ocultarHechas: boolean
    }
  }
}
