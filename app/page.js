'use client'

import { useEffect, useState } from 'react'
import KamDashboard from '@/components/KamDashboard'
import DashboardSkeleton from '@/components/DashboardSkeleton'
import SplashScreen from '@/components/SplashScreen'
import { supabase } from '@/lib/supabase'

// Cada cuánto vuelve a pedirle los datos a Supabase para reflejar lo último
// que haya traído el sync del Sheet, sin que haga falta recargar la página.
const REFRESH_INTERVAL_MS = 60 * 1000

export default function Home() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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
    body = (
      <main style={{ minHeight: '100vh' }}>
        <div className="container slide-in">
          <KamDashboard data={data} />
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