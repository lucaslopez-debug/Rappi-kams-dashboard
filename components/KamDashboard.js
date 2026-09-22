'use client'

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { BarChart, Bar, XAxis, YAxis, LabelList, ResponsiveContainer } from 'recharts'
import { Poppins } from 'next/font/google'
import { toPng, toJpeg } from 'html-to-image'
import AccionablesPanel from '@/components/AccionablesPanel'
import { supabase } from '@/lib/supabase'

const poppins = Poppins({ subsets: ['latin'], weight: ['700', '800'] })

// El sheet es una ventana rotativa de "últimas 8 semanas cerradas": cada semana
// entra una fecha nueva y sale la más vieja. En vez de mantener una lista fija de
// fechas (que se desactualiza cada vez que el sheet rota), parseamos el label
// "DD Mon" (ej. "22 Jun") a un valor ordenable y comparamos cronológicamente.
const MONTHS = { Ene: 0, Jan: 0, Feb: 1, Mar: 2, Abr: 3, Apr: 3, May: 4, Jun: 5, Jul: 6, Ago: 7, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dic: 11, Dec: 11 }

function parseWeekLabel(label) {
  const match = label?.trim().match(/^(\d{1,2})\s+([A-Za-zÁ-ú]{3})/)
  if (!match) return null
  const month = MONTHS[match[2]]
  if (month === undefined) return null
  return month * 100 + parseInt(match[1], 10)
}

function compareWeekLabels(a, b) {
  const va = parseWeekLabel(a)
  const vb = parseWeekLabel(b)
  if (va === null && vb === null) return 0
  if (va === null) return 1
  if (vb === null) return -1
  return va - vb
}

// Labels custom de los gráficos 8LW (orders y markdown): el % de crecimiento
// (chico, arriba) y el valor de la semana (debajo del %, pegado a la barra)
function OrdersLabel({ x, y, width, value }) {
  if (value === undefined || value === null) return null
  return (
    <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={8} fontWeight={700} fill="#FFFFFF">
      {Number(value).toLocaleString()}
    </text>
  )
}

function MarkdownLabel({ x, y, width, value }) {
  if (value === undefined || value === null) return null
  return (
    <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={8} fontWeight={700} fill="#FFFFFF">
      {`${value.toFixed(1)}%`}
    </text>
  )
}

function TrafficLabel({ x, y, width, value }) {
  if (value === undefined || value === null) return null
  return (
    <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={8} fontWeight={700} fill="#FFFFFF">
      {Number(value).toLocaleString()}
    </text>
  )
}

// Lectura rápida de por qué se movió el markdown de una brand, cruzando su
// variación de markdown contra su variación de orders vs. LW (y la base de
// órdenes, para no sacar conclusiones de volúmenes muy chicos)
const LOW_BASE_ORDERS = 5

// Estado comercial de cada aliado (independiente de la semana, se pisa cada
// vez que se cambia) — se persiste en la tabla brand_status por (kam_id,
// brand_key), donde brand_key es brand_id si existe o si no brand_name
const BRAND_STATUS_OPTIONS = ['No contactado', 'Contactado', 'Mkd activo', 'Actualizar Mkd', 'Mandar a BD', 'Blocker']

const BRAND_STATUS_COLORS = {
  'No contactado': { bg: '#2A2A2A', text: '#B0B0B0' },
  'Contactado': { bg: 'rgba(79, 195, 247, 0.18)', text: '#4FC3F7' },
  'Mkd activo': { bg: 'rgba(76, 175, 80, 0.18)', text: '#4CAF50' },
  'Actualizar Mkd': { bg: 'rgba(255, 193, 7, 0.18)', text: '#FFC107' },
  'Mandar a BD': { bg: 'rgba(255, 82, 82, 0.18)', text: '#FF5252' },
  'Blocker': { bg: 'rgba(183, 28, 28, 0.25)', text: '#EF5350' },
}

function brandKeyOf(brand) {
  return brand.brand_id || brand.brand_name
}

// Desplegable de estado por aliado, coloreado según el estado actual
function BrandStatusSelect({ brand, status, onChange }) {
  const current = status || 'No contactado'
  const colors = BRAND_STATUS_COLORS[current] || BRAND_STATUS_COLORS['No contactado']
  return (
    <select
      className="status-select"
      value={current}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(brand, e.target.value)}
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {BRAND_STATUS_OPTIONS.map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  )
}

function buildBrandInsight(brand) {
  const mdUp = brand.markdownDiffPct > 0
  const ordersTrend = brand.ordersDiff > 0 ? 'up' : brand.ordersDiff < 0 ? 'down' : 'flat'
  const trafficTrend = brand.traficoDiff > 0 ? 'up' : brand.traficoDiff < 0 ? 'down' : 'flat'
  const lowBase = brand.ordersLW < LOW_BASE_ORDERS && brand.orders < LOW_BASE_ORDERS

  if (lowBase) {
    return `Base de órdenes muy chica (LW: ${brand.ordersLW}, actual: ${brand.orders}; tráfico LW: ${brand.traficoLW}, actual: ${brand.trafico}) — el ${Math.abs(brand.markdownDiffPct).toFixed(0)}% de variación de markdown puede no ser representativo todavía; conviene mirar más semanas antes de sacar conclusiones.`
  }

  let base
  if (mdUp && ordersTrend === 'up') {
    base = `El markdown subió y las órdenes acompañaron (${brand.ordersDiff > 0 ? '+' : ''}${brand.ordersDiff}): la promoción parece estar generando tracción real, vale la pena sostenerla.`
  } else if (mdUp && ordersTrend !== 'up') {
    base = `El markdown subió pero las órdenes ${ordersTrend === 'down' ? `cayeron (${brand.ordersDiff})` : 'no se movieron'}: el mayor descuento no se tradujo en más pedidos — puede que el producto en promoción no sea tan atractivo y la gente haya elegido otra cosa. Vale la pena revisar la promo antes de seguir resignando margen.`
  } else if (!mdUp && ordersTrend === 'up') {
    base = `El markdown bajó y aun así las órdenes subieron (+${brand.ordersDiff}): la demanda no depende tanto del descuento — podría sostenerse un markdown más bajo sin perder volumen.`
  } else {
    base = `El markdown bajó y las órdenes ${ordersTrend === 'down' ? `también cayeron (${brand.ordersDiff})` : 'se mantuvieron sin cambios'}: el descuento parecía estar sosteniendo la demanda — bajarlo puede estar espantando pedidos, conviene evaluar volver a subirlo.`
  }

  // Cruzamos el tráfico (visitas) contra las órdenes para ver si lo que cambió
  // fue la conversión (mismo tráfico, distintas órdenes) o la visibilidad
  // (el tráfico se movió en la misma dirección que las órdenes)
  let trafficNote
  if (trafficTrend === 'up' && ordersTrend !== 'up') {
    trafficNote = ` El tráfico subió (+${brand.traficoDiff}) pero no se tradujo en más pedidos: la conversión bajó, puede ser más un tema de precio/oferta que de visibilidad.`
  } else if (trafficTrend === 'down' && ordersTrend === 'up') {
    trafficNote = ` Con menos tráfico (${brand.traficoDiff}) igual subieron las órdenes: mejoró la conversión, la demanda que llega convierte mejor.`
  } else if (trafficTrend === 'down' && ordersTrend !== 'up') {
    trafficNote = ` El tráfico también cayó (${brand.traficoDiff}), así que el movimiento de órdenes puede explicarse más por menor visibilidad que por el cambio de markdown en sí.`
  } else if (trafficTrend === 'up' && ordersTrend === 'up') {
    trafficNote = ` El tráfico acompañó (+${brand.traficoDiff}): mejor visibilidad y conversión en conjunto, no es solo un efecto del markdown.`
  } else {
    trafficNote = ''
  }

  return base + trafficNote
}

// Texto de la minuta semanal: cruza órdenes y tráfico de la última semana cerrada
// contra la anterior para calcular la conversión (orders/tráfico) y contar qué
// la movió — más visibilidad, mejor conversión, o ambas
function buildMinutaText(m) {
  if (!m) return ''
  const { prev, last, conversionLast, conversionPrev, conversionDiff } = m

  const ordersDiff = last.orders - prev.orders
  const ordersPct = prev.orders > 0 ? (ordersDiff / prev.orders) * 100 : 0
  const traficoDiff = last.trafico - prev.trafico
  const traficoPct = prev.trafico > 0 ? (traficoDiff / prev.trafico) * 100 : 0

  let text = `En la semana del ${last.semana} la cartera generó ${last.orders.toLocaleString()} órdenes (${ordersDiff >= 0 ? '+' : ''}${ordersDiff.toLocaleString()}, ${ordersPct >= 0 ? '+' : ''}${ordersPct.toFixed(1)}% vs. ${prev.semana}) sobre ${last.trafico.toLocaleString()} visitas (${traficoDiff >= 0 ? '+' : ''}${traficoDiff.toLocaleString()}, ${traficoPct >= 0 ? '+' : ''}${traficoPct.toFixed(1)}%).`

  if (conversionLast !== null) {
    text += ` Eso da una conversión de ${conversionLast.toFixed(2)}%`
    if (conversionDiff !== null) {
      text += conversionDiff >= 0
        ? `, ${conversionDiff.toFixed(2)} p.p. más que la semana anterior (${conversionPrev.toFixed(2)}%): `
        : `, ${Math.abs(conversionDiff).toFixed(2)} p.p. menos que la semana anterior (${conversionPrev.toFixed(2)}%): `

      if (conversionDiff >= 0 && ordersPct >= traficoPct) {
        text += 'las órdenes crecieron más que el tráfico, mejorando la eficiencia de conversión de la cartera.'
      } else if (conversionDiff >= 0) {
        text += 'la conversión mejoró aunque el tráfico creció más que las órdenes en términos relativos.'
      } else if (traficoPct > ordersPct) {
        text += 'llegó más tráfico pero no se tradujo proporcionalmente en órdenes, cayendo la conversión.'
      } else {
        text += 'las órdenes cayeron más que el tráfico, empeorando la conversión.'
      }
    } else {
      text += '.'
    }
  }

  return text
}

// Arma el contenido del Resumen Ejecutivo para copiar al portapapeles como
// HTML (con negrita/colores/viñetas) + texto plano de respaldo — Google Docs
// interpreta el HTML del portapapeles al pegar (Ctrl+V), así que esto le
// llega formateado sin tener que integrar la API de Docs.
function buildResumenClipboardContent(resumen) {
  const COLOR_UP = '#4CAF50'
  const COLOR_DOWN = '#F44336'
  const COLOR_GRAY = '#9E9E9E'

  const htmlParts = []
  const textParts = []

  const kpiHtml = (label, valueText, diffValue, diffSuffix = '%', decimals = 1) => {
    if (diffValue === null || diffValue === undefined || Number.isNaN(diffValue)) {
      return `<div>${label}: ${valueText}  <span style="color:${COLOR_GRAY};">(—)</span></div>`
    }
    const sign = diffValue > 0 ? '+' : ''
    const color = diffValue < 0 ? COLOR_DOWN : COLOR_UP
    return `<div>${label}: ${valueText}  <span style="color:${color}; font-weight:bold;">(${sign}${diffValue.toFixed(decimals)}${diffSuffix} vs. semana anterior)</span></div>`
  }
  const kpiText = (label, valueText, diffValue, diffSuffix = '%', decimals = 1) => {
    if (diffValue === null || diffValue === undefined || Number.isNaN(diffValue)) return `${label}: ${valueText} (—)`
    const sign = diffValue > 0 ? '+' : ''
    return `${label}: ${valueText} (${sign}${diffValue.toFixed(decimals)}${diffSuffix} vs. semana anterior)`
  }

  const kamNombre = resumen.kam?.nombre || 'KAM'
  htmlParts.push(`<div style="font-size:15pt; font-weight:bold;">📊 Resumen Semanal — ${kamNombre}</div>`)
  textParts.push(`📊 Resumen Semanal — ${kamNombre}`)

  let meta = `Kam de ${resumen.kam?.region || '—'} · ${resumen.kam?.brandCount ?? 0} brands · Semana del ${resumen.semana}`
  if (resumen.semanaAnterior) meta += ` (vs. ${resumen.semanaAnterior})`
  htmlParts.push(`<div style="font-size:9pt; font-style:italic; color:${COLOR_GRAY};">${meta}</div><div>&nbsp;</div>`)
  textParts.push(meta, '')

  htmlParts.push('<div style="font-size:12pt; font-weight:bold;">KPIs de la semana</div>')
  textParts.push('KPIs de la semana')

  const orders = ['📦 Órdenes', resumen.orders.value.toLocaleString(), resumen.orders.diff?.pct ?? null]
  const markdown = ['📊 Markdown', `${resumen.markdown.value.toFixed(1)}%`, resumen.markdown.diff?.pct ?? null]
  const trafico = ['📶 Tráfico', resumen.trafico.value.toLocaleString(), resumen.trafico.diff?.pct ?? null]
  const conversion = ['🎯 Conversión', resumen.conversion ? `${resumen.conversion.value.toFixed(2)}%` : '—', resumen.conversion?.diff ?? null, ' p.p.', 2]

  ;[orders, markdown, trafico, conversion].forEach(([label, value, diff, suffix, decimals]) => {
    htmlParts.push(kpiHtml(label, value, diff, suffix, decimals))
    textParts.push(kpiText(label, value, diff, suffix, decimals))
  })
  htmlParts.push('<div>&nbsp;</div>')
  textParts.push('')

  if (resumen.minutaText) {
    htmlParts.push(`<div style="font-style:italic;">📝 ${resumen.minutaText}</div><div>&nbsp;</div>`)
    textParts.push(`📝 ${resumen.minutaText}`, '')
  }

  if (resumen.brandMd) {
    const { status, calc } = resumen.brandMd
    const { color, label } = mdStatusFor(calc.achievedPct)
    htmlParts.push(`<div>🎯 Brands with Markdown: ${status.brands_md_result} / ${status.brands_md_target}  <span style="color:${color}; font-weight:bold;">(${calc.achievedPct.toFixed(1)}% · ${label})</span></div>`)
    textParts.push(`🎯 Brands with Markdown: ${status.brands_md_result} / ${status.brands_md_target} (${calc.achievedPct.toFixed(1)}% · ${label})`)
    if (resumen.mdTargetText) {
      htmlParts.push(`<div style="font-size:9.5pt; color:${COLOR_GRAY};">${resumen.mdTargetText}</div>`)
      textParts.push(resumen.mdTargetText)
    }
    htmlParts.push('<div>&nbsp;</div>')
    textParts.push('')
  }

  if (resumen.urgentBrands?.total > 0) {
    const total = resumen.urgentBrands.total
    const title = `🚨 Accionar Urgente — ${total} aliado${total === 1 ? '' : 's'} cerca del target (70%-85% de MD Archie Final)`
    htmlParts.push(`<div style="font-weight:bold;">${title}</div><ul>`)
    textParts.push(title)
    resumen.urgentBrands.top.forEach((r) => {
      const color = mdStatusFor(r.md_archie_final_pct).color
      htmlParts.push(`<li>${r.brand_name}: <span style="color:${color}; font-weight:bold;">${r.md_archie_final_pct.toFixed(1)}%</span></li>`)
      textParts.push(`• ${r.brand_name}: ${r.md_archie_final_pct.toFixed(1)}%`)
    })
    htmlParts.push('</ul><div>&nbsp;</div>')
    textParts.push('')
  }

  if (resumen.topSubas?.length > 0) {
    htmlParts.push('<div style="font-weight:bold;">🔼 Mayor suba de MD</div><ul>')
    textParts.push('🔼 Mayor suba de MD')
    resumen.topSubas.forEach((b) => {
      htmlParts.push(`<li>${b.brand_name}: <span style="color:${COLOR_UP}; font-weight:bold;">+${b.markdownDiffPct.toFixed(1)}%</span></li>`)
      textParts.push(`• ${b.brand_name}: +${b.markdownDiffPct.toFixed(1)}%`)
    })
    htmlParts.push('</ul><div>&nbsp;</div>')
    textParts.push('')
  }

  if (resumen.topBajas?.length > 0) {
    htmlParts.push('<div style="font-weight:bold;">🔽 Mayor baja de MD</div><ul>')
    textParts.push('🔽 Mayor baja de MD')
    resumen.topBajas.forEach((b) => {
      htmlParts.push(`<li>${b.brand_name}: <span style="color:${COLOR_DOWN}; font-weight:bold;">${b.markdownDiffPct.toFixed(1)}%</span></li>`)
      textParts.push(`• ${b.brand_name}: ${b.markdownDiffPct.toFixed(1)}%`)
    })
    htmlParts.push('</ul><div>&nbsp;</div>')
    textParts.push('')
  }

  const fecha = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' })
  htmlParts.push(`<div style="font-size:8.5pt; font-style:italic; color:${COLOR_GRAY};">Generado el ${fecha} · Dashboard KAMs Semanal</div>`)
  textParts.push(`Generado el ${fecha} · Dashboard KAMs Semanal`)

  return {
    html: `<div style="font-family:Arial,sans-serif;">${htmlParts.join('')}</div>`,
    text: textParts.join('\n'),
  }
}

