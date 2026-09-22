import { google } from 'googleapis'

// Corre server-side (no en el navegador): usa las mismas credenciales de
// servicio que Scripts/sync-sheets.js / app/api/sync, pero con scope de
// Google Docs en vez de Sheets. El documento destino no se sobreescribe —
// cada export agrega una entrada nueva al final (salto de página incluido),
// armando una bitácora semanal por KAM.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const COLOR_UP = '#4CAF50'
const COLOR_DOWN = '#F44336'
const COLOR_GRAY = '#9E9E9E'

// Mismos umbrales/colores que mdStatusFor() en components/KamDashboard.js —
// duplicado acá (función chica y pura) para no importar un componente
// 'use client' desde una API route.
function mdStatusFor(pct) {
  if (pct < 80) return { color: '#F44336', label: 'EN PROGRESO' }
  if (pct < 90) return { color: '#AED581', label: 'MÍNIMO CUMPLIDO' }
  if (pct < 100) return { color: '#7CB342', label: 'EN BUEN CAMINO' }
  if (pct < 110) return { color: '#4CAF50', label: 'PERFORMA' }
  return { color: '#2E7D32', label: 'SOBREPERFORMA' }
}

function hexToRgbColor(hex) {
  const n = parseInt(hex.replace('#', ''), 16)
  return {
    red: ((n >> 16) & 255) / 255,
    green: ((n >> 8) & 255) / 255,
    blue: (n & 255) / 255,
  }
}

function colorTextStyle(hex, extra = {}) {
  return {
    textStyle: { foregroundColor: { color: { rgbColor: hexToRgbColor(hex) } }, ...extra },
    fields: ['foregroundColor', ...Object.keys(extra)].join(','),
  }
}

// Arma el texto completo de la entrada como UN solo string, llevando la
// cuenta de en qué offset local queda cada tramo a resaltar (negrita/color)
// y cada bloque a convertir en lista con viñetas — así todo el batchUpdate
// sale en una sola llamada, sin ir a buscar índices al medio del documento.
function buildResumenEntry(resumen) {
  let text = ''
  const styleRanges = []
  const bulletRanges = []

  const append = (s) => { text += s }
  const appendStyled = (s, style) => {
    const start = text.length
    text += s
    styleRanges.push({ start, end: text.length, style })
  }
  const appendKpi = (label, valueText, diffValue, diffSuffix = '%', decimals = 1) => {
    append(`${label}: ${valueText}  `)
    if (diffValue === null || diffValue === undefined || Number.isNaN(diffValue)) {
      appendStyled('(—)', colorTextStyle(COLOR_GRAY))
    } else {
      const sign = diffValue > 0 ? '+' : ''
      const color = diffValue < 0 ? COLOR_DOWN : COLOR_UP
      appendStyled(`(${sign}${diffValue.toFixed(decimals)}${diffSuffix} vs. semana anterior)`, colorTextStyle(color, { bold: true }))
    }
    append('\n')
  }

  const kamNombre = resumen.kam?.nombre || 'KAM'
  appendStyled(`📊 Resumen Semanal — ${kamNombre}\n`, {
    textStyle: { bold: true, fontSize: { magnitude: 15, unit: 'PT' } },
    fields: 'bold,fontSize',
  })

  let meta = `Kam de ${resumen.kam?.region || '—'} · ${resumen.kam?.brandCount ?? 0} brands · Semana del ${resumen.semana}`
  if (resumen.semanaAnterior) meta += ` (vs. ${resumen.semanaAnterior})`
  appendStyled(`${meta}\n\n`, {
    textStyle: {
      italic: true,
      fontSize: { magnitude: 9, unit: 'PT' },
      foregroundColor: { color: { rgbColor: hexToRgbColor(COLOR_GRAY) } },
    },
    fields: 'italic,fontSize,foregroundColor',
  })

  appendStyled('KPIs de la semana\n', { textStyle: { bold: true, fontSize: { magnitude: 12, unit: 'PT' } }, fields: 'bold,fontSize' })
  appendKpi('📦 Órdenes', resumen.orders.value.toLocaleString(), resumen.orders.diff?.pct ?? null)
  appendKpi('📊 Markdown', `${resumen.markdown.value.toFixed(1)}%`, resumen.markdown.diff?.pct ?? null)
  appendKpi('📶 Tráfico', resumen.trafico.value.toLocaleString(), resumen.trafico.diff?.pct ?? null)
  appendKpi('🎯 Conversión', resumen.conversion ? `${resumen.conversion.value.toFixed(2)}%` : '—', resumen.conversion?.diff ?? null, ' p.p.', 2)
  append('\n')

  if (resumen.minutaText) {
    appendStyled(`📝 ${resumen.minutaText}\n\n`, { textStyle: { italic: true }, fields: 'italic' })
  }

  if (resumen.brandMd) {
    const { status, calc } = resumen.brandMd
    const { color, label } = mdStatusFor(calc.achievedPct)
    append(`🎯 Brands with Markdown: ${status.brands_md_result} / ${status.brands_md_target}  `)
    appendStyled(`(${calc.achievedPct.toFixed(1)}% · ${label})`, colorTextStyle(color, { bold: true }))
    append('\n')
    if (resumen.mdTargetText) {
      appendStyled(`${resumen.mdTargetText}\n`, {
        textStyle: { fontSize: { magnitude: 9.5, unit: 'PT' }, foregroundColor: { color: { rgbColor: hexToRgbColor(COLOR_GRAY) } } },
        fields: 'fontSize,foregroundColor',
      })
    }
    append('\n')
  }

  if (resumen.urgentBrands?.total > 0) {
    const total = resumen.urgentBrands.total
    appendStyled(`🚨 Accionar Urgente — ${total} aliado${total === 1 ? '' : 's'} cerca del target (70%-85% de MD Archie Final)\n`, {
      textStyle: { bold: true },
      fields: 'bold',
    })
    const bulletStart = text.length
    resumen.urgentBrands.top.forEach((r) => {
      append(`${r.brand_name}: `)
      appendStyled(`${r.md_archie_final_pct.toFixed(1)}%`, colorTextStyle(mdStatusFor(r.md_archie_final_pct).color, { bold: true }))
      append('\n')
    })
    bulletRanges.push({ start: bulletStart, end: text.length })
    append('\n')
  }

  if (resumen.topSubas?.length > 0) {
    appendStyled('🔼 Mayor suba de MD\n', { textStyle: { bold: true }, fields: 'bold' })
    const bulletStart = text.length
    resumen.topSubas.forEach((b) => {
      append(`${b.brand_name}: `)
      appendStyled(`+${b.markdownDiffPct.toFixed(1)}%`, colorTextStyle(COLOR_UP, { bold: true }))
      append('\n')
    })
    bulletRanges.push({ start: bulletStart, end: text.length })
    append('\n')
  }

  if (resumen.topBajas?.length > 0) {
    appendStyled('🔽 Mayor baja de MD\n', { textStyle: { bold: true }, fields: 'bold' })
    const bulletStart = text.length
    resumen.topBajas.forEach((b) => {
      append(`${b.brand_name}: `)
      appendStyled(`${b.markdownDiffPct.toFixed(1)}%`, colorTextStyle(COLOR_DOWN, { bold: true }))
      append('\n')
    })
    bulletRanges.push({ start: bulletStart, end: text.length })
    append('\n')
  }

  const fecha = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' })
  appendStyled(`Generado el ${fecha} · Dashboard KAMs Semanal\n\n`, {
    textStyle: {
      italic: true,
      fontSize: { magnitude: 8.5, unit: 'PT' },
      foregroundColor: { color: { rgbColor: hexToRgbColor(COLOR_GRAY) } },
    },
    fields: 'italic,fontSize,foregroundColor',
  })

  return { text, styleRanges, bulletRanges }
}

