import { expect, test } from 'vitest'
import { agentSuggestions } from '../../src/client/agentSuggestions'

test('selection suggestions are scoped editorial prompts', () => {
  expect(agentSuggestions(true).map((suggestion) => suggestion.prompt)).toEqual([
    'Critique the selected cards.',
    'Find claims in the selected cards that need evidence.',
    'Suggest a clearer structure for the selected cards.',
  ])
})

test('whole-canvas suggestions stay bounded and address the canvas', () => {
  expect(agentSuggestions(false)).toHaveLength(3)
  expect(agentSuggestions(false).map((suggestion) => suggestion.id)).toEqual([
    'critique',
    'evidence',
    'structure',
  ])
})
