export type AgentSuggestion = {
  id: string
  label: string
  prompt: string
}

const SELECTED_SUGGESTIONS: readonly AgentSuggestion[] = [
  {
    id: 'critique',
    label: 'Critique',
    prompt: 'Critique the selected cards.',
  },
  {
    id: 'evidence',
    label: 'Find evidence gaps',
    prompt: 'Find claims in the selected cards that need evidence.',
  },
  {
    id: 'structure',
    label: 'Suggest structure',
    prompt: 'Suggest a clearer structure for the selected cards.',
  },
]

const CANVAS_SUGGESTIONS: readonly AgentSuggestion[] = [
  {
    id: 'critique',
    label: 'Critique',
    prompt: 'Critique the overall canvas.',
  },
  {
    id: 'evidence',
    label: 'Find evidence gaps',
    prompt: 'Find claims across the canvas that need evidence.',
  },
  {
    id: 'structure',
    label: 'Suggest structure',
    prompt: 'Suggest a clearer structure for the canvas.',
  },
]

export function agentSuggestions(hasSelection: boolean): readonly AgentSuggestion[] {
  return hasSelection ? SELECTED_SUGGESTIONS : CANVAS_SUGGESTIONS
}
