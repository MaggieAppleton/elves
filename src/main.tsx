import '@fontsource-variable/inter/wght.css' // self-hosted Inter (variable weight) — one intentional typeface for cards + all tldraw chrome
import { createRoot } from 'react-dom/client'
import App from './App'

// Note: React.StrictMode is omitted here — tldraw disposes its editor on
// unmount, which causes a crash in StrictMode's double-mount dev cycle.
createRoot(document.getElementById('root')!).render(<App />)
