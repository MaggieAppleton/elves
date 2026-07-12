import { describe, expect, it } from 'vitest'
import { deriveStatus, verbFor, type StatusEntry } from '../../src/client/agentStatus'

const tool = (name: string, summary = ''): StatusEntry => ({ kind: 'tool', name, summary })

describe('verbFor', () => {
  it('maps read/list tools to Reading', () => {
    expect(verbFor('read_map')).toBe('Reading')
    expect(verbFor('read_selection')).toBe('Reading')
    expect(verbFor('list_projects')).toBe('Reading')
  })

  it('maps create/edit/delete to Writing/Editing/Deleting', () => {
    expect(verbFor('create_note_card')).toBe('Writing')
    expect(verbFor('edit_card')).toBe('Editing')
    expect(verbFor('delete_card')).toBe('Deleting')
  })

  it('maps move/group/merge to Organising', () => {
    expect(verbFor('move_cards')).toBe('Organising')
    expect(verbFor('group_cards')).toBe('Organising')
    expect(verbFor('ungroup_cards')).toBe('Organising')
    expect(verbFor('merge_notes')).toBe('Organising')
  })

  it('maps review and comment tools', () => {
    expect(verbFor('start_review')).toBe('Reviewing')
    expect(verbFor('complete_review')).toBe('Reviewing')
    expect(verbFor('add_comment')).toBe('Commenting')
  })

  it('maps search tools (case-insensitive) and bash', () => {
    expect(verbFor('ToolSearch')).toBe('Searching')
    expect(verbFor('WebSearch')).toBe('Searching')
    expect(verbFor('Bash')).toBe('Running')
  })

  it('humanises an unmapped tool as a fallback', () => {
    expect(verbFor('frobnicate_widgets')).toBe('Frobnicate widgets')
  })
})

describe('deriveStatus', () => {
  it('reports the working phase with verb + detail for a live tool call', () => {
    const status = deriveStatus([{ kind: 'user', name: undefined }, tool('read_cards', '3 cards')], true)
    expect(status).toEqual({ phase: 'working', verb: 'Reading', detail: '3 cards' })
  })

  it('drops an empty summary rather than showing a dangling separator', () => {
    const status = deriveStatus([tool('read_map', '')], true)
    expect(status).toEqual({ phase: 'working', verb: 'Reading', detail: undefined })
  })

  it('is Thinking while running before any tool runs', () => {
    expect(deriveStatus([{ kind: 'user' }], true)).toEqual({ phase: 'thinking', verb: 'Thinking' })
    expect(deriveStatus([], true)).toEqual({ phase: 'thinking', verb: 'Thinking' })
  })

  it('is Thinking when the newest entry is agent prose (between tools)', () => {
    const entries: StatusEntry[] = [tool('read_map', ''), { kind: 'text' }]
    expect(deriveStatus(entries, true)).toEqual({ phase: 'thinking', verb: 'Thinking' })
  })

  it('is Done when the run has finished', () => {
    expect(deriveStatus([tool('read_map', ''), { kind: 'text' }], false)).toEqual({
      phase: 'done',
      verb: 'Done',
    })
  })

  it('is the error phase when the run ended on an error', () => {
    expect(deriveStatus([{ kind: 'error' }], false)).toEqual({ phase: 'error', verb: 'Error' })
  })
})
