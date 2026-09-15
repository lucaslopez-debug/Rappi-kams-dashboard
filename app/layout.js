import './globals.css'

export const metadata = {
  title: 'Dashboard KAMs Semanal - Rappi',
  description: 'Análisis de métricas semanales y comparativas de KAMs',
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
          <div className="header-title">
            <h1>📊 Dashboard KAMs Semanal</h1>
            <p>Rappi - Análisis de Métricas Semanales</p>
          </div>
          <img 
            src="/rappi-logo.webp" 
            alt="Rappi" 
            className="header-logo"
          />
        </header>
        {children}
      </body>
    </html>
  )
}