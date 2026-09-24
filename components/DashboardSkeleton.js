// Esqueleto de carga: reutiliza las mismas clases de layout que el dashboard
// real (tabs-wrapper, table-card, trend-columns, minuta-card) para que el
// tamaño y la posición de cada bloque no salten cuando llegan los datos reales
// y los reemplazan — solo cambia el contenido de adentro.
function Bone({ width, height, radius = 6, style }) {
  return (
    <div
      className="skeleton-bone"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  )
}

export default function DashboardSkeleton() {
  return (
    <div className="container">
      <div className="tabs-wrapper fade-in">
        <div className="tabs" style={{ padding: '18px 24px', gap: 24 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Bone key={i} width={100 + (i % 3) * 15} height={18} />
          ))}
        </div>
      </div>

      <div className="table-card fade-in">
        <Bone width={220} height={20} style={{ marginBottom: 14 }} />
        <Bone width="85%" height={13} style={{ marginBottom: 6 }} />
        <Bone width="60%" height={13} style={{ marginBottom: 20 }} />
        <div className="md-target-layout">
          <Bone width={140} height={140} radius={999} />
          <div className="md-target-stats">
            {Array.from({ length: 3 }).map((_, i) => (
              <Bone key={i} height={78} radius={10} style={{ flex: '1 1 150px' }} />
            ))}
          </div>
        </div>
      </div>

      <div className="trend-columns fade-in">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="trend-col">
            <Bone width="80%" height={13} style={{ margin: '0 auto 6px' }} />
            <Bone width="95%" height={13} style={{ margin: '0 auto 12px' }} />
            <Bone height={158} radius={12} />
          </div>
        ))}
      </div>

      <div className="minuta-card fade-in">
        <Bone width={160} height={18} style={{ marginBottom: 18 }} />
        <div className="minuta-stats">
          {Array.from({ length: 3 }).map((_, i) => (
            <Bone key={i} height={72} radius={10} style={{ flex: '1 1 160px' }} />
          ))}
        </div>
        <Bone width="100%" height={13} style={{ marginTop: 18 }} />
      </div>

      <div className="subtabs-wrapper fade-in">
        <Bone width={150} height={38} radius={10} />
        <Bone width={110} height={38} radius={10} />
        <Bone width={130} height={38} radius={10} />
      </div>

      <div className="table-card fade-in">
        <Bone width={200} height={20} style={{ marginBottom: 20 }} />
        {Array.from({ length: 6 }).map((_, i) => (
          <Bone key={i} width="100%" height={30} style={{ marginBottom: 10 }} />
        ))}
      </div>
    </div>
  )
}
