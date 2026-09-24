'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import KamDashboard from '@/components/KamDashboard'
import TarjetasPanel from '@/components/TarjetasPanel'
import DashboardSkeleton from '@/components/DashboardSkeleton'
import SplashScreen from '@/components/SplashScreen'
import { supabase } from '@/lib/supabase'

// Cada cuánto vuelve a pedirle los datos a Supabase para reflejar lo último
// que haya traído el sync del Sheet, sin que haga falta recargar la página.
const REFRESH_INTERVAL_MS = 60 * 1000

// Secciones (sub-pestañas) disponibles una vez elegido el KAM. Cada tema que
// se migre a la app suma su propia sección acá.
const SECTIONS = [
  { id: 'markdown', label: '📉 Markdown' },
  { id: 'tarjetas', label: '💳 Tarjetas' },
]

export default function Home() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeKam, setActiveKam] = useState(0)
  const [activeSection, setActiveSection] = useState('markdown')

  // El filtro de KAM se porta (React portal) a la segunda fila del header
  // (ver app/layout.js) — el nodo recién existe después de montar.
  const [kamTabsHost, setKamTabsHost] = useState(null)
  useEffect(() => {
    setKamTabsHost(document.getElementById('header-kam-tabs'))
  }, [])

  useEffect(() => {
    let cancelled = false

    const fetchData = async () => {
      try {
        const { data: kams, error: kamsError } = await supabase
          .from('kams')
          .select('*')
          .order('nombre')

        if (kamsError) throw kamsError

        // Supabase limita cada respuesta a un máximo fijo de filas (1000) sin
        // importar el tamaño del range pedido, así que hay que paginar en un
        // loop hasta que una página vuelva incompleta en vez de usar rangos fijos
        // (con rangos fijos se pierden semanas enteras si la tabla crece).
        const PAGE_SIZE = 1000
        const weeklyData = []
        let from = 0

        while (true) {
          const { data: page, error: pageError } = await supabase
            .from('weekly_data')
            .select('*')
            .order('semana_fecha')
            .range(from, from + PAGE_SIZE - 1)

          if (pageError) throw pageError

          weeklyData.push(...(page || []))

          if (!page || page.length < PAGE_SIZE) break
          from += PAGE_SIZE
        }

        if (cancelled) return
        setData({ kams, weeklyData })
        setError(null)
      } catch (err) {
        console.error('❌ Error:', err)
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, REFRESH_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  let body
  if (loading) {
    body = <DashboardSkeleton />
  } else if (error) {
    body = <div className="error fade-in">❌ Error: {error}</div>
  } else if (!data || !data.kams) {
    body = <div className="no-data fade-in">📭 Sin datos disponibles</div>
  } else {
    const kam = data.kams[activeKam]
    body = (
      <main style={{ minHeight: '100vh' }}>
        {kamTabsHost && createPortal(
          <div className="header-kam-list">
            {data.kams.map((k, idx) => (
              <button
                key={k.id}
                type="button"
                onClick={() => setActiveKam(idx)}
                className={`header-kam-tab ${activeKam === idx ? 'active' : ''}`}
              >
                {k.nombre}
              </button>
            ))}
          </div>,
          kamTabsHost
        )}
        <div className="container slide-in">
          <div className="section-tabs fade-in">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={`section-tab ${activeSection === section.id ? 'active' : ''}`}
              >
                {section.label}
              </button>
            ))}
          </div>

          {activeSection === 'markdown' && (
            <KamDashboard data={data} activeKam={activeKam} onSelectKam={setActiveKam} />
          )}
          {activeSection === 'tarjetas' && <TarjetasPanel kam={kam} />}
        </div>
      </main>
    )
  }

  return (
    <>
      <SplashScreen />
      {body}
    </>
  )
}