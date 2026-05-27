import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'

// Vite's BASE_URL is "/" in dev and "/bridgethings-erp-/" on GitHub Pages.
// Passing it to BrowserRouter keeps all routes scoped under the subpath, so
// navigating to /login becomes /bridgethings-erp-/login and Pages serves it
// (instead of redirecting to the user-root which 404s).
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
