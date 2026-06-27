import { Router } from 'express'
import { AppError } from '../middleware/errorHandler.js'
import { requireJson } from '../middleware/requireJson.js'

export const GRAPHQL_MAX_DEPTH = 4
export const GRAPHQL_MAX_COMPLEXITY = 12

export interface GraphqlFieldNode {
  name: string
  alias?: string
  selections: GraphqlFieldNode[]
}

const rootData = {
  __typename: 'Query',
  viewer: {
    __typename: 'Viewer',
    id: 'viewer-1',
    name: 'Disciplr Demo',
    stats: {
      __typename: 'ViewerStats',
      score: 42,
      rank: 'gold',
    },
  },
  metrics: {
    __typename: 'Metrics',
    uptime: 99.9,
    status: 'ok',
  },
} as const

function stripIgnoredTokens(query: string): string {
  return query
    .replace(/#[^\n\r]*/g, ' ')
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
}

function isNameStart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z_]/.test(char))
}

function isNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_]/.test(char))
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index
  while (cursor < source.length && /[\s,]/.test(source[cursor])) {
    cursor += 1
  }
  return cursor
}

function readName(source: string, index: number): { value: string; nextIndex: number } {
  let cursor = index
  if (!isNameStart(source[cursor])) {
    throw AppError.badRequest('Invalid GraphQL query.')
  }

  cursor += 1
  while (cursor < source.length && isNameChar(source[cursor])) {
    cursor += 1
  }

  return { value: source.slice(index, cursor), nextIndex: cursor }
}

function skipBalancedSection(source: string, index: number, openChar: string, closeChar: string): number {
  let cursor = index
  let depth = 0

  while (cursor < source.length) {
    const char = source[cursor]
    if (char === openChar) {
      depth += 1
    } else if (char === closeChar) {
      depth -= 1
      if (depth === 0) {
        return cursor + 1
      }
    }
    cursor += 1
  }

  throw AppError.badRequest('Invalid GraphQL query.')
}

function parseSelectionSet(
  source: string,
  startIndex: number,
  currentDepth: number,
): { selections: GraphqlFieldNode[]; nextIndex: number; maxDepth: number; complexity: number } {
  let index = skipWhitespace(source, startIndex)
  if (source[index] !== '{') {
    throw AppError.badRequest('Invalid GraphQL query.')
  }

  index += 1
  const selections: GraphqlFieldNode[] = []
  let maxDepth = currentDepth
  let complexity = 0

  while (index < source.length) {
    index = skipWhitespace(source, index)
    const char = source[index]

    if (char === '}') {
      return {
        selections,
        nextIndex: index + 1,
        maxDepth,
        complexity,
      }
    }

    if (source.startsWith('...', index)) {
      throw AppError.badRequest('GraphQL fragments are not supported on this endpoint.')
    }

    const firstName = readName(source, index)
    index = skipWhitespace(source, firstName.nextIndex)

    let alias: string | undefined
    let fieldName = firstName.value

    if (source[index] === ':') {
      alias = firstName.value
      index = skipWhitespace(source, index + 1)
      const aliasedField = readName(source, index)
      fieldName = aliasedField.value
      index = aliasedField.nextIndex
    }

    index = skipWhitespace(source, index)

    if (source[index] === '(') {
      index = skipBalancedSection(source, index, '(', ')')
      index = skipWhitespace(source, index)
    }

    const node: GraphqlFieldNode = {
      name: fieldName,
      ...(alias ? { alias } : {}),
      selections: [],
    }

    complexity += 1
    maxDepth = Math.max(maxDepth, currentDepth)

    if (source[index] === '{') {
      const nested = parseSelectionSet(source, index, currentDepth + 1)
      node.selections = nested.selections
      index = nested.nextIndex
      complexity += nested.complexity
      maxDepth = Math.max(maxDepth, nested.maxDepth)
    }

    selections.push(node)
  }

  throw AppError.badRequest('Invalid GraphQL query.')
}

export function parseGraphqlQuery(query: string): {
  selections: GraphqlFieldNode[]
  maxDepth: number
  complexity: number
} {
  const source = stripIgnoredTokens(query).trim()
  if (!source) {
    throw AppError.badRequest('GraphQL query is required.')
  }

  const firstBrace = source.indexOf('{')
  if (firstBrace === -1) {
    throw AppError.badRequest('Invalid GraphQL query.')
  }

  const parsed = parseSelectionSet(source, firstBrace, 1)
  return {
    selections: parsed.selections,
    maxDepth: parsed.maxDepth,
    complexity: parsed.complexity,
  }
}

function executeSelections(selections: GraphqlFieldNode[], source: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const sourceObject = (source ?? {}) as Record<string, unknown>

  for (const selection of selections) {
    const responseKey = selection.alias ?? selection.name

    if (selection.name === '__typename') {
      result[responseKey] = typeof sourceObject.__typename === 'string' ? sourceObject.__typename : 'Object'
      continue
    }

    const value = sourceObject[selection.name]

    if (selection.selections.length > 0) {
      result[responseKey] = executeSelections(selection.selections, value)
      continue
    }

    result[responseKey] = value ?? null
  }

  return result
}

export const graphqlRouter = Router()

graphqlRouter.post('/', requireJson(), (req, res, next) => {
  try {
    const query = typeof req.body?.query === 'string' ? req.body.query : ''
    const parsed = parseGraphqlQuery(query)

    if (parsed.maxDepth > GRAPHQL_MAX_DEPTH) {
      throw AppError.badRequest(
        `GraphQL query depth ${parsed.maxDepth} exceeds the maximum allowed depth of ${GRAPHQL_MAX_DEPTH}.`,
        {
          limitType: 'depth',
          maxAllowed: GRAPHQL_MAX_DEPTH,
          actual: parsed.maxDepth,
        },
      )
    }

    if (parsed.complexity > GRAPHQL_MAX_COMPLEXITY) {
      throw AppError.badRequest(
        `GraphQL query complexity ${parsed.complexity} exceeds the maximum allowed complexity of ${GRAPHQL_MAX_COMPLEXITY}.`,
        {
          limitType: 'complexity',
          maxAllowed: GRAPHQL_MAX_COMPLEXITY,
          actual: parsed.complexity,
        },
      )
    }

    res.status(200).json({
      data: executeSelections(parsed.selections, rootData),
      extensions: {
        limits: {
          depth: GRAPHQL_MAX_DEPTH,
          complexity: GRAPHQL_MAX_COMPLEXITY,
        },
      },
    })
  } catch (error) {
    next(error)
  }
})
