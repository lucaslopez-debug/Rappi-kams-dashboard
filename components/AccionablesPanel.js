'use client'

import { useState, useEffect, useCallback } from 'react'
import { Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'

const FRENTE_OPTIONS = ['Markdown', 'ADS', 'Turbo', 'Catálogo']
const OTRO_ALIADO = 'Otro / General'

export default function AccionablesPanel({ kamId, currentWeek, availableWeeks, brandOptions = [] }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [newBrand, setNewBrand] = useState('')
  const [newFrente, setNewFrente] = useState('')
  const [newText, setNewText] = useState('')
  const [saving, setSaving] = useState(false)
  const [historyWeek, setHistoryWeek] = useState(currentWeek || '')

  const fetchItems = useCallback(async () => {
    if (!kamId) return
    setLoading(true)
    const { data, error } = await supabase
      .from('accionables')
      .select('*')
      .eq('kam_id', kamId)
      .order('created_at', { ascending: true })
    if (!error) setItems(data || [])
    setLoading(false)
  }, [kamId])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  useEffect(() => {
    setHistoryWeek(currentWeek || '')
  }, [currentWeek])

  const canSave = newBrand.trim() && newFrente.trim() && newText.trim() && kamId && currentWeek

  const addItem = async () => {
    const descripcion = newText.trim()
    if (!canSave) return
    setSaving(true)
    const { error } = await supabase.from('accionables').insert({
      kam_id: kamId,
      brand_name: newBrand,
      frente: newFrente,
      descripcion,
      created_week: currentWeek,
      completed: false,
    })
    setSaving(false)
    if (!error) {
      setNewBrand('')
      setNewFrente('')
      setNewText('')
      fetchItems()
    }
  }

  const toggleItem = async (item) => {
    const completed = !item.completed
    const patch = {
      completed,
      completed_week: completed ? currentWeek : null,
      completed_at: completed ? new Date().toISOString() : null,
    }
    // Update optimista para que el check responda al toque
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...patch } : i)))
    const { error } = await supabase.from('accionables').update(patch).eq('id', item.id)
    if (error) fetchItems()
  }

  const deleteItem = async (item) => {
    const prevItems = items
    // Update optimista: lo sacamos de la lista al toque
    setItems((prev) => prev.filter((i) => i.id !== item.id))
    const { error } = await supabase.from('accionables').delete().eq('id', item.id)
    if (error) setItems(prevItems)
  }

  const pending = items.filter((i) => !i.completed)
  const completedForWeek = items.filter((i) => i.completed && i.completed_week === historyWeek)

  return (
    <div className="table-card fade-in">
      <div className="table-title">✅ Nuevo Accionable</div>

      <div className="accionable-form">
        <div className="accionable-field">
          <label className="accionable-field-label" htmlFor="accionable-brand">Aliado</label>
          <select
            id="accionable-brand"
            value={newBrand}
            onChange={(e) => setNewBrand(e.target.value)}
            className="accionable-select"
          >
            <option value="">Seleccioná un aliado...</option>
            {brandOptions.map((brand) => (
              <option key={brand} value={brand}>{brand}</option>
            ))}
            <option value={OTRO_ALIADO}>{OTRO_ALIADO}</option>
          </select>
          <span className="accionable-field-hint">Con qué aliado (brand) de la cartera vas a trabajar este accionable.</span>
        </div>

        <div className="accionable-field">
          <label className="accionable-field-label" htmlFor="accionable-frente">Frente</label>
          <select
            id="accionable-frente"
            value={newFrente}
            onChange={(e) => setNewFrente(e.target.value)}
            className="accionable-select"
          >
            <option value="">Seleccioná un frente...</option>
            {FRENTE_OPTIONS.map((frente) => (
              <option key={frente} value={frente}>{frente}</option>
            ))}
          </select>
          <span className="accionable-field-hint">Sobre qué palanca vas a actuar: Markdown, ADS, Turbo o Catálogo.</span>
        </div>

        <div className="accionable-field accionable-field-full">
          <label className="accionable-field-label" htmlFor="accionable-desc">Descripción</label>
          <textarea
            id="accionable-desc"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Ej: subir el markdown de la categoría X del 5% al 8% durante 2 semanas para reactivar órdenes."
            className="accionable-textarea"
            rows={3}
          />
          <span className="accionable-field-hint">Qué vas a hacer exactamente — cuanto más concreto, más fácil de dar seguimiento después.</span>
        </div>

        <button
          onClick={addItem}
          disabled={saving || !canSave}
          className="filter-btn accionable-save-btn"
          style={{ opacity: saving || !canSave ? 0.5 : 1 }}
        >
          {saving ? 'Guardando...' : '+ Guardar Accionable'}
        </button>
      </div>

      <div className="accionables-subtitle">Pendientes ({pending.length})</div>
      {loading ? (
        <div className="accionable-empty">Cargando...</div>
      ) : pending.length === 0 ? (
        <div className="accionable-empty">No hay accionables pendientes.</div>
      ) : (
        <ul className="accionable-list">
          {pending.map((item) => (
            <li key={item.id} className="accionable-item">
              <label>
                <input type="checkbox" checked={false} onChange={() => toggleItem(item)} />
                <span className="accionable-item-body">
                  <span className="accionable-tags">
                    {item.brand_name && <span className="accionable-tag">{item.brand_name}</span>}
                    {item.frente && <span className="accionable-tag accionable-tag-frente">{item.frente}</span>}
                  </span>
                  <span>{item.descripcion}</span>
                </span>
              </label>
              <span className="accionable-item-right">
                <span className="accionable-meta">desde {item.created_week}</span>
                <button
                  type="button"
                  onClick={() => deleteItem(item)}
                  className="accionable-delete"
                  title="Eliminar accionable"
                  aria-label="Eliminar accionable"
                >
                  <Trash2 size={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="accionables-history-header">
        <div className="accionables-subtitle">Historial de completados</div>
        {availableWeeks.length > 0 && (
          <select
            value={historyWeek}
            onChange={(e) => setHistoryWeek(e.target.value)}
            className="accionable-week-select"
          >
            {availableWeeks.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        )}
      </div>
      {loading ? (
        <div className="accionable-empty">Cargando...</div>
      ) : completedForWeek.length === 0 ? (
        <div className="accionable-empty">No se completó nada en {historyWeek || 'esta semana'}.</div>
      ) : (
        <ul className="accionable-list">
          {completedForWeek.map((item) => (
            <li key={item.id} className="accionable-item done">
              <label>
                <input type="checkbox" checked onChange={() => toggleItem(item)} />
                <span className="accionable-item-body">
                  <span className="accionable-tags">
                    {item.brand_name && <span className="accionable-tag">{item.brand_name}</span>}
                    {item.frente && <span className="accionable-tag accionable-tag-frente">{item.frente}</span>}
                  </span>
                  <span>{item.descripcion}</span>
                </span>
              </label>
              <span className="accionable-item-right">
                <span className="accionable-meta">hecho en {item.completed_week}</span>
                <button
                  type="button"
                  onClick={() => deleteItem(item)}
                  className="accionable-delete"
                  title="Eliminar accionable"
                  aria-label="Eliminar accionable"
                >
                  <Trash2 size={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
