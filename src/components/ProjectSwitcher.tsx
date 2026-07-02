import { useEffect, useRef, useState } from 'react'
import type { Project } from '../client/persistence'

interface Props {
  projects: Project[]
  currentId: string | null
  onSwitch: (id: string) => void
  onCreate: () => void
  onRename: () => void
}

function CaretIcon() {
  return (
    <svg className="elves-switcher__caret" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="elves-switcher__check-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  )
}

export function ProjectSwitcher({ projects, currentId, onSwitch, onCreate, onRename }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = projects.find((p) => p.id === currentId)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="elves-switcher" ref={ref}>
      <button
        className="elves-switcher__button"
        data-testid="project-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="elves-switcher__name">{current?.name ?? 'Select project'}</span>
        <CaretIcon />
      </button>
      {open && (
        <div className="elves-switcher__menu" role="menu">
          {projects.map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={p.id === currentId}
              className="elves-switcher__item"
              data-testid={`project-option-${p.id}`}
              onClick={() => {
                setOpen(false)
                onSwitch(p.id)
              }}
            >
              <span className="elves-switcher__check">{p.id === currentId ? <CheckIcon /> : null}</span>
              <span className="elves-switcher__item-label">{p.name}</span>
            </button>
          ))}
          <div className="elves-switcher__divider" role="separator" />
          <button
            role="menuitem"
            className="elves-switcher__item elves-switcher__item--action"
            data-testid="project-new"
            onClick={() => {
              setOpen(false)
              onCreate()
            }}
          >
            <span className="elves-switcher__check" />
            <span className="elves-switcher__item-label">New project…</span>
          </button>
          {current && (
            <button
              role="menuitem"
              className="elves-switcher__item elves-switcher__item--action"
              data-testid="project-rename"
              onClick={() => {
                setOpen(false)
                onRename()
              }}
            >
              <span className="elves-switcher__check" />
              <span className="elves-switcher__item-label">Rename “{current.name}”…</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
