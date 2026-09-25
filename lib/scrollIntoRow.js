// Centra el elemento activo (.active) dentro de una fila con scroll horizontal
// (KAMs del header, sub-pestañas), sin mover el scroll vertical de la página
// — scrollIntoView() también scrollearía la página hasta la fila.
export function scrollActiveIntoRow(row) {
  if (!row || row.scrollWidth <= row.clientWidth) return
  const active = row.querySelector('.active')
  if (!active) return
  const left = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2
  row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
}
