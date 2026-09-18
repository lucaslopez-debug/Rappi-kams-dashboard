'use client'

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { BarChart, Bar, XAxis, YAxis, LabelList, ResponsiveContainer } from 'recharts'
import { Poppins } from 'next/font/google'
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
const BRAND_STATUS_OPTIONS = ['No contactado', 'Contactado', 'Mkd activo', 'Actualizar Mkd', 'Mandar a BD']

const BRAND_STATUS_COLORS = {
  'No contactado': { bg: '#2A2A2A', text: '#B0B0B0' },
  'Contactado': { bg: 'rgba(79, 195, 247, 0.18)', text: '#4FC3F7' },
  'Mkd activo': { bg: 'rgba(76, 175, 80, 0.18)', text: '#4CAF50' },
  'Actualizar Mkd': { bg: 'rgba(255, 193, 7, 0.18)', text: '#FFC107' },
  'Mandar a BD': { bg: 'rgba(255, 82, 82, 0.18)', text: '#FF5252' },
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

      // Reflejar el cambio al toque si el KAM activo estaba entre los actualizados,
      // sin esperar a un refetch
      const ownUpdate = kamActive && updates.find((u) => u.kam_id === kamActive.id)
      if (ownUpdate) setBrandMdStatus(ownUpdate)

      let message = `✅ ${updates.length} KAM${updates.length === 1 ? '' : 's'} actualizado${updates.length === 1 ? '' : 's'} correctamente.`
      if (unmatchedEmails.length > 0) {
        message += ` ${unmatchedEmails.length} fila${unmatchedEmails.length === 1 ? '' : 's'} no coincidió con ningún KAM.`
      }
      setMdImportStatus({ type: 'success', message })
    } catch (err) {
      setMdImportStatus({ type: 'error', message: err.message || 'No se pudo importar el archivo.' })
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

  return (
    <div className="w-full">
      {/* RANKING FIJO: posición de cada KAM según % de Brands with Markdown
          cumplido, no depende del KAM ni de la pestaña que se esté mirando —
          se recalcula en cada actualización de datos (import de Excel / refetch
          periódico) y queda pegado arriba de todo, incluso al hacer scroll. */}
      {kamsRanking.length > 0 && (
        <div className="ranking-card fade-in">
          <div className="ranking-header">
            <div className="ranking-title">🏅 Ranking KAMs — Brands with Markdown</div>
            <div className="ranking-subtitle">% del target de brands con markdown activo cumplido por cada KAM, actualizado con cada importación del Excel de comisiones.</div>
          </div>
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
                  <span className="ranking-info">
                    <span className="ranking-name">{k.nombre}</span>
                    <span className="ranking-target">{k.result} / {k.target} brands</span>
                  </span>
                  <span className="ranking-pct" style={{ color }}>{k.achievedPct.toFixed(1)}%</span>
                </button>
              )
            })}
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
        </div>
      )}

      {/* BRANDS WITH MARKDOWN: Brands w/MD Result/Target del KAM activo, contra
          un umbral seleccionable, con minuta */}
      <div className="table-card fade-in">
        <div className="table-header-row">
          <div className="table-title">Brands with Markdown</div>
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
          </div>
        </div>
        <p className="table-subtitle">
          Compara, para este KAM, cuántas brands de su cartera tienen markdown activo (Brands In) contra la cantidad objetivo (Markdown Target), y qué % de ese objetivo ya cumplió. Elegí un umbral para ver cuántas brands le faltan — o le sobran — para llegar a ese nivel. Actualizá los números con el botón "Importar Excel": lee el archivo de comisiones, identifica las columnas de Comercial, Brands w/MD Result y Brands w/MD Target, y cruza cada fila con el KAM correspondiente por email.
        </p>

        {mdImportStatus && (
          <div className={`md-import-status md-import-status-${mdImportStatus.type}`}>
            {mdImportStatus.message}
          </div>
        )}

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

      {/* SUB-TABS: Top and Bottom / Middle / Accionables */}
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

      {/* POSIBLES CASOS - visible en Top and Bottom y en Middle, se oculta solo en Accionables */}
      {activeSubTab !== 'accionables' && (topBrands.length > 0 || bottomBrands.length > 0) && (
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
    </div>
  )
}