export async function POST(request) {
  try {
    const { resumen } = await request.json()
    if (!resumen || !resumen.kam || !resumen.semana) {
      return Response.json({ error: 'Falta el resumen a exportar.' }, { status: 400 })
    }

    const documentId = process.env.GOOGLE_RESUMEN_DOC_ID
    if (!documentId) {
      return Response.json({ error: 'GOOGLE_RESUMEN_DOC_ID no está configurado en las variables de entorno.' }, { status: 500 })
    }

    // El Workspace de Rappi bloquea compartir Docs con cuentas fuera del
    // dominio, así que acá no se puede usar el service account de
    // sync-sheets.js (es una cuenta externa). En su lugar se autentica como
    // el usuario de Rappi dueño del Doc, vía OAuth con refresh token — ver
    // Scripts/google-oauth-setup.js para generarlo una sola vez.
    const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = process.env
    if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
      return Response.json({
        error: 'Falta configurar el acceso OAuth (GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN). Corré Scripts/google-oauth-setup.js.',
      }, { status: 500 })
    }

    const auth = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET)
    auth.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN })

    const docs = google.docs({ version: 'v1', auth })

    const doc = await docs.documents.get({ documentId })
    const content = doc.data.body?.content || []
    const bodyEndIndex = content.length > 0 ? content[content.length - 1].endIndex : 1
    const insertionIndex = Math.max(1, bodyEndIndex - 1)
    const hasContent = insertionIndex > 1

    const { text, styleRanges, bulletRanges } = buildResumenEntry(resumen)

    const requests = []
    let cursor = insertionIndex

    if (hasContent) {
      requests.push({ insertPageBreak: { location: { index: cursor } } })
      cursor += 1
    }

    requests.push({ insertText: { location: { index: cursor }, text } })

    for (const r of styleRanges) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: cursor + r.start, endIndex: cursor + r.end },
          textStyle: r.style.textStyle,
          fields: r.style.fields,
        },
      })
    }

    for (const b of bulletRanges) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: cursor + b.start, endIndex: cursor + b.end },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      })
    }

    await docs.documents.batchUpdate({ documentId, requestBody: { requests } })

    return Response.json({ ok: true })
  } catch (err) {
    console.error('❌ Error exportando resumen a Google Doc:', err?.response?.data || err)
    const status = err?.code === 404 || err?.response?.status === 404 ? 404 : 500
    const message = status === 404
      ? 'No se encontró el Google Doc — revisá GOOGLE_RESUMEN_DOC_ID (y que el Doc sea tuyo o lo tengas compartido con edición).'
      : 'No se pudo escribir en el Doc. El token OAuth puede haber expirado o haber sido revocado — volvé a correr Scripts/google-oauth-setup.js. También revisá que la Google Docs API esté habilitada.'
    return Response.json({ error: message }, { status })
  }
}