// Importación de Excel para Brands with Markdown: nombres de columna aceptados
// por campo (normalizados a minúscula/sin espacios extra), para bancar que el
// archivo venga con alguna variación de mayúsculas/espacios respecto al sheet
// original de comisiones
const MD_IMPORT_COLUMN_ALIASES = {
  email: ['comercial', 'email', 'mail', 'kam'],
  result: ['brands w/md result', 'brands w md result', 'brands with md result'],
  target: ['brands w/md target', 'brands w md target', 'brands with md target'],
}

function normalizeHeaderCell(value) {
  return String(value ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

function findMdImportColumnIndex(headerRow, aliases) {
  const normalized = headerRow.map(normalizeHeaderCell)
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias)
    if (idx !== -1) return idx
  }
  return -1
}

// Importación de Excel para Accionar Urgente ("Compensation"): a diferencia de
// Brands with Markdown (un solo % agregado por KAM), este archivo es un reporte
// jerárquico tipo pivot exportado a plano: el email del KAM (columna "OWNER")
// aparece UNA sola vez, en su fila de subtotal ("Bucket"="Total"), y todas las
// filas de aliados que le siguen (PRIORITIZED/NON PRIORITIZED/ADJUSTED) tienen
// esa celda vacía hasta el próximo KAM. Por eso el parseo hace "forward-fill"
// del último email visto en vez de exigirlo en la misma fila que el aliado.
const COMPENSATION_IMPORT_COLUMN_ALIASES = {
  email: ['comercial', 'email', 'mail', 'kam', 'owner'],
  brand: ['aliado', 'brand', 'marca', 'nombre comercial', 'restaurante', 'partner', 'brand_id_name'],
  mdArchieFinal: ['md archie final', 'md achie final', 'archie final', 'achie final', '% md archie final'],
}

// El aliado viene como "AR65117-Luigi Heladeria y Pasteleria" (ID país+código,
// guion, nombre). Separa el ID (para usarlo como key estable entre imports,
// a prueba de acentos/espacios) del nombre legible para mostrar.
function parseBrandIdName(raw) {
  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  const match = trimmed.match(/^([A-Za-z]{2,4}\d+)-(.+)$/)
  if (match) return { key: match[1].toUpperCase(), name: match[2].trim() }
  return { key: trimmed.toLowerCase(), name: trimmed }
}

// Umbral de "Accionar Urgente": aliados con % de MD Archie Final entre 70 y 85 —
// los que todavía no llegan al mínimo de target (70-80%) y los que ya lo cruzaron
// pero están al borde, sin margen (80-85%). Ver mdStatusFor: 80% es el mismo
// corte de "mínimo cumplido" que usa el resto de la app.
const URGENT_MD_MIN = 70
const URGENT_MD_MAX = 85
const URGENT_MD_TARGET_CUT = 80

// Doc de bitácora semanal donde se pega el Resumen Ejecutivo copiado con
// "📋 Copiar para Doc" — mismo doc que quedará como destino cuando el export
// se conecte directo a la API de Docs (ver Scripts/google-oauth-setup.js).
const RESUMEN_DOC_URL = 'https://docs.google.com/document/d/1yGBOOXnDTgdCZ0ysSHYbziUslFAAS7fzPUZMpacgbro/edit'

// Alerta "Brands caídas a 0% de Markdown": compara la primera quincena del
// mes pasado contra la última semana cerrada, para TODOS los KAMs a la vez.
// semana_fecha se guarda como "DD Mon" con abreviatura en inglés (así la
// graba Scripts/sync-sheets.js / app/api/sync), sin año — por eso esto asume
// que no hay dos ocurrencias del mismo "DD Mon" separadas por más de un año
// en la tabla, que es como ya funciona el resto del dashboard.
const MONTH_ABBR_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_NAMES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const MD_DROP_EPSILON = 0.01

// Acepta el % como "78%", "78" o "0.78" (fracción) — normaliza todo a puntos
// porcentuales (78). Si el texto trae el símbolo "%" explícito, el número ya
// está en puntos porcentuales y no se reescala.
function parsePercentCell(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  const isPercentString = typeof raw === 'string' && raw.includes('%')
  const cleaned = String(raw).replace('%', '').replace(',', '.').trim()
  const num = Number(cleaned)
  if (!Number.isFinite(num)) return null
  if (isPercentString) return num
  return Math.abs(num) <= 1 ? num * 100 : num
}

// Umbrales seleccionables para "cuántas brands faltan" en Brands with Markdown
const MD_TARGET_GOAL_OPTIONS = [80, 90, 100, 110]

// Cálculo de faltantes/sobrantes de brands con markdown contra un umbral (% del
// target). Es intencionalmente conservador en las dos direcciones: "missing"
// siempre redondea PARA ARRIBA (nunca subestima cuánto falta) y "surplus"
// siempre redondea PARA ABAJO (nunca sobreestima cuánto sobra) — así el número
// que se muestra es siempre una garantía real, no una aproximación optimista.
function calcBrandsMdGoal(result, target, goalPct) {
  const requiredAtGoal = target * (goalPct / 100)
  const gap = requiredAtGoal - result
  const achievedPct = target > 0 ? (result / target) * 100 : 0
  if (gap <= 0) {
    return { met: true, missing: 0, surplus: Math.max(0, Math.floor(-gap)), achievedPct, requiredAtGoal }
  }
  return { met: false, missing: Math.ceil(gap), surplus: 0, achievedPct, requiredAtGoal }
}

// Minuta de Brands with Markdown: resume dónde está el KAM y qué le falta (o le
// sobra) para el umbral que tenga seleccionado
function buildMdTargetMinutaText(kamNombre, result, target, goalPct, calc) {
  const nombre = kamNombre || 'Este KAM'
  let text = `${nombre} tiene ${result} de ${target} brands objetivo con markdown activo (${calc.achievedPct.toFixed(2)}% cumplido del target).`
  if (calc.met) {
    text += calc.surplus > 0
      ? ` Ya superó el umbral del ${goalPct}% — le sobran ${calc.surplus} brand${calc.surplus === 1 ? '' : 's'} de margen sobre ese nivel.`
      : ` Justo en el umbral del ${goalPct}%, sin margen todavía.`
  } else {
    text += ` Para llegar al ${goalPct}% del objetivo le faltan ${calc.missing} brand${calc.missing === 1 ? '' : 's'} más con markdown activo.`
  }
  return text
}

// Círculo de progreso del % de markdown cumplido (Brands w/MD Result/Target).
// El anillo se satura visualmente en 100% aunque el número supere eso (ej.
// 121%), para no romper el dibujo — el número real siempre se ve en el centro.
// Escala de color/estado del % cumplido: por debajo de 80% todavía no llega
// al mínimo (rojo). De 80% en adelante ya está en verde, en 4 intensidades
// que acompañan los mismos umbrales del desplegable (80/90/100/110) — más
// oscuro/fuerte cuanto más arriba, según el criterio de negocio: 80% cumple
// el mínimo pero no está asegurado (puede variar), 90% es un poco más sólido,
// 100% "performa" y 110%+ "sobreperforma".
function mdStatusFor(pct) {
  if (pct < 80) return { color: '#F44336', label: 'EN PROGRESO' }
  if (pct < 90) return { color: '#AED581', label: 'MÍNIMO CUMPLIDO' }
  if (pct < 100) return { color: '#7CB342', label: 'EN BUEN CAMINO' }
  if (pct < 110) return { color: '#4CAF50', label: 'PERFORMA' }
  return { color: '#2E7D32', label: 'SOBREPERFORMA' }
}

function CircularProgress({ pct }) {
  const size = 140
  const strokeWidth = 12
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(pct, 100))
  const offset = circumference * (1 - clamped / 100)
  const { color, label } = mdStatusFor(pct)

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#2A2A2A" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.4s ease' }}
      />
      <text x="50%" y="47%" textAnchor="middle" dominantBaseline="middle" fontSize="22" fontWeight="800" fill="#FFFFFF">
        {pct.toFixed(1)}%
      </text>
      <text x="50%" y="65%" textAnchor="middle" dominantBaseline="middle" fontSize="9" fontWeight="700" fill="#B0B0B0">
        {label}
      </text>
    </svg>
  )
}

function DiffCell({ value, decimals = 1, suffix = '%' }) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span style={{ color: '#B0B0B0' }}>—</span>
  }
  const color = value < 0 ? '#F44336' : '#4CAF50'
  return (
    <span style={{ color, fontWeight: 700 }}>
      {value > 0 ? '+' : ''}{value.toFixed(decimals)}{suffix}
    </span>
  )
}

// Encabezado ordenable de las tablas de Top/Bottom y Middle: un solo click
// ordena la tabla completa (la fila entera se mueve junto, no solo la celda)
// de mayor a menor por esa columna; un segundo click invierte a menor a mayor;
// un tercer click vuelve al orden original. Solo puede haber una columna
// ordenando a la vez — elegir otra reemplaza la anterior.
function SortableTh({ label, sortKey, sort, onSort }) {
  const active = sort?.key === sortKey
  const arrow = active ? (sort.dir === 'desc' ? '▼' : '▲') : ''
  return (
    <th
      className={`sortable-th ${active ? 'active' : ''}`}
      onClick={() => onSort(sortKey)}
    >
      {label}{arrow && <span className="sort-arrow">{arrow}</span>}
    </th>
  )
}

function makeSortHandler(setSort) {
  return (key) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'desc' }
      if (prev.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }
}

function sortBrandRows(rows, sort) {
  if (!sort) return rows
  return [...rows].sort((a, b) => {
    const av = a[sort.key]
    const bv = b[sort.key]
    if (av === null || av === undefined) return 1
    if (bv === null || bv === undefined) return -1
    return sort.dir === 'desc' ? bv - av : av - bv
  })
}

function GrowthLabel({ x, y, width, value }) {
  if (value === undefined || value === null) return null
  const color = value < 0 ? '#F44336' : '#4CAF50'
  return (
    <text x={x + width / 2} y={y - 13} textAnchor="middle" fontSize={8} fontWeight={700} fill={color}>
      {`${value > 0 ? '+' : ''}${value.toFixed(1)}%`}
    </text>
  )
}

