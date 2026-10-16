export type Ventana = { kind: string; percentUsed: number; resetsAt?: string }

export type Medida = {
  startedAt: number
  tokens?: number
  window: number
  percent?: number
  limites: Ventana[]
  usd?: number
}

export type Modo = 'completo' | 'compacto' | 'oculto'

export type Ttl = '5m' | '1h'

/** Una petición del hilo principal, como la reportó la API. */
export type Muestra = {
  modelo: string
  /** ms desde la época al empezar la petición: la vida de la caché cuenta desde aquí */
  inicio: number
  leido: number
  escrito: number
  nuevo: number
}

declare module 'claude-code' {
  interface PluginState {
    medidor: {
      medida: Medida | null
      modelo: string
      esfuerzo: string | null
      ahora: number
      modo: Modo
      avisado: number
      muestras: Muestra[]
      ttl: Ttl
      ttlFuente: string
    }
  }
}
