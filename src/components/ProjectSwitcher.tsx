import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const initialFocusIndexRef = useRef(0)
  const current = projects.find((p) => p.id === currentId)
  const itemCount = projects.length + 1 + (current ? 1 : 0)

  const openAt = (index: number) => {
    initialFocusIndexRef.current = index
    setOpen(true)
  }

  const closeAndFocusTrigger = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const activate = (action: () => void) => {
    closeAndFocusTrigger()
    action()
  }

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }

    const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement)
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % itemCount
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + itemCount) % itemCount
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = itemCount - 1
    if (nextIndex === null) return

    event.preventDefault()
    itemRefs.current[nextIndex]?.focus()
  }

  useEffect(() => {
    if (!open) return
    itemRefs.current[initialFocusIndexRef.current]?.focus()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
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
        id="project-switcher-trigger"
        ref={triggerRef}
        className="elves-switcher__button"
        data-testid="project-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="project-switcher-menu"
        onClick={() => {
          if (open) setOpen(false)
          else openAt(0)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openAt(event.key === 'ArrowDown' ? 0 : itemCount - 1)
        }}
      >
        <span className="elves-switcher__name">{current?.name ?? 'Select project'}</span>
        <CaretIcon />
      </button>
      {open && (
        <div
          id="project-switcher-menu"
          className="elves-switcher__menu"
          role="menu"
          aria-labelledby="project-switcher-trigger"
          onKeyDown={handleMenuKeyDown}
        >
          {projects.map((p, index) => (
            <button
              key={p.id}
              ref={(node) => {
                itemRefs.current[index] = node
              }}
              role="menuitemradio"
              aria-checked={p.id === currentId}
              tabIndex={-1}
              className="elves-switcher__item"
              data-testid={`project-option-${p.id}`}
              onClick={() => activate(() => onSwitch(p.id))}
            >
              <span className="elves-switcher__check">{p.id === currentId ? <CheckIcon /> : null}</span>
              <span className="elves-switcher__item-label">{p.name}</span>
            </button>
          ))}
          <div className="elves-switcher__divider" role="separator" />
          <button
            ref={(node) => {
              itemRefs.current[projects.length] = node
            }}
            role="menuitem"
            tabIndex={-1}
            className="elves-switcher__item elves-switcher__item--action"
            data-testid="project-new"
            onClick={() => activate(onCreate)}
          >
            <span className="elves-switcher__check" />
            <span className="elves-switcher__item-label">New project…</span>
          </button>
          {current && (
            <button
              ref={(node) => {
                itemRefs.current[projects.length + 1] = node
              }}
              role="menuitem"
              tabIndex={-1}
              className="elves-switcher__item elves-switcher__item--action"
              data-testid="project-rename"
              onClick={() => activate(onRename)}
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
