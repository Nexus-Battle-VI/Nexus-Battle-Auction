/**
 * Puerto de reloj. Aisla el paso del tiempo para que el dominio y los casos de
 * uso sean deterministas y verificables sin falsear temporizadores globales.
 */
export interface ClockPort {
  now(): Date
}

export const CLOCK = Symbol('ClockPort')
