import { Comment, CommentType } from './types'

export function makeComment(
  id: string,
  text: string,
  type: CommentType | null = null,
  author = 'claude',
): Comment {
  return {
    id, type, text, resolved: false, author,
    summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
  }
}

export function addComment(comments: Comment[], comment: Comment): Comment[] {
  return [...comments, comment]
}

export function resolveComment(comments: Comment[], commentId: string): Comment[] {
  return comments.map((c) => (c.id === commentId ? { ...c, resolved: true } : c))
}

export function visibleComments(comments: Comment[]): Comment[] {
  return comments.filter((c) => !c.resolved)
}
