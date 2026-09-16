/**
 * Describe un error de origen desconocido sin producir `[object Object]`.
 *
 * Existe porque muchas bibliotecas devuelven o rechazan con `unknown`, y pasar
 * eso por `String()` a secas convierte cualquier objeto en texto inutil justo
 * cuando mas falta hace saber que ocurrio.
 *
 * Vive con la observabilidad y no con la persistencia: no tiene nada de
 * especifico de una base de datos, y ponerlo alli lo dejaba fuera del alcance
 * de las pruebas que no necesitan contenedor.
 */
export const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  // `JSON.stringify` declara devolver `string`, pero con `undefined` devuelve
  // `undefined` en ejecucion. Se atiende el caso antes en lugar de confiar en
  // el tipo, que aqui miente.
  if (error === undefined || error === null) {
    return String(error)
  }

  try {
    return JSON.stringify(error)
  } catch {
    return 'error no serializable'
  }
}
