// A strict parser for the YAML the repo's workflows use, for their tests
// (the repo has no YAML parser among its dependencies). Block mappings and
// sequences, plain, single- and double-quoted scalars, flow sequences of
// scalars (`[a, b]`), literal and folded block scalars (`|`, `|-`, `>`,
// `>-`), comments. Anything else (anchors, aliases, tags, flow mappings,
// several documents, tabs) throws, so a workflow that outgrows it fails
// its test instead of being misread.

class YamlError extends Error {}

function stripComment(text) {
  let q = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === q) q = null
    } else if (c === "'" || c === '"') {
      if (i === 0 || /[\s[,:]/.test(text[i - 1])) q = c
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text.trimEnd()
}

function scalar(raw, where) {
  const s = raw.trim()
  if (s === '') return null
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s))
      throw new YamlError(`${where}: bad quoted ${s}`)
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      throw new YamlError(`${where}: unsupported double-quoted ${s}`)
    }
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']'))
      throw new YamlError(`${where}: bad flow sequence ${s}`)
    const inner = s.slice(1, -1).trim()
    return inner ? inner.split(',').map((x) => scalar(x, where)) : []
  }
  if (/^[{&*!|>%@`]/.test(s)) throw new YamlError(`${where}: unsupported ${s}`)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+$/.test(s)) return Number(s)
  return s
}

export function parse(text) {
  if (text.includes('\t')) throw new YamlError('tabs are not supported')
  const raw = text.split('\n')
  // Content lines: [index into raw, indent, text without comment].
  const lines = []
  raw.forEach((l, i) => {
    const t = stripComment(l)
    if (t.trim() === '') return
    if (t.trim() === '---' || t.trim() === '...')
      throw new YamlError(`line ${i + 1}: several documents`)
    lines.push({ i, indent: t.length - t.trimStart().length, text: t.trim() })
  })
  let pos = 0

  const where = () => `line ${lines[pos].i + 1}`

  function blockScalar(style, parentIndent) {
    // Raw lines after the key's line, deeper than the parent, blanks kept.
    const start = lines[pos - 1].i + 1
    let end = start
    const body = []
    while (end < raw.length) {
      const l = raw[end]
      if (l.trim() !== '' && l.length - l.trimStart().length <= parentIndent)
        break
      body.push(l)
      end++
    }
    while (body.length && body[body.length - 1].trim() === '') body.pop()
    const ind = Math.min(
      ...body
        .filter((l) => l.trim())
        .map((l) => l.length - l.trimStart().length),
    )
    const content = body.map((l) => l.slice(ind))
    while (pos < lines.length && lines[pos].i < end) pos++
    const keep = !style.endsWith('-')
    let out
    if (style.startsWith('|')) out = content.join('\n')
    else {
      out = ''
      for (const l of content) {
        if (l === '') out += '\n'
        else out += out === '' || out.endsWith('\n') ? l : ` ${l}`
      }
    }
    return keep ? `${out}\n` : out
  }

  function value(rest, indent) {
    if (/^[|>]-?$/.test(rest)) return blockScalar(rest, indent)
    if (rest !== '') return scalar(rest, `line ${lines[pos - 1].i + 1}`)
    // Nested block, or nothing.
    if (pos >= lines.length) return null
    const next = lines[pos]
    if (next.indent > indent) return block(next.indent)
    if (next.indent === indent && next.text.startsWith('- '))
      return block(indent)
    return null
  }

  function mapping(indent) {
    const out = {}
    while (pos < lines.length && lines[pos].indent === indent) {
      const { text } = lines[pos]
      if (text.startsWith('- ') || text === '-') break
      const m = /^([^\s:'"[{][^:]*?|'[^']*'|"[^"]*"):(?:\s+(.*))?$/.exec(text)
      if (!m) throw new YamlError(`${where()}: not a key: ${text}`)
      const key = String(scalar(m[1], where()))
      if (key in out) throw new YamlError(`${where()}: duplicate key ${key}`)
      pos++
      out[key] = value(m[2] ?? '', indent)
    }
    return out
  }

  function sequence(indent) {
    const out = []
    while (
      pos < lines.length &&
      lines[pos].indent === indent &&
      (lines[pos].text.startsWith('- ') || lines[pos].text === '-')
    ) {
      const rest = lines[pos].text.slice(1).trimStart()
      if (rest === '') {
        pos++
        out.push(value('', indent))
      } else if (/^([^\s:'"[{][^:]*?):(\s|$)/.test(rest)) {
        // `- key: …`: a mapping whose keys sit two columns in.
        lines[pos] = { ...lines[pos], indent: indent + 2, text: rest }
        out.push(mapping(indent + 2))
      } else {
        pos++
        out.push(scalar(rest, `line ${lines[pos - 1].i + 1}`))
      }
    }
    return out
  }

  function block(indent) {
    const t = lines[pos].text
    return t.startsWith('- ') || t === '-' ? sequence(indent) : mapping(indent)
  }

  if (!lines.length) return null
  const doc = block(lines[0].indent)
  if (pos < lines.length)
    throw new YamlError(`line ${lines[pos].i + 1}: unexpected indentation`)
  return doc
}
