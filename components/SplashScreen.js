'use client'

import { useEffect, useRef, useState } from 'react'

// Mismo logo que usa el header (app/layout.js) — así el logo grande "es" el
// mismo logo chico, no una imagen distinta que simplemente se le parece.
// Es una imagen pesada (2823x2189), servida localmente desde /public y
// precargada desde el <head> del layout.
const RAPPI_LOGO_URL = '/rappi-logo.webp'

const HOLD_MS = 900
const DOCK_MS = 700
// Si por conexión lenta la imagen tarda más que esto en cargar, seguimos
// igual — mejor una animación sin el logo grande que una pantalla negra
// colgada indefinidamente.
const MAX_WAIT_FOR_LOAD_MS = 2500

export default function SplashScreen() {
  // 'loading' (esperando la imagen) -> 'hold' (logo grande quieto) ->
  // 'dock' (achicando hacia el header) -> 'done' (removido)
  const [phase, setPhase] = useState('loading')
  const [dockTransform, setDockTransform] = useState('')
  const logoRef = useRef(null)
  const advancedRef = useRef(false)

  // Fase 1: esperar a que el logo esté realmente pintable antes de arrancar
  // a contar el "hold" — si arrancamos con un timer fijo desde el mount, en
  // una conexión lenta la cuenta corre mientras la pantalla sigue en negro.
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setPhase('done')
      return
    }

    const advanceToHold = () => {
      if (advancedRef.current) return
      advancedRef.current = true
      setPhase('hold')
    }

    // Si el navegador ya tenía la imagen cacheada/precargada, "complete" puede
    // ser true antes de que este efecto corra, y el evento onLoad del <img>
    // nunca llegaría a dispararse.
    if (logoRef.current?.complete && logoRef.current.naturalWidth > 0) {
      advanceToHold()
    }

    const fallbackTimer = setTimeout(advanceToHold, MAX_WAIT_FOR_LOAD_MS)
    return () => clearTimeout(fallbackTimer)
  }, [])

  // Fase 2: sostener el logo grande centrado por HOLD_MS y despué calcular
  // hacia dónde "encastrar" en base a la posición real del logo del header
  useEffect(() => {
    if (phase !== 'hold') return

    const holdTimer = setTimeout(() => {
      const target = document.querySelector('.header-logo')
      const logoEl = logoRef.current
      if (target && logoEl) {
        const t = target.getBoundingClientRect()
        const l = logoEl.getBoundingClientRect()
        const dx = (t.left + t.width / 2) - (l.left + l.width / 2)
        const dy = (t.top + t.height / 2) - (l.top + l.height / 2)
        const scale = t.width / l.width
        setDockTransform(`translate(${dx}px, ${dy}px) scale(${scale})`)
      } else {
        setDockTransform('scale(0.15)')
      }
      setPhase('dock')
    }, HOLD_MS)

    return () => clearTimeout(holdTimer)
  }, [phase])

  // Fase 3: al terminar la transición de achique, sacar el splash del todo
  useEffect(() => {
    if (phase !== 'dock') return
    const doneTimer = setTimeout(() => setPhase('done'), DOCK_MS)
    return () => clearTimeout(doneTimer)
  }, [phase])

  if (phase === 'done') return null

  return (
    <div
      className={`splash-overlay ${phase === 'dock' ? 'splash-overlay-fade' : ''}`}
      style={{ transitionDuration: `${DOCK_MS}ms` }}
      aria-hidden="true"
    >
      <img
        ref={logoRef}
        src={RAPPI_LOGO_URL}
        alt=""
        className="splash-logo"
        fetchPriority="high"
        onLoad={() => {
          if (!advancedRef.current) {
            advancedRef.current = true
            setPhase('hold')
          }
        }}
        onError={() => setPhase('done')}
        style={{
          visibility: phase === 'loading' ? 'hidden' : 'visible',
          transform: phase === 'dock' ? dockTransform : 'scale(1)',
          transitionDuration: `${DOCK_MS}ms`,
        }}
      />
    </div>
  )
}
