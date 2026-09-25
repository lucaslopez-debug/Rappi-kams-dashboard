import './globals.css'

export const metadata = {
  title: 'Dashboard KAMs Semanal - Rappi',
  description: 'Análisis de métricas semanales y comparativas de KAMs',
}

// Ancho de dispositivo en celulares/tablets y barra del navegador en el mismo
// oscuro del header.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1E1E1E',
}

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <head>
        <link rel="icon" href="/rappi-logo.webp" />
        {/* Precarga del logo: lo usa tanto el header como el splash screen,
            y es una imagen pesada (2823x2189) — arrancar la descarga desde
            el <head>, antes de que React hidrate, evita que el splash se
            quede en pantalla negra esperándola. */}
        <link
          rel="preload"
          as="image"
          href="/rappi-logo.webp"
        />
      </head>
      <body>
        <header className="header">
          <div className="header-top">
            <div className="header-title">
              <h1>📊 Dashboard KAMs Semanal</h1>
              <p>Rappi - Análisis de Métricas Semanales</p>
            </div>
            <div className="header-right">
              {/* Contenedor vacío: KamDashboard porta acá (React portal) los
                  botones de Importar Excel / Importar Compensation, así quedan
                  a la izquierda del logo aunque la lógica siga viviendo en el
                  componente del dashboard. */}
              <div id="header-import-actions" className="header-import-actions"></div>
              <div className="header-logo-stack">
                <img
                  src="/rappi-logo.webp"
                  alt="Rappi"
                  className="header-logo"
                />
                {/* Contenedor vacío: KamDashboard porta acá el botón de
                    Exportar Resumen, debajo del logo. */}
                <div id="header-export-actions" className="header-export-actions"></div>
              </div>
              {/* Contenedor vacío: acá se porta el botón de alerta (🚨 Brands
                  caídas a 0% de Markdown), en la esquina superior derecha. */}
              <div id="header-alert-actions" className="header-alert-actions"></div>
            </div>
          </div>
          {/* Contenedor vacío: app/page.js porta acá el filtro de KAM, que
              aplica a todas las secciones (Markdown, Tarjetas, ...) y queda
              fijo arriba al scrollear junto con el resto del header. */}
          <div id="header-kam-tabs" className="header-kam-tabs"></div>
        </header>
        {children}
      </body>
    </html>
  )
}