export default function KamDashboard({ data }) {
  const [activeKam, setActiveKam] = useState(0)
  const [activeSubTab, setActiveSubTab] = useState('topbottom')
  const [hoverBrand, setHoverBrand] = useState(null)
  const [hoverPos, setHoverPos] = useState(null)
  const hoverHideTimeout = useRef(null)

  // Ordenamiento por columna de las tablas de Top/Bottom y Middle — uno solo
  // activo a la vez por tabla, ver SortableTh
  const [topSort, setTopSort] = useState(null)
  const [bottomSort, setBottomSort] = useState(null)
  const [middleSort, setMiddleSort] = useState(null)
  const handleTopSort = useCallback(makeSortHandler(setTopSort), [])
  const handleBottomSort = useCallback(makeSortHandler(setBottomSort), [])
  const handleMiddleSort = useCallback(makeSortHandler(setMiddleSort), [])

  const { kams, weeklyData } = data
  const kamActive = kams?.[activeKam]

  // Alerta "Brands caídas a 0% de Markdown" — cruza TODOS los KAMs y TODAS
  // las brands (no depende del KAM seleccionado), comparando el promedio de
  // markdown/órdenes/tráfico de la primera quincena del mes pasado contra la
  // última semana cerrada, para detectar brands que tenían markdown activo y
  // hoy están en 0%.
  const [expandedDropKams, setExpandedDropKams] = useState(() => new Set())

  const mdDropAlert = useMemo(() => {
    if (!weeklyData?.length || !kams?.length) return null

    const today = new Date()
    const prevMonthIdx = (today.getMonth() - 1 + 12) % 12
    const prevMonthAbbr = MONTH_ABBR_EN[prevMonthIdx]
    const baselineWeekRe = new RegExp(`^(\\d{1,2}) ${prevMonthAbbr}$`)

    const allWeeks = [...new Set(weeklyData.map(r => r.semana_fecha?.trim()).filter(Boolean))]

    // "Primeros 15 días" del mes pasado: semanas de ese mes cuyo día de
    // arranque cae en la primera quincena (03 Aug, 10 Aug → sí; 17 Aug → no).
    const baselineWeeks = allWeeks.filter((w) => {
      const m = w.match(baselineWeekRe)
      return m && Number(m[1]) <= 15
    })
    if (baselineWeeks.length === 0) return null

    // "Hoy": la última semana cerrada con label bien formado (se ignoran
    // labels rotos tipo "01–19 Jul" que quedaron de una carga vieja).
    const cleanWeeks = allWeeks.filter((w) => parseWeekLabel(w) !== null)
    const currentWeek = [...cleanWeeks].sort(compareWeekLabels).slice(-1)[0]
    if (!currentWeek || baselineWeeks.includes(currentWeek)) return null

    const brandRows = weeklyData.filter((r) => r.brand_name !== 'TOTAL_KAM')
    const keyOf = (r) => `${r.kam_id}::${r.brand_id || r.brand_name}`

    const baselineByKey = new Map()
    brandRows.forEach((r) => {
      if (!baselineWeeks.includes(r.semana_fecha?.trim())) return
      const key = keyOf(r)
      const acc = baselineByKey.get(key) || {
        kam_id: r.kam_id, brand_name: r.brand_name, orders: 0, trafico: 0, markdownSum: 0, weeks: 0,
      }
      acc.orders += r.orders || 0
      acc.trafico += r.trafico || 0
      acc.markdownSum += r.markdown || 0
      acc.weeks += 1
      baselineByKey.set(key, acc)
    })

    const currentByKey = new Map()
    brandRows.forEach((r) => {
      if (r.semana_fecha?.trim() !== currentWeek) return
      currentByKey.set(keyOf(r), r)
    })

    const kamById = new Map(kams.map((k) => [k.id, k]))
    const groupsByKam = new Map()

    baselineByKey.forEach((base, key) => {
      const baselineMarkdown = base.markdownSum / base.weeks
      if (baselineMarkdown <= MD_DROP_EPSILON) return // no tenía markdown activo, no cuenta como "caída"

      const current = currentByKey.get(key)
      const currentMarkdown = current?.markdown || 0
      if (currentMarkdown > MD_DROP_EPSILON) return // sigue con markdown, no cayó a 0

      const kam = kamById.get(base.kam_id)
      if (!kam) return

      if (!groupsByKam.has(base.kam_id)) {
        groupsByKam.set(base.kam_id, { kam, brands: [] })
      }
      groupsByKam.get(base.kam_id).brands.push({
        brand_name: base.brand_name,
        baseline: { markdown: baselineMarkdown, orders: base.orders, trafico: base.trafico },
        current: { markdown: currentMarkdown, orders: current?.orders || 0, trafico: current?.trafico || 0 },
        foundToday: !!current,
      })
    })

    const kamGroups = [...groupsByKam.values()]
      .map((g) => ({ ...g, brands: g.brands.sort((a, b) => b.baseline.markdown - a.baseline.markdown) }))
      .sort((a, b) => b.brands.length - a.brands.length)

    const totalBrands = kamGroups.reduce((sum, g) => sum + g.brands.length, 0)
    if (totalBrands === 0) return null

    // Resumen total: suma de órdenes y tráfico de TODAS las brands caídas, de
    // TODOS los KAMs juntos — para dimensionar el impacto combinado, no solo
    // verlo aliado por aliado.
    const totals = kamGroups.reduce((acc, g) => {
      g.brands.forEach((b) => {
        acc.baselineOrders += b.baseline.orders
        acc.baselineTrafico += b.baseline.trafico
        acc.currentOrders += b.current.orders
        acc.currentTrafico += b.current.trafico
      })
      return acc
    }, { baselineOrders: 0, baselineTrafico: 0, currentOrders: 0, currentTrafico: 0 })

    return {
      mesLabel: MONTH_NAMES_ES[prevMonthIdx],
      baselineWeeks,
      currentWeek,
      totalBrands,
      kamGroups,
      totals,
    }
  }, [weeklyData, kams])

  const toggleDropKam = useCallback((kamId) => {
    setExpandedDropKams((prev) => {
      const next = new Set(prev)
      if (next.has(kamId)) next.delete(kamId)
      else next.add(kamId)
      return next
    })
  }, [])

  // Exportar la situación de UN KAM (de la alerta de brands caídas a 0%) como
  // JPEG, para mandarla al equipo aliado por aliado — abre una tarjeta
  // standalone (mismo lenguaje visual que el Resumen Ejecutivo) en vez de
  // capturar el acordeón tal cual, así la imagen queda prolija para compartir
  // (sin flechas/botones de la UI) sin importar si el grupo estaba plegado.
  const [dropExportTarget, setDropExportTarget] = useState(null)
  const [dropExportStatus, setDropExportStatus] = useState(null)
  const dropExportCardRef = useRef(null)

  const handleDownloadDropJpeg = useCallback(async () => {
    if (!dropExportCardRef.current || !dropExportTarget) return
    setDropExportStatus('loading')
    try {
      const dataUrl = await toJpeg(dropExportCardRef.current, { quality: 0.95, pixelRatio: 2, backgroundColor: '#1E1E1E' })
      const link = document.createElement('a')
      const fileKam = dropExportTarget.kam.nombre.toLowerCase().replace(/\s+/g, '-')
      link.download = `brands-caidas-md-${fileKam}.jpeg`.replace(/\s+/g, '')
      link.href = dataUrl
      link.click()
      setDropExportStatus(null)
    } catch (err) {
      console.error('❌ Error exportando situación a JPEG:', err)
      setDropExportStatus('error')
    }
  }, [dropExportTarget])

  // Estado por aliado (Contactado / No contactado / Mkd activo / etc.), no
  // depende de la semana — se carga entero para el KAM activo y se pisa en
  // Supabase al toque cada vez que alguien lo cambia desde cualquier tabla
  const [brandStatusMap, setBrandStatusMap] = useState({})

  useEffect(() => {
    if (!kamActive) return
    let cancelled = false
    supabase
      .from('brand_status')
      .select('brand_key, status')
      .eq('kam_id', kamActive.id)
      .then(({ data, error }) => {
        if (cancelled || error) return
        const map = {}
        data.forEach((row) => { map[row.brand_key] = row.status })
        setBrandStatusMap(map)
      })
    return () => { cancelled = true }
  }, [kamActive])

  const updateBrandStatus = useCallback((brand, status) => {
    if (!kamActive) return
    const key = brandKeyOf(brand)
    // Update optimista para que el select responda al toque
    setBrandStatusMap((prev) => ({ ...prev, [key]: status }))
    supabase.from('brand_status').upsert({
      kam_id: kamActive.id,
      brand_key: key,
      brand_name: brand.brand_name,
      status,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'kam_id,brand_key' }).then(({ error }) => {
      if (error) console.error('❌ Error guardando estado del aliado:', error)
    })
  }, [kamActive])

  // Brands with Markdown: Brands w/MD Result/Target del KAM activo (cargado
  // manualmente desde el sheet de comisiones, no forma parte del sync semanal
  // de "raw") + el umbral elegido para calcular cuántas brands faltan/sobran
  const [brandMdStatus, setBrandMdStatus] = useState(null)
  const [mdGoalPct, setMdGoalPct] = useState(100)

  useEffect(() => {
    if (!kamActive) return
    let cancelled = false
    supabase
      .from('brand_markdown_status')
      .select('brands_md_result, brands_md_target, updated_at')
      .eq('kam_id', kamActive.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) console.error('❌ Error cargando Brands with Markdown:', error)
        setBrandMdStatus(data || null)
      })
    return () => { cancelled = true }
  }, [kamActive])

  const brandMdCalc = useMemo(() => {
    if (!brandMdStatus) return null
    return calcBrandsMdGoal(brandMdStatus.brands_md_result, brandMdStatus.brands_md_target, mdGoalPct)
  }, [brandMdStatus, mdGoalPct])

  // Accionar Urgente: % de "MD Archie Final" por aliado del KAM activo (cargado
  // desde el import de Compensation, tabla aparte porque es un dato por aliado,
  // no un agregado por KAM como brandMdStatus).
  const [compensationRows, setCompensationRows] = useState([])

  useEffect(() => {
    if (!kamActive) return
    let cancelled = false
    supabase
      .from('brand_compensation_status')
      .select('brand_key, brand_name, md_archie_final_pct, updated_at')
      .eq('kam_id', kamActive.id)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) { console.error('❌ Error cargando Compensation (MD Archie Final):', error); return }
        setCompensationRows(data || [])
      })
    return () => { cancelled = true }
  }, [kamActive])

  // Aliados "urgentes": % de MD Archie Final entre 70 y 85 — ordenados de mayor
  // a menor para que arriba queden los que están más cerca de asegurar el target.
  const urgentBrands = useMemo(() => {
    return compensationRows
      .filter((r) => r.md_archie_final_pct !== null && r.md_archie_final_pct >= URGENT_MD_MIN && r.md_archie_final_pct <= URGENT_MD_MAX)
      .sort((a, b) => b.md_archie_final_pct - a.md_archie_final_pct)
  }, [compensationRows])

  // Ranking de Brands with Markdown de TODOS los KAMs (no solo el activo), para
  // el bloque fijo de arriba. A diferencia de brandMdStatus (que trae solo el
  // KAM activo), acá se traen todos de una — se recarga cada vez que cambia el
  // array de KAMs (ej. en cada refetch periódico de 60s de app/page.js), así el
  // ranking refleja la última importación de Excel sin depender de qué KAM o
  // pestaña esté mirando el usuario.
  const [kamsMdStatusMap, setKamsMdStatusMap] = useState({})

  useEffect(() => {
    if (!kams || kams.length === 0) return
    let cancelled = false
    supabase
      .from('brand_markdown_status')
      .select('kam_id, brands_md_result, brands_md_target, updated_at')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) { console.error('❌ Error cargando ranking de Brands with Markdown:', error); return }
        const map = {}
        data.forEach((row) => { map[row.kam_id] = row })
        setKamsMdStatusMap(map)
      })
    return () => { cancelled = true }
  }, [kams])

  // Ranking ordenado de mayor a menor % de Brands with Markdown cumplido.
  // Solo entran los KAMs que ya tienen datos cargados (result/target) —
  // el resto todavía no importó el Excel de comisiones y no tiene con qué comparar.
  const kamsRanking = useMemo(() => {
    if (!kams) return []
    return kams
      .map((kam) => {
        const status = kamsMdStatusMap[kam.id]
        if (!status) return null
        const calc = calcBrandsMdGoal(status.brands_md_result, status.brands_md_target, 100)
        return {
          id: kam.id,
          nombre: kam.nombre,
          result: status.brands_md_result,
          target: status.brands_md_target,
          achievedPct: calc.achievedPct,
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.achievedPct - a.achievedPct)
      .map((k, idx) => ({ ...k, rank: idx + 1 }))
  }, [kams, kamsMdStatusMap])

  // Importar Excel de Brands with Markdown: lee el archivo, identifica las
  // columnas de Comercial (email) / Brands w/MD Result / Brands w/MD Target,
  // cruza cada fila contra el email de un KAM existente y pisa esos valores
  // en brand_markdown_status para todos los KAMs que hayan matcheado
  const mdImportInputRef = useRef(null)
  const [mdImportStatus, setMdImportStatus] = useState(null)

  const handleMdImportClick = () => mdImportInputRef.current?.click()

  const handleMdImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setMdImportStatus({ type: 'loading', message: 'Leyendo archivo...' })

    try {
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })

      if (!rows.length) throw new Error('El archivo está vacío.')

      const headerRow = rows[0]
      const emailIdx = findMdImportColumnIndex(headerRow, MD_IMPORT_COLUMN_ALIASES.email)
      const resultIdx = findMdImportColumnIndex(headerRow, MD_IMPORT_COLUMN_ALIASES.result)
      const targetIdx = findMdImportColumnIndex(headerRow, MD_IMPORT_COLUMN_ALIASES.target)

      if (emailIdx === -1 || resultIdx === -1 || targetIdx === -1) {
        throw new Error('No encontré las columnas "Comercial", "Brands w/MD Result" y "Brands w/MD Target" en el archivo. Revisá los encabezados.')
      }

      const emailToKam = new Map((kams || []).map((k) => [k.email?.toLowerCase().trim(), k]))
      const updatedAt = new Date().toISOString()
      const updates = []
      const unmatchedEmails = []

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]
        if (!row || row.every((cell) => cell === null || cell === '')) continue

        const email = String(row[emailIdx] || '').toLowerCase().trim()
        if (!email) continue

        const kam = emailToKam.get(email)
        if (!kam) {
          unmatchedEmails.push(email)
          continue
        }

        const result = Number(row[resultIdx])
        const target = Number(row[targetIdx])
        if (!Number.isFinite(result) || !Number.isFinite(target)) continue

        updates.push({
          kam_id: kam.id,
          email: kam.email,
          brands_md_result: result,
          brands_md_target: target,
          updated_at: updatedAt,
        })
      }

      if (updates.length === 0) {
        throw new Error('Ninguna fila coincidió con los emails de los KAMs actuales.')
      }

      const { error } = await supabase
        .from('brand_markdown_status')
        .upsert(updates, { onConflict: 'kam_id' })

      if (error) throw error

      // Reflejar el cambio al toque, sin esperar a un refetch: si el KAM activo
      // estaba entre los actualizados, pisa su brandMdStatus (tarjeta Brands with
      // Markdown); y para TODOS los actualizados, pisa kamsMdStatusMap — de ahí
      // sale kamsRanking, así que el ranking se reordena solo apenas termina el
      // import, con los targets nuevos, sin depender del refetch de 60s.
      const ownUpdate = kamActive && updates.find((u) => u.kam_id === kamActive.id)
      if (ownUpdate) setBrandMdStatus(ownUpdate)

      setKamsMdStatusMap((prev) => {
        const next = { ...prev }
        updates.forEach((u) => {
          next[u.kam_id] = {
            kam_id: u.kam_id,
            brands_md_result: u.brands_md_result,
            brands_md_target: u.brands_md_target,
            updated_at: u.updated_at,
          }
        })
        return next
      })

      let message = `✅ ${updates.length} KAM${updates.length === 1 ? '' : 's'} actualizado${updates.length === 1 ? '' : 's'} correctamente.`
      if (unmatchedEmails.length > 0) {
        message += ` ${unmatchedEmails.length} fila${unmatchedEmails.length === 1 ? '' : 's'} no coincidió con ningún KAM.`
      }
      setMdImportStatus({ type: 'success', message })
    } catch (err) {
      setMdImportStatus({ type: 'error', message: err.message || 'No se pudo importar el archivo.' })
    }
  }

  // Importar Excel de Compensation (Accionar Urgente): a diferencia del import
  // de Brands with Markdown (una fila por KAM), acá cada fila es un aliado —
  // se cruza por email de KAM + nombre de aliado, y se guarda su % de "MD
  // archie final" en brand_compensation_status.
  const compensationImportInputRef = useRef(null)
  const [compensationImportStatus, setCompensationImportStatus] = useState(null)

  // Los botones de Importar Excel / Importar Compensation se portan (React
  // portal) al header (ver app/layout.js), a la izquierda del logo de Rappi,
  // en vez de renderizarse acá donde vive la lógica — el nodo del header
  // recién existe en el DOM después de montar, de ahí el useEffect.
  const [importActionsHost, setImportActionsHost] = useState(null)
  useEffect(() => {
    setImportActionsHost(document.getElementById('header-import-actions'))
  }, [])

  // Botón de alerta (🚨 Brands caídas a 0% de Markdown), portado al header a
  // la derecha del logo — mismo mecanismo que los botones de Importar de
  // arriba. El modal con el detalle se abre al hacer click.
  const [alertActionsHost, setAlertActionsHost] = useState(null)
  const [showMdDropModal, setShowMdDropModal] = useState(false)
  useEffect(() => {
    setAlertActionsHost(document.getElementById('header-alert-actions'))
  }, [])

  const handleCompensationImportClick = () => compensationImportInputRef.current?.click()

  const handleCompensationImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setCompensationImportStatus({ type: 'loading', message: 'Leyendo archivo...' })

    try {
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })

      if (!rows.length) throw new Error('El archivo está vacío.')

      const headerRow = rows[0]
      const emailIdx = findMdImportColumnIndex(headerRow, COMPENSATION_IMPORT_COLUMN_ALIASES.email)
      const brandIdx = findMdImportColumnIndex(headerRow, COMPENSATION_IMPORT_COLUMN_ALIASES.brand)
      const mdArchieIdx = findMdImportColumnIndex(headerRow, COMPENSATION_IMPORT_COLUMN_ALIASES.mdArchieFinal)

      if (emailIdx === -1 || brandIdx === -1 || mdArchieIdx === -1) {
        throw new Error('No encontré las columnas "Comercial", "Aliado" y "MD archie final" en el archivo. Revisá los encabezados.')
      }

      const emailToKam = new Map((kams || []).map((k) => [k.email?.toLowerCase().trim(), k]))
      const updatedAt = new Date().toISOString()
      const updates = []
      const unmatchedEmails = new Set()

      // "Forward-fill": el OWNER solo viene completo en la fila de subtotal de
      // cada KAM — se guarda acá y se reutiliza en todas las filas de aliados
      // que le siguen, hasta que aparezca un OWNER nuevo (o se corte el archivo).
      let currentEmail = null

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]
        if (!row || row.every((cell) => cell === null || cell === '')) continue

        const ownerCell = row[emailIdx]
        if (ownerCell !== null && ownerCell !== undefined && ownerCell !== '') {
          currentEmail = String(ownerCell).toLowerCase().trim()
        }
        if (!currentEmail || currentEmail === 'total') continue

        const brandCell = row[brandIdx]
        const parsedBrand = parseBrandIdName(brandCell)
        // Las filas de subtotal (por KAM o por Bucket PRIORITIZED/NON PRIORITIZED/
        // ADJUSTED) repiten "Total" en la columna del aliado — no son aliados reales.
        if (!parsedBrand || parsedBrand.name.toLowerCase() === 'total') continue

        const kam = emailToKam.get(currentEmail)
        if (!kam) {
          unmatchedEmails.add(currentEmail)
          continue
        }

        const mdArchieFinalPct = parsePercentCell(row[mdArchieIdx])
        if (mdArchieFinalPct === null) continue

        updates.push({
          kam_id: kam.id,
          brand_key: parsedBrand.key,
          brand_name: parsedBrand.name,
          md_archie_final_pct: mdArchieFinalPct,
          updated_at: updatedAt,
        })
      }

      if (updates.length === 0) {
        throw new Error('Ninguna fila coincidió con los emails de los KAMs actuales.')
      }

      const { error } = await supabase
        .from('brand_compensation_status')
        .upsert(updates, { onConflict: 'kam_id,brand_key' })

      if (error) throw error

      // Reflejar el cambio al toque si el KAM activo estaba entre los actualizados,
      // sin esperar a un refetch
      if (kamActive) {
        const ownUpdates = updates.filter((u) => u.kam_id === kamActive.id)
        if (ownUpdates.length > 0) setCompensationRows(ownUpdates)
      }

      const uniqueKams = new Set(updates.map((u) => u.kam_id)).size
      let message = `✅ ${updates.length} aliado${updates.length === 1 ? '' : 's'} actualizado${updates.length === 1 ? '' : 's'} en ${uniqueKams} KAM${uniqueKams === 1 ? '' : 's'}.`
      if (unmatchedEmails.size > 0) {
        message += ` ${unmatchedEmails.size} email${unmatchedEmails.size === 1 ? '' : 's'} no coincidió con ningún KAM (${[...unmatchedEmails].join(', ')}).`
      }
      setCompensationImportStatus({ type: 'success', message })
    } catch (err) {
      setCompensationImportStatus({ type: 'error', message: err.message || 'No se pudo importar el archivo.' })
    }
  }

  // Filtrar SOLO TOTAL_KAM del KAM activo (para KPIs y gráficos agregados)
  const kamDataFiltered = useMemo(() => {
    if (!weeklyData || !kamActive) return []

    return weeklyData.filter(
      w => w.kam_id === kamActive.id && w.brand_name === 'TOTAL_KAM'
    )
  }, [weeklyData, kamActive])

  // Filtrar brands reales (no el agregado) del KAM activo, para cruzar
  // orders/markdown por brand en las tablas de top/bottom
  const kamBrandRows = useMemo(() => {
    if (!weeklyData || !kamActive) return []

    return weeklyData.filter(
      w => w.kam_id === kamActive.id && w.brand_name !== 'TOTAL_KAM'
    )
  }, [weeklyData, kamActive])

  // Nombres únicos de brands (aliados) del KAM activo, para el selector de
  // Accionables — se toma de todas las semanas, no solo la última, para no
  // perder de vista un aliado con el que se quiera dejar un accionable
  // aunque esa semana puntual no haya tenido datos
  const kamBrandNames = useMemo(() => {
    return [...new Set(kamBrandRows.map(b => b.brand_name).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'es')
    )
  }, [kamBrandRows])

  // Calcular métricas por semana
  const weeklyMetrics = useMemo(() => {
    const grouped = {}
    
    kamDataFiltered.forEach(item => {
      const week = item.semana_fecha?.trim()
      if (!grouped[week]) {
        grouped[week] = {
          semana: week,
          orders: 0,
          markdown: 0,
          trafico: 0,
        }
      }
      grouped[week].orders += item.orders || 0
      grouped[week].markdown += (item.markdown || 0)
      grouped[week].trafico += item.trafico || 0
    })

    return Object.values(grouped)
      .sort((a, b) => compareWeekLabels(a.semana, b.semana))
  }, [kamDataFiltered])

  // Últimas 8 semanas (independiente de las fechas seleccionadas para comparar),
  // con el % de crecimiento de orders y markdown de cada semana vs. la anterior
  // para mostrar en los gráficos
  const last8WeeksMetrics = useMemo(() => {
    return weeklyMetrics.slice(-8).map(week => {
      const idx = weeklyMetrics.findIndex(w => w.semana === week.semana)
      const prevWeek = idx > 0 ? weeklyMetrics[idx - 1] : null
      const growthPct = prevWeek && prevWeek.orders > 0
        ? ((week.orders - prevWeek.orders) / prevWeek.orders) * 100
        : null
      const mdGrowthPct = prevWeek && prevWeek.markdown > 0
        ? ((week.markdown - prevWeek.markdown) / prevWeek.markdown) * 100
        : null
      const trafficGrowthPct = prevWeek && prevWeek.trafico > 0
        ? ((week.trafico - prevWeek.trafico) / prevWeek.trafico) * 100
        : null
      return { ...week, growthPct, mdGrowthPct, trafficGrowthPct }
    })
  }, [weeklyMetrics])

  // % de diferencia de la última semana cerrada vs. la anterior (orders)
  const lastWeekVsPrev = useMemo(() => {
    if (weeklyMetrics.length < 2) return null
    const [prev, last] = weeklyMetrics.slice(-2)
    const diffOrders = last.orders - prev.orders
    const pct = prev.orders > 0 ? (diffOrders / prev.orders) * 100 : 0
    return { prev, last, diffOrders, pct }
  }, [weeklyMetrics])

  // % de diferencia de la última semana cerrada vs. la anterior (markdown)
  const lastMdVsPrev = useMemo(() => {
    if (weeklyMetrics.length < 2) return null
    const [prev, last] = weeklyMetrics.slice(-2)
    const diffMarkdown = last.markdown - prev.markdown
    const pct = prev.markdown > 0 ? (diffMarkdown / prev.markdown) * 100 : 0
    return { prev, last, diffMarkdown, pct }
  }, [weeklyMetrics])

  // % de diferencia de la última semana cerrada vs. la anterior (tráfico)
  const lastTrafficVsPrev = useMemo(() => {
    if (weeklyMetrics.length < 2) return null
    const [prev, last] = weeklyMetrics.slice(-2)
    const diffTrafico = last.trafico - prev.trafico
    const pct = prev.trafico > 0 ? (diffTrafico / prev.trafico) * 100 : 0
    return { prev, last, diffTrafico, pct }
  }, [weeklyMetrics])

  // Minuta semanal: conversión (orders/tráfico) de la última semana cerrada vs.
  // la anterior, para poder decir si lo que cambió fue visibilidad o conversión
  const conversionMinuta = useMemo(() => {
    if (weeklyMetrics.length < 2) return null
    const [prev, last] = weeklyMetrics.slice(-2)
    const conversionLast = last.trafico > 0 ? (last.orders / last.trafico) * 100 : null
    const conversionPrev = prev.trafico > 0 ? (prev.orders / prev.trafico) * 100 : null
    const conversionDiff = (conversionLast !== null && conversionPrev !== null)
      ? conversionLast - conversionPrev
      : null
    return { prev, last, conversionLast, conversionPrev, conversionDiff }
  }, [weeklyMetrics])

  // Última semana cerrada del KAM activo (reemplaza al viejo selector manual de fechas)
  const latestWeek = weeklyMetrics[weeklyMetrics.length - 1] || null

  // Semanas disponibles (de más nueva a más vieja), para el historial de Accionables
  const availableWeeks = useMemo(() => {
    return [...weeklyMetrics].map((w) => w.semana).reverse()
  }, [weeklyMetrics])

  // Brands reales del KAM activo en esa última semana
  const latestWeekBrands = useMemo(() => {
    if (!latestWeek) return []
    return kamBrandRows.filter(b => b.semana_fecha?.trim() === latestWeek.semana)
  }, [kamBrandRows, latestWeek])

  // Semana anterior a la última cerrada (LW), para cruzar cada brand semana vs. semana
  const prevWeek = weeklyMetrics.length >= 2 ? weeklyMetrics[weeklyMetrics.length - 2] : null

  // Por cada brand de la última semana, cruzamos su markdown y orders contra LW
  // (se cruza por brand_id, que es estable semana a semana). Sólo entran brands
  // que también tenían datos en LW, para poder calcular el % de variación.
  const brandsWowMarkdown = useMemo(() => {
    if (!latestWeek || !prevWeek) return []

    const prevRows = kamBrandRows.filter(b => b.semana_fecha?.trim() === prevWeek.semana)
    const prevByBrandId = new Map(prevRows.map(b => [b.brand_id, b]))

    return latestWeekBrands
      .map(row => {
        const prev = prevByBrandId.get(row.brand_id)
        if (!prev || !(prev.markdown > 0)) return null
        return {
          brand_id: row.brand_id,
          brand_name: row.brand_name,
          categoria: row.categoria,
          markdown: row.markdown,
          markdownDiffPct: ((row.markdown - prev.markdown) / prev.markdown) * 100,
          orders: row.orders || 0,
          ordersLW: prev.orders || 0,
          ordersDiff: (row.orders || 0) - (prev.orders || 0),
          trafico: row.trafico || 0,
          traficoLW: prev.trafico || 0,
          traficoDiff: (row.trafico || 0) - (prev.trafico || 0),
        }
      })
      .filter(Boolean)
  }, [kamBrandRows, latestWeek, prevWeek, latestWeekBrands])

  // Top 10: las que MÁS subieron el markdown vs. LW. Guardamos el "rank" (el
  // puesto según la suba de markdown, que es el criterio que arma esta lista)
  // separado del orden de renderizado, para que el puesto no cambie cuando se
  // ordena la tabla por otra columna (Orders, Tráfico, etc.)
  const topBrands = useMemo(() => {
    return [...brandsWowMarkdown]
      .sort((a, b) => b.markdownDiffPct - a.markdownDiffPct)
      .slice(0, 10)
      .map((b, idx) => ({ ...b, rank: idx + 1 }))
  }, [brandsWowMarkdown])

  // Bottom 10: las que MÁS bajaron el markdown vs. LW
  const bottomBrands = useMemo(() => {
    return [...brandsWowMarkdown]
      .sort((a, b) => a.markdownDiffPct - b.markdownDiffPct)
      .slice(0, 10)
      .map((b, idx) => ({ ...b, rank: idx + 1 }))
  }, [brandsWowMarkdown])

  // Vistas ordenadas por columna (ver SortableTh) — el orden de estas es el
  // que se renderiza en la tabla; topBrands/bottomBrands/middleBrands siguen
  // siendo el orden "natural" (por variación de markdown / por orders)
  const sortedTopBrands = useMemo(() => sortBrandRows(topBrands, topSort), [topBrands, topSort])
  const sortedBottomBrands = useMemo(() => sortBrandRows(bottomBrands, bottomSort), [bottomBrands, bottomSort])

  // Middle: el resto de la cartera de la última semana — todo lo que NO entra
  // en el Top 10 ni en el Bottom 10 de variación de markdown. Incluye también
  // a los aliados que ni siquiera tienen markdown en LW para comparar (por
  // eso no aparecen en brandsWowMarkdown/top/bottom), usando la misma
  // ventana de 8 semanas del resto del dashboard, no una ventana reducida.
  const middleBrands = useMemo(() => {
    if (!latestWeek) return []

    const prevRows = prevWeek ? kamBrandRows.filter(b => b.semana_fecha?.trim() === prevWeek.semana) : []
    const prevByBrandId = new Map(prevRows.map(b => [b.brand_id, b]))
    const topBottomKeys = new Set(
      [...topBrands, ...bottomBrands].map(b => b.brand_id || b.brand_name)
    )

    return latestWeekBrands
      .filter(row => !topBottomKeys.has(row.brand_id || row.brand_name))
      .map(row => {
        const prev = prevByBrandId.get(row.brand_id) || null
        const hasPrevMarkdown = prev && prev.markdown > 0
        return {
          brand_id: row.brand_id,
          brand_name: row.brand_name,
          categoria: row.categoria,
          markdown: row.markdown || 0,
          markdownDiffPct: hasPrevMarkdown ? ((row.markdown - prev.markdown) / prev.markdown) * 100 : null,
          orders: row.orders || 0,
          ordersLW: prev ? (prev.orders || 0) : null,
          ordersDiff: prev ? (row.orders || 0) - (prev.orders || 0) : null,
          trafico: row.trafico || 0,
          traficoLW: prev ? (prev.trafico || 0) : null,
          traficoDiff: prev ? (row.trafico || 0) - (prev.trafico || 0) : null,
        }
      })
      .sort((a, b) => b.orders - a.orders)
  }, [latestWeek, latestWeekBrands, kamBrandRows, prevWeek, topBrands, bottomBrands])

  const sortedMiddleBrands = useMemo(() => sortBrandRows(middleBrands, middleSort), [middleBrands, middleSort])

  // Historial de las últimas 8 semanas de la brand sobre la que está el cursor
  const hoverBrandHistory = useMemo(() => {
    if (!hoverBrand) return []
    return kamBrandRows
      // Descarta labels de semana viejos/con otro formato (ej. "01–19 Jun") que
      // no pertenecen a la ventana actual de 8 semanas del sheet
      .filter(b => b.brand_id === hoverBrand.brand_id && parseWeekLabel(b.semana_fecha) !== null)
      .sort((a, b) => compareWeekLabels(a.semana_fecha, b.semana_fecha))
      .slice(-8)
  }, [kamBrandRows, hoverBrand])

  const showBrandHover = (brand, e) => {
    if (hoverHideTimeout.current) {
      clearTimeout(hoverHideTimeout.current)
      hoverHideTimeout.current = null
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const POPOVER_WIDTH = 340
    setHoverPos({
      top: rect.bottom + 8,
      left: Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 16),
    })
    setHoverBrand(brand)
  }

  const scheduleHideBrandHover = () => {
    hoverHideTimeout.current = setTimeout(() => setHoverBrand(null), 150)
  }

  const cancelHideBrandHover = () => {
    if (hoverHideTimeout.current) {
      clearTimeout(hoverHideTimeout.current)
      hoverHideTimeout.current = null
    }
  }

  // Ficha del KAM activo: nombre, provincia y cantidad de brands en la última semana
  const activeKamInfo = useMemo(() => {
    if (!kamActive) return null
    return {
      nombre: kamActive.nombre,
      region: kamActive.region,
      brandCount: new Set(latestWeekBrands.map(b => b.brand_name)).size,
    }
  }, [kamActive, latestWeekBrands])

  // Resumen Ejecutivo: junta todo lo que ya se calculó arriba (órdenes/markdown/
  // tráfico/conversión WoW, minuta en texto, Brands with Markdown, Accionar
  // Urgente y top/bottom 5) en un solo objeto para renderizar la tarjeta
  // exportable. No agrega ningún fetch nuevo — es puramente una recombinación
  // de datos que el resto del dashboard ya tiene calculados, para que la
  // imagen exportada alcance para analizar la semana sin volver al dashboard.
  const resumenEjecutivo = useMemo(() => {
    if (!activeKamInfo || !latestWeek) return null
    return {
      kam: activeKamInfo,
      semana: latestWeek.semana,
      semanaAnterior: conversionMinuta?.prev?.semana || null,
      orders: { value: latestWeek.orders, diff: lastWeekVsPrev },
      markdown: { value: latestWeek.markdown, diff: lastMdVsPrev },
      trafico: { value: latestWeek.trafico, diff: lastTrafficVsPrev },
      conversion: conversionMinuta && conversionMinuta.conversionLast !== null
        ? { value: conversionMinuta.conversionLast, diff: conversionMinuta.conversionDiff }
        : null,
      minutaText: conversionMinuta ? buildMinutaText(conversionMinuta) : null,
      brandMd: brandMdStatus && brandMdCalc ? { status: brandMdStatus, calc: brandMdCalc } : null,
      mdTargetText: (brandMdStatus && brandMdCalc)
        ? buildMdTargetMinutaText(activeKamInfo.nombre, brandMdStatus.brands_md_result, brandMdStatus.brands_md_target, mdGoalPct, brandMdCalc)
        : null,
      urgentBrands: { total: urgentBrands.length, top: urgentBrands.slice(0, 5) },
      topSubas: topBrands.slice(0, 5),
      topBajas: bottomBrands.slice(0, 5),
    }
  }, [activeKamInfo, latestWeek, lastWeekVsPrev, lastMdVsPrev, lastTrafficVsPrev, conversionMinuta, brandMdStatus, brandMdCalc, mdGoalPct, urgentBrands, topBrands, bottomBrands])

  // Exportar Resumen Ejecutivo: abre un modal con la tarjeta y la convierte a
  // PNG con html-to-image (recorta el DOM del ref a una imagen). El botón "Abrir
  // en Canva" queda documentado pero deshabilitado hasta tener credenciales de
  // la Canva Developer App (ver nota en el modal) — no se puede autofillear un
  // diseño de Canva sin una integración OAuth registrada del lado de Canva.
  const [showResumenModal, setShowResumenModal] = useState(false)
  const [resumenExportStatus, setResumenExportStatus] = useState(null)
  const [resumenDocStatus, setResumenDocStatus] = useState(null)
  const resumenCardRef = useRef(null)

  const handleDownloadResumenPng = useCallback(async () => {
    if (!resumenCardRef.current) return
    setResumenExportStatus('loading')
    try {
      const dataUrl = await toPng(resumenCardRef.current, { pixelRatio: 2, backgroundColor: '#1E1E1E' })
      const link = document.createElement('a')
      const fileKam = (kamActive?.nombre || 'kam').toLowerCase().replace(/\s+/g, '-')
      link.download = `resumen-ejecutivo-${fileKam}-${latestWeek?.semana || ''}.png`.replace(/\s+/g, '')
      link.href = dataUrl
      link.click()
      setResumenExportStatus(null)
    } catch (err) {
      console.error('❌ Error exportando resumen a PNG:', err)
      setResumenExportStatus('error')
    }
  }, [kamActive, latestWeek])

  // Copiar para Doc: arma el mismo contenido de la tarjeta como HTML
  // formateado (negrita/colores/viñetas) + texto plano de respaldo, y lo
  // manda al portapapeles — Google Docs lo interpreta al pegar (Ctrl+V).
  // Queda pendiente conectar esto directo a la API de Docs (vía OAuth con
  // la cuenta @rappi.com) más adelante; por ahora el paso de pegar es manual
  // porque el Workspace de Rappi bloquea compartir el Doc con el service
  // account externo que usa el resto de la app.
  const handleCopyResumenForDoc = useCallback(async () => {
    if (!resumenEjecutivo) return
    setResumenDocStatus('loading')
    try {
      const { html, text } = buildResumenClipboardContent(resumenEjecutivo)
      if (navigator.clipboard && typeof window.ClipboardItem === 'function') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([text], { type: 'text/plain' }),
          }),
        ])
      } else {
        await navigator.clipboard.writeText(text)
      }
      setResumenDocStatus({ type: 'success', message: '✅ Copiado — pegalo en tu Doc con Ctrl+V.' })
    } catch (err) {
      console.error('❌ Error copiando el resumen:', err)
      setResumenDocStatus({ type: 'error', message: 'No se pudo copiar. Probá de nuevo.' })
    }
  }, [resumenEjecutivo])

  return (
    <div className="w-full">
      {/* RANKING: posición de cada KAM según % de Brands with Markdown cumplido,
          no depende del KAM ni de la pestaña que se esté mirando — se recalcula
          en cada actualización de datos (import de Excel / refetch periódico).
          Va arriba de todo, pero NO queda pegado (sticky) al scrollear. */}
      {kams?.length > 0 && (
        <div className="ranking-card fade-in">
          <div className="table-header-row">
            <div className="ranking-title">🏅 Rankings Markdown</div>
          </div>

          {/* Importar Excel / Importar Compensation viven lógicamente acá (y no
              en Brands with Markdown) porque cruzan el archivo entero contra
              todos los KAMs de una, no son una acción por KAM individual — pero
              se portan (React portal) al header, a la izquierda del logo de
              Rappi, en vez de renderizarse en el ranking. */}
          {importActionsHost && createPortal(
            <div className="md-import">
              <input
                ref={mdImportInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleMdImportFile}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                className="md-import-btn"
                onClick={handleMdImportClick}
                disabled={mdImportStatus?.type === 'loading'}
              >
                📥 Importar Excel
              </button>
              {/* Importar Compensation alimenta Accionar Urgente: trae el % de
                  "MD archie final" por aliado (no por KAM), cruzado igual que
                  el resto por email de Comercial. */}
              <input
                ref={compensationImportInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleCompensationImportFile}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                className="md-import-btn"
                onClick={handleCompensationImportClick}
                disabled={compensationImportStatus?.type === 'loading'}
              >
                📥 Importar Compensation
              </button>
            </div>,
            importActionsHost
          )}

          {mdImportStatus && (
            <div className={`md-import-status md-import-status-${mdImportStatus.type}`}>
              {mdImportStatus.message}
            </div>
          )}
          {compensationImportStatus && (
            <div className={`md-import-status md-import-status-${compensationImportStatus.type}`}>
              {compensationImportStatus.message}
            </div>
          )}

          {kamsRanking.length > 0 ? (
            <div className="ranking-list">
              {kamsRanking.map((k) => {
                const { color, label } = mdStatusFor(k.achievedPct)
                const kamIdx = kams.findIndex((kam) => kam.id === k.id)
                const isActive = kamActive?.id === k.id
                return (
                  <button
                    key={k.id}
                    type="button"
                    className={`ranking-row ${isActive ? 'active' : ''}`}
                    onClick={() => kamIdx !== -1 && setActiveKam(kamIdx)}
                    title={label}
                  >
                    <span className="ranking-position">#{k.rank}</span>
                    <span className="ranking-name">{k.nombre}</span>
                    <span className="ranking-pct" style={{ color }}>{k.achievedPct.toFixed(1)}%</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="no-data">Todavía no hay datos de Brands with Markdown importados — usá "Importar Excel" para cargarlos.</div>
          )}
        </div>
      )}

      {/* ALERTA GENERAL (todos los KAMs): brands que tenían markdown activo en
          la primera quincena del mes pasado y hoy están en 0%. No depende del
          KAM ni de la pestaña seleccionada. */}
      {/* El botón en sí vive en el header (portado a #header-alert-actions,
          esquina superior derecha) — acá solo se arma el contenido que porta
          y el modal que abre al hacer click. */}
      {alertActionsHost && mdDropAlert && createPortal(
        <button
          type="button"
          className="header-alert-btn"
          onClick={() => setShowMdDropModal(true)}
          title={`Brands caídas a 0% de Markdown (${mdDropAlert.totalBrands})`}
        >
          🚨
          <span className="header-alert-badge">{mdDropAlert.totalBrands}</span>
        </button>,
        alertActionsHost
      )}

      {showMdDropModal && mdDropAlert && (
        <div className="resumen-modal-overlay" onClick={() => setShowMdDropModal(false)}>
          <div className="md-drop-modal" onClick={(e) => e.stopPropagation()}>
            <div className="resumen-modal-header">
              <div className="resumen-modal-title">🚨 Brands caídas a 0% de Markdown</div>
              <button type="button" className="resumen-modal-close" onClick={() => setShowMdDropModal(false)}>✕</button>
            </div>

            <div className="table-subtitle">
              Compara el promedio de la primera quincena de {mdDropAlert.mesLabel} ({mdDropAlert.baselineWeeks.join(' y ')})
              {' '}contra la semana del {mdDropAlert.currentWeek} — {mdDropAlert.totalBrands} brand{mdDropAlert.totalBrands === 1 ? '' : 's'} en {mdDropAlert.kamGroups.length} KAM{mdDropAlert.kamGroups.length === 1 ? '' : 's'} tenían markdown activo y hoy están en 0%.
            </div>

            {mdDropAlert.kamGroups.map(({ kam, brands }) => {
              const expanded = expandedDropKams.has(kam.id)
              return (
                <div key={kam.id} className="md-drop-kam-group">
                  <div className="md-drop-kam-header">
                    <button
                      type="button"
                      className="md-drop-kam-toggle"
                      onClick={() => toggleDropKam(kam.id)}
                    >
                      <span className="md-drop-kam-arrow">{expanded ? '▾' : '▸'}</span>
                      <span className="md-drop-kam-name">{kam.nombre}</span>
                      <span className="md-drop-kam-region">Kam de {kam.region}</span>
                    </button>
                    <span className="md-drop-kam-count">{brands.length} brand{brands.length === 1 ? '' : 's'}</span>
                    <button
                      type="button"
                      className="md-drop-kam-export-btn"
                      onClick={() => { setDropExportStatus(null); setDropExportTarget({ kam, brands }) }}
                      title="Exportar la situación de este KAM como JPEG para mandar al equipo"
                    >
                      📷 JPEG
                    </button>
                  </div>

                  {expanded && (
                    <div className="table-container">
                      <table className="table">
                        <thead>
                          <tr>
                            <th rowSpan={2}>Aliado</th>
                            <th colSpan={3}>{mdDropAlert.mesLabel} (1ra quincena)</th>
                            <th colSpan={3}>Hoy ({mdDropAlert.currentWeek})</th>
                          </tr>
                          <tr>
                            <th>Markdown</th>
                            <th>Órdenes</th>
                            <th>Tráfico</th>
                            <th>Markdown</th>
                            <th>Órdenes</th>
                            <th>Tráfico</th>
                          </tr>
                        </thead>
                        <tbody>
                          {brands.map((b) => (
                            <tr key={b.brand_name}>
                              <td><strong>{b.brand_name}</strong></td>
                              <td>{b.baseline.markdown.toFixed(2)}%</td>
                              <td>{b.baseline.orders.toLocaleString()}</td>
                              <td>{b.baseline.trafico.toLocaleString()}</td>
                              <td style={{ color: 'var(--danger)', fontWeight: 700 }}>{b.current.markdown.toFixed(2)}%</td>
                              <td>{b.foundToday ? b.current.orders.toLocaleString() : '—'}</td>
                              <td>{b.foundToday ? b.current.trafico.toLocaleString() : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}

            {/* Resumen total: suma de órdenes y tráfico de TODOS los KAMs
                juntos, para dimensionar el impacto combinado de la caída. */}
            <div className="md-drop-totals">
              <div className="md-drop-totals-title">
                📊 Total combinado — {mdDropAlert.totalBrands} brand{mdDropAlert.totalBrands === 1 ? '' : 's'} en {mdDropAlert.kamGroups.length} KAM{mdDropAlert.kamGroups.length === 1 ? '' : 's'}
              </div>
              <div className="md-drop-totals-row">
                <div className="md-drop-totals-stat">
                  <div className="md-drop-totals-label">Órdenes — {mdDropAlert.mesLabel} (1ra quincena)</div>
                  <div className="md-drop-totals-value">{mdDropAlert.totals.baselineOrders.toLocaleString()}</div>
                </div>
                <div className="md-drop-totals-stat">
                  <div className="md-drop-totals-label">Órdenes — Hoy ({mdDropAlert.currentWeek})</div>
                  <div className="md-drop-totals-value danger">{mdDropAlert.totals.currentOrders.toLocaleString()}</div>
                </div>
                <div className="md-drop-totals-stat">
                  <div className="md-drop-totals-label">Tráfico — {mdDropAlert.mesLabel} (1ra quincena)</div>
                  <div className="md-drop-totals-value">{mdDropAlert.totals.baselineTrafico.toLocaleString()}</div>
                </div>
                <div className="md-drop-totals-stat">
                  <div className="md-drop-totals-label">Tráfico — Hoy ({mdDropAlert.currentWeek})</div>
                  <div className="md-drop-totals-value danger">{mdDropAlert.totals.currentTrafico.toLocaleString()}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de exportación JPEG de la situación de un KAM (alerta de brands
          caídas a 0%) — mismo patrón que el modal de Resumen Ejecutivo:
          tarjeta standalone capturable con html-to-image (toJpeg). */}
      {dropExportTarget && mdDropAlert && (
        <div className="resumen-modal-overlay" onClick={() => setDropExportTarget(null)}>
          <div className="resumen-modal" onClick={(e) => e.stopPropagation()}>
            <div className="resumen-modal-header">
              <div className="resumen-modal-title">📷 Exportar situación — {dropExportTarget.kam.nombre}</div>
              <button type="button" className="resumen-modal-close" onClick={() => setDropExportTarget(null)}>✕</button>
            </div>

            <div className="resumen-card" ref={dropExportCardRef}>
              <div className={`resumen-card-header ${poppins.className}`}>
                <div className="resumen-card-brand">🚨 Rappi · Brands caídas a 0% de Markdown</div>
                <div className="resumen-card-kam">{dropExportTarget.kam.nombre}</div>
                <div className="resumen-card-meta">
                  Kam de {dropExportTarget.kam.region} · {dropExportTarget.brands.length} brand{dropExportTarget.brands.length === 1 ? '' : 's'}
                  {' '}· {mdDropAlert.mesLabel} (1ra quincena) vs. {mdDropAlert.currentWeek}
                </div>
              </div>

              <div className="md-drop-export-list">
                {dropExportTarget.brands.map((b) => (
                  <div key={b.brand_name} className="md-drop-export-line">
                    <div className="md-drop-export-brand">{b.brand_name}</div>
                    <div className="md-drop-export-metrics">
                      <span>MD: {b.baseline.markdown.toFixed(1)}% → <strong style={{ color: 'var(--danger)' }}>0%</strong></span>
                      <span>Órdenes: {b.baseline.orders.toLocaleString()} → {b.foundToday ? b.current.orders.toLocaleString() : '—'}</span>
                      <span>Tráfico: {b.baseline.trafico.toLocaleString()} → {b.foundToday ? b.current.trafico.toLocaleString() : '—'}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="resumen-card-footer">
                Generado el {new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' })} · Dashboard KAMs Semanal
              </div>
            </div>

            <div className="resumen-modal-actions">
              <button
                type="button"
                className="resumen-download-btn"
                onClick={handleDownloadDropJpeg}
                disabled={dropExportStatus === 'loading'}
              >
                {dropExportStatus === 'loading' ? 'Generando...' : '⬇️ Descargar JPEG'}
              </button>
            </div>
            {dropExportStatus === 'error' && (
              <div className="resumen-export-error">No se pudo generar la imagen. Probá de nuevo.</div>
            )}
          </div>
        </div>
      )}

      {/* KAM TABS */}
      <div className="tabs-wrapper fade-in">
        <div className="tabs">
          {kams?.map((kam, idx) => (
            <button
              key={kam.id}
              onClick={() => setActiveKam(idx)}
              className={`tab ${activeKam === idx ? 'active' : ''}`}
            >
              {kam.nombre}
            </button>
          ))}
        </div>
      </div>

      {/* FICHA DEL KAM ACTIVO */}
      {activeKamInfo && (
        <div className="filter-section fade-in kam-info-card">
          <div className="kam-info-text">
            <strong>{activeKamInfo.nombre}</strong> - Kam de {activeKamInfo.region} - {activeKamInfo.brandCount} brands
          </div>
          {resumenEjecutivo && (
            <button
              type="button"
              className="export-resumen-btn"
              onClick={() => { setResumenDocStatus(null); setShowResumenModal(true) }}
            >
              📤 Exportar Resumen
            </button>
          )}
        </div>
      )}

      {/* BRANDS WITH MARKDOWN: Brands w/MD Result/Target del KAM activo, contra
          un umbral seleccionable, con minuta */}
      <div className="table-card fade-in">
        <div className="table-title">Brands with Markdown</div>
        <p className="table-subtitle">
          Compara, para este KAM, cuántas brands de su cartera tienen markdown activo (Brands In) contra la cantidad objetivo (Markdown Target), y qué % de ese objetivo ya cumplió. Elegí un umbral para ver cuántas brands le faltan — o le sobran — para llegar a ese nivel. Actualizá los números con el botón "Importar Excel" del ranking de arriba: lee el archivo de comisiones, identifica las columnas de Comercial, Brands w/MD Result y Brands w/MD Target, y cruza cada fila con el KAM correspondiente por email.
        </p>

        {!brandMdStatus ? (
          <div className="no-data">Todavía no hay datos de Brands with Markdown cargados para este KAM.</div>
        ) : (
          <>
            <div className="md-target-layout">
              <div className="md-target-circle">
                <CircularProgress pct={brandMdCalc.achievedPct} />
                <div className="md-target-circle-label">Markdown cumplido</div>
              </div>

              <div className="md-target-stats">
                <div className="md-target-stat">
                  <div className="md-target-stat-label">Brands In</div>
                  <div className="md-target-stat-value">{brandMdStatus.brands_md_result}</div>
                </div>
                <div className="md-target-stat">
                  <div className="md-target-stat-label">Markdown Target</div>
                  <div className="md-target-stat-value">{brandMdStatus.brands_md_target}</div>
                </div>
                <div className="md-target-stat">
                  <div className="md-target-stat-label">
                    Faltan para
                    <select
                      value={mdGoalPct}
                      onChange={(e) => setMdGoalPct(Number(e.target.value))}
                      className="md-goal-select"
                    >
                      {MD_TARGET_GOAL_OPTIONS.map((p) => (
                        <option key={p} value={p}>{p}%</option>
                      ))}
                    </select>
                  </div>
                  <div className="md-target-stat-value">
                    {brandMdCalc.met ? (
                      <span className="md-target-met">
                        ✓ Cumplido{brandMdCalc.surplus > 0 ? ` (+${brandMdCalc.surplus})` : ''}
                      </span>
                    ) : (
                      <>
                        {brandMdCalc.missing} <span className="md-target-stat-unit">brand{brandMdCalc.missing === 1 ? '' : 's'}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <p className="md-target-minuta">
              {buildMdTargetMinutaText(kamActive?.nombre, brandMdStatus.brands_md_result, brandMdStatus.brands_md_target, mdGoalPct, brandMdCalc)}
            </p>
          </>
        )}
      </div>

      {/* 8LW: 3 tarjetas unificadas (Órdenes, Markdown, Tráfico) una a la par de la
          otra, cada una con su gráfico + diferencial juntos y su descripción
          centrada arriba */}
      {(last8WeeksMetrics.length > 0 || lastWeekVsPrev || lastMdVsPrev || lastTrafficVsPrev) && (
        <div className="trend-columns fade-in">
          {/* ÓRDENES */}
          <div className="trend-col">
            <div className="trend-description-card">
              <div className="trend-description-title">📦 Órdenes — últimas 8 semanas</div>
              <div className="trend-description-text">
                Cantidad de órdenes generadas por la cartera de este KAM, semana a semana, con el % de crecimiento o caída de la última semana cerrada contra la anterior.
              </div>
            </div>
            <div className="trend-card-unified">
              <div className="trend-chart-col">
                <div className="chart-title">📦 8LW</div>
                <div className="trend-card-container">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={last8WeeksMetrics} margin={{ top: 16, right: 2, left: 2, bottom: 0 }}>
                      <XAxis dataKey="semana" stroke="#B0B0B0" fontSize={8} tickLine={false} axisLine={{ stroke: '#2A2A2A' }} />
                      <YAxis hide domain={[0, (max) => max * 1.12]} />
                      <Bar dataKey="orders" fill="#FF5252" radius={[4, 4, 0, 0]} maxBarSize={18}>
                        <LabelList dataKey="growthPct" content={GrowthLabel} />
                        <LabelList dataKey="orders" content={OrdersLabel} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              {lastWeekVsPrev && (
                <div className={`trend-diff-col ${poppins.className}`}>
                  <div className={`diff-percent ${lastWeekVsPrev.pct < 0 ? 'negative' : 'positive'}`}>
                    {lastWeekVsPrev.pct > 0 ? '+' : ''}{lastWeekVsPrev.pct.toFixed(1)}%
                  </div>
                  <div className="diff-orders">
                    {lastWeekVsPrev.diffOrders > 0 ? '+' : ''}{lastWeekVsPrev.diffOrders.toLocaleString()} órdenes vs. {lastWeekVsPrev.prev.semana}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* MARKDOWN */}
          <div className="trend-col">
            <div className="trend-description-card">
              <div className="trend-description-title">📊 Markdown — últimas 8 semanas</div>
              <div className="trend-description-text">
                Markdown promedio (descuento invertido sobre el GMV) de la cartera, semana a semana, con el diferencial en puntos porcentuales de la última semana cerrada contra la anterior.
              </div>
            </div>
            <div className="trend-card-unified">
              <div className="trend-chart-col">
                <div className="chart-title">📊 8LW MD/GMV</div>
                <div className="trend-card-container">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={last8WeeksMetrics} margin={{ top: 16, right: 2, left: 2, bottom: 0 }}>
                      <XAxis dataKey="semana" stroke="#B0B0B0" fontSize={8} tickLine={false} axisLine={{ stroke: '#2A2A2A' }} />
                      <YAxis hide domain={[0, (max) => max * 1.12]} />
                      <Bar dataKey="markdown" fill="#FFC107" radius={[4, 4, 0, 0]} maxBarSize={18}>
                        <LabelList dataKey="mdGrowthPct" content={GrowthLabel} />
                        <LabelList dataKey="markdown" content={MarkdownLabel} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              {lastMdVsPrev && (
                <div className={`trend-diff-col ${poppins.className}`}>
                  <div className={`diff-percent ${lastMdVsPrev.pct < 0 ? 'negative' : 'positive'}`}>
                    {lastMdVsPrev.pct > 0 ? '+' : ''}{lastMdVsPrev.pct.toFixed(1)}%
                  </div>
                  <div className="diff-orders">
                    {lastMdVsPrev.diffMarkdown > 0 ? '+' : ''}{lastMdVsPrev.diffMarkdown.toFixed(2)} p.p. vs. {lastMdVsPrev.prev.semana}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* TRÁFICO */}
          <div className="trend-col">
            <div className="trend-description-card">
              <div className="trend-description-title">📶 Tráfico — últimas 8 semanas</div>
              <div className="trend-description-text">
                Visitas (SS) que recibió la cartera, semana a semana, con la cantidad y el % de crecimiento o caída de tráfico de la última semana cerrada contra la anterior.
              </div>
            </div>
            <div className="trend-card-unified">
              <div className="trend-chart-col">
                <div className="chart-title">📶 8LW Tráfico</div>
                <div className="trend-card-container">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={last8WeeksMetrics} margin={{ top: 16, right: 2, left: 2, bottom: 0 }}>
                      <XAxis dataKey="semana" stroke="#B0B0B0" fontSize={8} tickLine={false} axisLine={{ stroke: '#2A2A2A' }} />
                      <YAxis hide domain={[0, (max) => max * 1.12]} />
                      <Bar dataKey="trafico" fill="#4FC3F7" radius={[4, 4, 0, 0]} maxBarSize={18}>
                        <LabelList dataKey="trafficGrowthPct" content={GrowthLabel} />
                        <LabelList dataKey="trafico" content={TrafficLabel} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              {lastTrafficVsPrev && (
                <div className={`trend-diff-col ${poppins.className}`}>
                  <div className={`diff-percent ${lastTrafficVsPrev.pct < 0 ? 'negative' : 'positive'}`}>
                    {lastTrafficVsPrev.pct > 0 ? '+' : ''}{lastTrafficVsPrev.pct.toFixed(1)}%
                  </div>
                  <div className="diff-orders">
                    {lastTrafficVsPrev.diffTrafico > 0 ? '+' : ''}{lastTrafficVsPrev.diffTrafico.toLocaleString()} tráfico vs. {lastTrafficVsPrev.prev.semana}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MINUTA SEMANAL: cruza órdenes y tráfico de la última semana cerrada para
          calcular la conversión, y compara todo contra la semana anterior */}
      {conversionMinuta && (
        <div className={`minuta-card fade-in ${poppins.className}`}>
          <div className="minuta-header">
            <div className="minuta-title">🗒️ Minuta Semanal</div>
            <div className="minuta-week">{conversionMinuta.last.semana} vs. {conversionMinuta.prev.semana}</div>
          </div>
          <div className="minuta-stats">
            <div className="minuta-stat">
              <div className="minuta-stat-label">📦 Órdenes</div>
              <div className="minuta-stat-value">{conversionMinuta.last.orders.toLocaleString()}</div>
              {lastWeekVsPrev && <DiffCell value={lastWeekVsPrev.pct} decimals={1} suffix="%" />}
            </div>
            <div className="minuta-stat">
              <div className="minuta-stat-label">📶 Tráfico</div>
              <div className="minuta-stat-value">{conversionMinuta.last.trafico.toLocaleString()}</div>
              {lastTrafficVsPrev && <DiffCell value={lastTrafficVsPrev.pct} decimals={1} suffix="%" />}
            </div>
            <div className="minuta-stat">
              <div className="minuta-stat-label">🎯 Conversión (Órdenes/Tráfico)</div>
              <div className="minuta-stat-value">
                {conversionMinuta.conversionLast !== null ? `${conversionMinuta.conversionLast.toFixed(2)}%` : '—'}
              </div>
              {conversionMinuta.conversionDiff !== null && (
                <DiffCell value={conversionMinuta.conversionDiff} decimals={2} suffix=" p.p." />
              )}
            </div>
          </div>
          <p className="minuta-text">{buildMinutaText(conversionMinuta)}</p>
        </div>
      )}

      {/* SUB-TABS: Top and Bottom / Middle / Accionar Urgente / Accionables */}
      <div className="subtabs-wrapper fade-in">
        <button
          className={`subtab ${activeSubTab === 'topbottom' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('topbottom')}
        >
          🏆 Top and Bottom
        </button>
        <button
          className={`subtab ${activeSubTab === 'middle' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('middle')}
        >
          ⚠️ Middle
        </button>
        <button
          className={`subtab ${activeSubTab === 'urgente' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('urgente')}
        >
          🚨 Accionar urgente
        </button>
        <button
          className={`subtab ${activeSubTab === 'accionables' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('accionables')}
        >
          ✅ Accionables
        </button>
      </div>

      {/* DESCRIPCIÓN DE LA PESTAÑA TOP AND BOTTOM */}
      {activeSubTab === 'topbottom' && (
        <div className="trend-description fade-in">
          <span className="trend-description-icon">🏆</span>
          <div>
            <div className="trend-description-title">Top and Bottom — mejores y peores brands en markdown</div>
            <div className="trend-description-text">
              Estos cuadros muestran las 10 brands que más subieron y las 10 que más bajaron su markdown en la última semana cerrada, comparadas contra la semana anterior (LW).
            </div>
          </div>
        </div>
      )}

      {/* TOP 10 BRANDS - MAYOR SUBA DE MARKDOWN VS. LW */}
      {activeSubTab === 'topbottom' && topBrands.length > 0 && (
        <div className="table-card compact fade-in">
          <div className="table-title">🏆 Top 10 - Mayor Suba de Markdown vs. LW</div>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Posición</th>
                  <th>Estado</th>
                  <th>Brand</th>
                  <th>Categoría</th>
                  <SortableTh label="Markdown" sortKey="markdown" sort={topSort} onSort={handleTopSort} />
                  <SortableTh label="Δ MD vs LW" sortKey="markdownDiffPct" sort={topSort} onSort={handleTopSort} />
                  <SortableTh label="Orders LW" sortKey="ordersLW" sort={topSort} onSort={handleTopSort} />
                  <SortableTh label="Orders" sortKey="orders" sort={topSort} onSort={handleTopSort} />
                  <SortableTh label="Δ Orders vs LW" sortKey="ordersDiff" sort={topSort} onSort={handleTopSort} />
                  <SortableTh label="Tráfico LW" sortKey="traficoLW" sort={topSort} onSort={handleTopSort} />
                  <SortableTh label="Tráfico" sortKey="trafico" sort={topSort} onSort={handleTopSort} />
                  <SortableTh label="Δ Tráfico vs LW" sortKey="traficoDiff" sort={topSort} onSort={handleTopSort} />
                </tr>
              </thead>
              <tbody>
                {sortedTopBrands.map((brand, idx) => (
                  <tr
                    key={idx}
                    onMouseEnter={(e) => showBrandHover(brand, e)}
                    onMouseLeave={scheduleHideBrandHover}
                  >
                    <td><strong>#{brand.rank}</strong></td>
                    <td>
                      <BrandStatusSelect
                        brand={brand}
                        status={brandStatusMap[brandKeyOf(brand)]}
                        onChange={updateBrandStatus}
                      />
                    </td>
                    <td><strong>{brand.brand_name}</strong></td>
                    <td>{brand.categoria}</td>
                    <td>{brand.markdown?.toFixed(2)}%</td>
                    <td><DiffCell value={brand.markdownDiffPct} decimals={1} suffix="%" /></td>
                    <td>{brand.ordersLW.toLocaleString()}</td>
                    <td>{brand.orders.toLocaleString()}</td>
                    <td><DiffCell value={brand.ordersDiff} decimals={0} suffix="" /></td>
                    <td>{brand.traficoLW.toLocaleString()}</td>
                    <td>{brand.trafico.toLocaleString()}</td>
                    <td><DiffCell value={brand.traficoDiff} decimals={0} suffix="" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* BOTTOM 10 BRANDS - MAYOR BAJA DE MARKDOWN VS. LW */}
      {activeSubTab === 'topbottom' && bottomBrands.length > 0 && (
        <div className="table-card compact fade-in">
          <div className="table-title">📉 Top 10 - Mayor Baja de Markdown vs. LW</div>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Posición</th>
                  <th>Estado</th>
                  <th>Brand</th>
                  <th>Categoría</th>
                  <SortableTh label="Markdown" sortKey="markdown" sort={bottomSort} onSort={handleBottomSort} />
                  <SortableTh label="Δ MD vs LW" sortKey="markdownDiffPct" sort={bottomSort} onSort={handleBottomSort} />
                  <SortableTh label="Orders LW" sortKey="ordersLW" sort={bottomSort} onSort={handleBottomSort} />
                  <SortableTh label="Orders" sortKey="orders" sort={bottomSort} onSort={handleBottomSort} />
                  <SortableTh label="Δ Orders vs LW" sortKey="ordersDiff" sort={bottomSort} onSort={handleBottomSort} />
                  <SortableTh label="Tráfico LW" sortKey="traficoLW" sort={bottomSort} onSort={handleBottomSort} />
                  <SortableTh label="Tráfico" sortKey="trafico" sort={bottomSort} onSort={handleBottomSort} />
                  <SortableTh label="Δ Tráfico vs LW" sortKey="traficoDiff" sort={bottomSort} onSort={handleBottomSort} />
                </tr>
              </thead>
              <tbody>
                {sortedBottomBrands.map((brand, idx) => (
                  <tr
                    key={idx}
                    onMouseEnter={(e) => showBrandHover(brand, e)}
                    onMouseLeave={scheduleHideBrandHover}
                  >
                    <td><strong>#{brand.rank}</strong></td>
                    <td>
                      <BrandStatusSelect
                        brand={brand}
                        status={brandStatusMap[brandKeyOf(brand)]}
                        onChange={updateBrandStatus}
                      />
                    </td>
                    <td><strong>{brand.brand_name}</strong></td>
                    <td>{brand.categoria}</td>
                    <td>{brand.markdown?.toFixed(2)}%</td>
                    <td><DiffCell value={brand.markdownDiffPct} decimals={1} suffix="%" /></td>
                    <td>{brand.ordersLW.toLocaleString()}</td>
                    <td>{brand.orders.toLocaleString()}</td>
                    <td><DiffCell value={brand.ordersDiff} decimals={0} suffix="" /></td>
                    <td>{brand.traficoLW.toLocaleString()}</td>
                    <td>{brand.trafico.toLocaleString()}</td>
                    <td><DiffCell value={brand.traficoDiff} decimals={0} suffix="" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MIDDLE - ALIADOS SIN NADA DE MARKDOWN EN LAS ÚLTIMAS SEMANAS */}
      {activeSubTab === 'middle' && (
        <>
          <div className="trend-description fade-in">
            <span className="trend-description-icon">⚠️</span>
            <div>
              <div className="trend-description-title">Middle — el resto de la cartera</div>
              <div className="trend-description-text">
                Todos los aliados de la última semana cerrada que NO están entre el Top 10 ni el Bottom 10 de variación de markdown. Acá aparecen tanto los que tuvieron un movimiento de markdown poco relevante como los que no tienen nada de markdown para comparar contra la semana anterior (por eso el "—" en esas columnas). Usa la misma ventana de 8 semanas que el resto del dashboard.
              </div>
            </div>
          </div>

          {middleBrands.length > 0 ? (
            <div className="table-card compact fade-in">
              <div className="table-title">⚠️ Resto de la Cartera (fuera del Top y Bottom 10)</div>
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Estado</th>
                      <th>Brand</th>
                      <th>Categoría</th>
                      <SortableTh label="Markdown" sortKey="markdown" sort={middleSort} onSort={handleMiddleSort} />
                      <SortableTh label="Δ MD vs LW" sortKey="markdownDiffPct" sort={middleSort} onSort={handleMiddleSort} />
                      <SortableTh label="Orders LW" sortKey="ordersLW" sort={middleSort} onSort={handleMiddleSort} />
                      <SortableTh label="Orders" sortKey="orders" sort={middleSort} onSort={handleMiddleSort} />
                      <SortableTh label="Δ Orders vs LW" sortKey="ordersDiff" sort={middleSort} onSort={handleMiddleSort} />
                      <SortableTh label="Tráfico LW" sortKey="traficoLW" sort={middleSort} onSort={handleMiddleSort} />
                      <SortableTh label="Tráfico" sortKey="trafico" sort={middleSort} onSort={handleMiddleSort} />
                      <SortableTh label="Δ Tráfico vs LW" sortKey="traficoDiff" sort={middleSort} onSort={handleMiddleSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMiddleBrands.map((brand, idx) => (
                      <tr
                        key={idx}
                        onMouseEnter={(e) => showBrandHover(brand, e)}
                        onMouseLeave={scheduleHideBrandHover}
                      >
                        <td>
                          <BrandStatusSelect
                            brand={brand}
                            status={brandStatusMap[brandKeyOf(brand)]}
                            onChange={updateBrandStatus}
                          />
                        </td>
                        <td><strong>{brand.brand_name}</strong></td>
                        <td>{brand.categoria}</td>
                        <td>{brand.markdown?.toFixed(2)}%</td>
                        <td><DiffCell value={brand.markdownDiffPct} decimals={1} suffix="%" /></td>
                        <td>{brand.ordersLW !== null ? brand.ordersLW.toLocaleString() : '—'}</td>
                        <td>{brand.orders.toLocaleString()}</td>
                        <td><DiffCell value={brand.ordersDiff} decimals={0} suffix="" /></td>
                        <td>{brand.traficoLW !== null ? brand.traficoLW.toLocaleString() : '—'}</td>
                        <td>{brand.trafico.toLocaleString()}</td>
                        <td><DiffCell value={brand.traficoDiff} decimals={0} suffix="" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="table-card compact fade-in no-data">
              Todos los aliados de esta cartera están en el Top 10 o el Bottom 10 — no queda nadie afuera.
            </div>
          )}
        </>
      )}

      {/* ACCIONAR URGENTE - aliados con % de MD Archie Final entre 70 y 85 (import
          de Compensation, ver botón en el ranking de arriba) */}
      {activeSubTab === 'urgente' && (
        <>
          <div className="trend-description fade-in">
            <span className="trend-description-icon">🚨</span>
            <div>
              <div className="trend-description-title">Accionar Urgente — aliados cerca del target de MD Archie Final</div>
              <div className="trend-description-text">
                Este listado cruza el archivo de Compensation importado con la cartera de este KAM y muestra los aliados con un % de MD Archie Final entre 70% y 85%: los que todavía no llegan al target y están próximos a entrar (por debajo de 80%), y los que ya lo cruzaron pero quedaron al borde, sin margen (entre 80% y 85%). Son los que más urge trabajar para asegurar — o terminar de meter — el cumplimiento.
              </div>
            </div>
          </div>

          {compensationRows.length === 0 ? (
            <div className="table-card compact fade-in no-data">
              Todavía no se importó el archivo de Compensation para este KAM — usá "Importar Compensation" en el ranking de arriba.
            </div>
          ) : urgentBrands.length > 0 ? (
            <div className="table-card compact fade-in">
              <div className="table-title">🚨 Aliados entre 70% y 85% de MD Archie Final</div>
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Aliado</th>
                      <th>% MD Archie Final</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {urgentBrands.map((brand) => {
                      const atEdge = brand.md_archie_final_pct >= URGENT_MD_TARGET_CUT
                      return (
                        <tr key={brand.brand_key}>
                          <td><strong>{brand.brand_name}</strong></td>
                          <td>{brand.md_archie_final_pct.toFixed(1)}%</td>
                          <td>
                            <span className={`urgent-status ${atEdge ? 'edge' : 'below'}`}>
                              {atEdge ? '✅ Al borde del target' : '🔸 Pronto a entrar en target'}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="table-card compact fade-in no-data">
              Ningún aliado de esta cartera está entre 70% y 85% de MD Archie Final.
            </div>
          )}
        </>
      )}

      {/* POSIBLES CASOS - visible en Top and Bottom y en Middle, se oculta en Accionar Urgente y Accionables */}
      {(activeSubTab === 'topbottom' || activeSubTab === 'middle') && (topBrands.length > 0 || bottomBrands.length > 0) && (
        <div className="table-card compact fade-in">
          <div className="table-title">🧩 Posibles Casos</div>
          <p className="table-subtitle">
            Un resumen narrativo de las 3 brands con mayor suba y las 3 con mayor baja de markdown de la última semana: cruza esa variación contra el movimiento de órdenes y tráfico para identificar si el cambio de descuento realmente movió la demanda, o si conviene revisar la promoción.
          </p>
          <div className="insights-grid">
            {topBrands.length > 0 && (
              <div>
                <div className="insights-subtitle">🏆 Top 3 - Mayor suba de markdown</div>
                {topBrands.slice(0, 3).map((brand, idx) => (
                  <div key={idx} className="insight-card">
                    <div className="insight-header">
                      <strong>{brand.brand_name}</strong>
                      <span className="insight-stats">
                        MD {brand.markdown.toFixed(1)}% (<DiffCell value={brand.markdownDiffPct} decimals={1} suffix="%" />) · Orders {brand.orders} vs LW {brand.ordersLW} (<DiffCell value={brand.ordersDiff} decimals={0} suffix="" />) · Tráfico {brand.trafico} vs LW {brand.traficoLW} (<DiffCell value={brand.traficoDiff} decimals={0} suffix="" />)
                      </span>
                    </div>
                    <p className="insight-text">{buildBrandInsight(brand)}</p>
                  </div>
                ))}
              </div>
            )}

            {bottomBrands.length > 0 && (
              <div>
                <div className="insights-subtitle">📉 Top 3 - Mayor baja de markdown</div>
                {bottomBrands.slice(0, 3).map((brand, idx) => (
                  <div key={idx} className="insight-card">
                    <div className="insight-header">
                      <strong>{brand.brand_name}</strong>
                      <span className="insight-stats">
                        MD {brand.markdown.toFixed(1)}% (<DiffCell value={brand.markdownDiffPct} decimals={1} suffix="%" />) · Orders {brand.orders} vs LW {brand.ordersLW} (<DiffCell value={brand.ordersDiff} decimals={0} suffix="" />) · Tráfico {brand.trafico} vs LW {brand.traficoLW} (<DiffCell value={brand.traficoDiff} decimals={0} suffix="" />)
                      </span>
                    </div>
                    <p className="insight-text">{buildBrandInsight(brand)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ACCIONABLES - pestaña dedicada 100% a cargar y hacer seguimiento de accionables */}
      {activeSubTab === 'accionables' && kamActive && (
        <>
          <div className="trend-description fade-in">
            <span className="trend-description-icon">✅</span>
            <div>
              <div className="trend-description-title">Accionables — plan de trabajo por aliado</div>
              <div className="trend-description-text">
                Acá vas registrando, aliado por aliado, qué vas a trabajar (markdown, ADS, Turbo o catálogo) y qué exactamente vas a hacer. Quedan guardados por KAM y podés marcarlos como completados semana a semana desde el historial de abajo.
              </div>
            </div>
          </div>
          <AccionablesPanel
            kamId={kamActive.id}
            currentWeek={latestWeek?.semana}
            availableWeeks={availableWeeks}
            brandOptions={kamBrandNames}
          />
        </>
      )}

      {/* POPOVER: HISTORIAL DE 8 SEMANAS AL PASAR EL CURSOR SOBRE UNA BRAND */}
      {hoverBrand && hoverPos && (
        <div
          className="brand-hover-popover fade-in"
          style={{ top: hoverPos.top, left: hoverPos.left }}
          onMouseEnter={cancelHideBrandHover}
          onMouseLeave={scheduleHideBrandHover}
        >
          <div className="brand-hover-title">{hoverBrand.brand_name}</div>
          <div className="brand-hover-subtitle">{hoverBrand.categoria}</div>
          <div className="brand-hover-table-wrap">
            <table className="brand-hover-table">
              <thead>
                <tr>
                  <th>Semana</th>
                  <th>Orders</th>
                  <th>Markdown</th>
                  <th>Tráfico</th>
                </tr>
              </thead>
              <tbody>
                {hoverBrandHistory.map((week) => (
                  <tr key={week.semana_fecha}>
                    <td>{week.semana_fecha}</td>
                    <td>{(week.orders || 0).toLocaleString()}</td>
                    <td>{(week.markdown || 0).toFixed(2)}%</td>
                    <td>{(week.trafico || 0).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: RESUMEN EJECUTIVO EXPORTABLE — la tarjeta capturada por
          html-to-image vive en resumenCardRef; "Abrir en Canva" queda
          deshabilitado hasta registrar una Canva Developer App (ver nota
          en el botón) porque requiere OAuth por fuera de esta app. */}
      {showResumenModal && resumenEjecutivo && (
        <div className="resumen-modal-overlay" onClick={() => setShowResumenModal(false)}>
          <div className="resumen-modal" onClick={(e) => e.stopPropagation()}>
            <div className="resumen-modal-header">
              <div className="resumen-modal-title">📤 Exportar Resumen Ejecutivo</div>
              <button type="button" className="resumen-modal-close" onClick={() => setShowResumenModal(false)}>✕</button>
            </div>

            <div className="resumen-card" ref={resumenCardRef}>
              <div className={`resumen-card-header ${poppins.className}`}>
                <div className="resumen-card-brand">📊 Rappi · Resumen Semanal</div>
                <div className="resumen-card-kam">{resumenEjecutivo.kam.nombre}</div>
                <div className="resumen-card-meta">
                  Kam de {resumenEjecutivo.kam.region} · {resumenEjecutivo.kam.brandCount} brands
                  {' '}· Semana del {resumenEjecutivo.semana}
                  {resumenEjecutivo.semanaAnterior && ` (vs. ${resumenEjecutivo.semanaAnterior})`}
                </div>
              </div>

              <div className="resumen-stats-row">
                <div className="resumen-stat">
                  <div className="resumen-stat-label">📦 Órdenes</div>
                  <div className="resumen-stat-value">{resumenEjecutivo.orders.value.toLocaleString()}</div>
                  {resumenEjecutivo.orders.diff && <DiffCell value={resumenEjecutivo.orders.diff.pct} decimals={1} suffix="%" />}
                </div>
                <div className="resumen-stat">
                  <div className="resumen-stat-label">📊 Markdown</div>
                  <div className="resumen-stat-value">{resumenEjecutivo.markdown.value.toFixed(1)}%</div>
                  {resumenEjecutivo.markdown.diff && <DiffCell value={resumenEjecutivo.markdown.diff.pct} decimals={1} suffix="%" />}
                </div>
                <div className="resumen-stat">
                  <div className="resumen-stat-label">📶 Tráfico</div>
                  <div className="resumen-stat-value">{resumenEjecutivo.trafico.value.toLocaleString()}</div>
                  {resumenEjecutivo.trafico.diff && <DiffCell value={resumenEjecutivo.trafico.diff.pct} decimals={1} suffix="%" />}
                </div>
                <div className="resumen-stat">
                  <div className="resumen-stat-label">🎯 Conversión</div>
                  <div className="resumen-stat-value">
                    {resumenEjecutivo.conversion ? `${resumenEjecutivo.conversion.value.toFixed(2)}%` : '—'}
                  </div>
                  {resumenEjecutivo.conversion?.diff !== null && resumenEjecutivo.conversion?.diff !== undefined && (
                    <DiffCell value={resumenEjecutivo.conversion.diff} decimals={2} suffix=" p.p." />
                  )}
                </div>
              </div>

              {/* Lectura en texto de la semana (mismo texto que la Minuta Semanal
                  del dashboard) para que la imagen se entienda sola, sin tener
                  que volver a mirar los números de arriba. */}
              {resumenEjecutivo.minutaText && (
                <div className="resumen-insight">📝 {resumenEjecutivo.minutaText}</div>
              )}

              {resumenEjecutivo.brandMd && (
                <div className="resumen-md-row">
                  <div className="resumen-md-label">🎯 Brands with Markdown</div>
                  <div className="resumen-md-value">
                    {resumenEjecutivo.brandMd.status.brands_md_result} / {resumenEjecutivo.brandMd.status.brands_md_target}
                    <span style={{ color: mdStatusFor(resumenEjecutivo.brandMd.calc.achievedPct).color, fontWeight: 700 }}>
                      {' '}({resumenEjecutivo.brandMd.calc.achievedPct.toFixed(1)}% · {mdStatusFor(resumenEjecutivo.brandMd.calc.achievedPct).label})
                    </span>
                  </div>
                  {resumenEjecutivo.mdTargetText && (
                    <div className="resumen-md-text">{resumenEjecutivo.mdTargetText}</div>
                  )}
                </div>
              )}

              {resumenEjecutivo.urgentBrands.total > 0 && (
                <div className="resumen-urgent-row">
                  <div className="resumen-urgent-title">
                    🚨 Accionar Urgente · {resumenEjecutivo.urgentBrands.total} aliado{resumenEjecutivo.urgentBrands.total === 1 ? '' : 's'} cerca del target (70%-85% de MD Archie Final)
                  </div>
                  {resumenEjecutivo.urgentBrands.top.map((r) => (
                    <div key={r.brand_key} className="resumen-urgent-line">
                      <span>{r.brand_name}</span>
                      <span
                        className="resumen-urgent-pct"
                        style={{ color: mdStatusFor(r.md_archie_final_pct).color }}
                      >
                        {r.md_archie_final_pct.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {(resumenEjecutivo.topSubas.length > 0 || resumenEjecutivo.topBajas.length > 0) && (
                <div className="resumen-brands-row">
                  <div className="resumen-brands-col">
                    <div className="resumen-brands-title">🔼 Mayor suba de MD</div>
                    {resumenEjecutivo.topSubas.map((b) => (
                      <div key={b.brand_id || b.brand_name} className="resumen-brand-line">
                        <span>{b.brand_name}</span>
                        <span className="resumen-brand-pct up">+{b.markdownDiffPct.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                  <div className="resumen-brands-col">
                    <div className="resumen-brands-title">🔽 Mayor baja de MD</div>
                    {resumenEjecutivo.topBajas.map((b) => (
                      <div key={b.brand_id || b.brand_name} className="resumen-brand-line">
                        <span>{b.brand_name}</span>
                        <span className="resumen-brand-pct down">{b.markdownDiffPct.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="resumen-card-footer">
                Generado el {new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' })} · Dashboard KAMs Semanal
              </div>
            </div>

            <div className="resumen-modal-actions">
              <button
                type="button"
                className="resumen-download-btn"
                onClick={handleDownloadResumenPng}
                disabled={resumenExportStatus === 'loading'}
              >
                {resumenExportStatus === 'loading' ? 'Generando...' : '⬇️ Descargar PNG'}
              </button>
              <button
                type="button"
                className="resumen-doc-btn"
                onClick={handleCopyResumenForDoc}
                disabled={resumenDocStatus === 'loading'}
                title="Copia el resumen formateado (negrita, colores, viñetas) para pegarlo con Ctrl+V en tu Google Doc."
              >
                {resumenDocStatus === 'loading' ? 'Copiando...' : '📋 Copiar para Doc'}
              </button>
              <button
                type="button"
                className="resumen-canva-btn"
                disabled
                title="Próximamente: requiere conectar una app de Canva Developer (Client ID/Secret) para importar el diseño automáticamente a tu cuenta de Canva."
              >
                🎨 Abrir en Canva (próximamente)
              </button>
            </div>
            {resumenExportStatus === 'error' && (
              <div className="resumen-export-error">No se pudo generar la imagen. Probá de nuevo.</div>
            )}
            {resumenDocStatus && resumenDocStatus.type && (
              <div className={resumenDocStatus.type === 'error' ? 'resumen-export-error' : 'resumen-export-success'}>
                {resumenDocStatus.message}
                {resumenDocStatus.type === 'success' && (
                  <> · <a href={RESUMEN_DOC_URL} target="_blank" rel="noopener noreferrer" className="resumen-doc-link">Abrir el Doc ↗</a></>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}