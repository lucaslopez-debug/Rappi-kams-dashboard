'use client'

// Sección "Tarjetas": todavía en armado. Recibe el KAM activo del filtro del
// header (igual que Markdown) para que el contenido que se sume acá ya quede
// filtrado por KAM desde el arranque.
export default function TarjetasPanel({ kam }) {
  return (
    <div className="table-card fade-in">
      <div className="table-title">💳 Tarjetas</div>
      {kam && (
        <p className="table-subtitle">
          {kam.nombre} - Kam de {kam.region}
        </p>
      )}
      <div className="no-data">
        🚧 Sección en construcción — acá se van a sumar las tareas y datos de Tarjetas.
      </div>
    </div>
  )
}
