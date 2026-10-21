import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './theme/tokens.css'
import './index.css'
import App from './App.jsx'
import { apiUrl } from './utils/api'
import { setVisit } from './utils/visit'

// the portfolio's CS accent
document.documentElement.dataset.section = 'cs'

// the visit's log id, so the relight backdrop's reports are filed under this page
setVisit(
  fetch(apiUrl('/load?page=atlas3150-assignment6'))
    .then((response) => response.json())
    .then((data) => data.id || null),
)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
