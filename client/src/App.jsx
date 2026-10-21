import { Routes, Route } from 'react-router-dom'
import SubdomainNav from './Components/Homepage/SubdomainNav'
import Home from './pages/Home.jsx'
import About from './pages/About.jsx'

function App() {
  return (
    <div>
      <SubdomainNav />

      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </Routes>
    </div>
  )
}

export default App
