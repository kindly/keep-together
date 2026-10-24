import fs from 'node:fs'
// Non-blank, non-comment lines. Rust: #[cfg(test)] modules counted as tests.
function count(file) {
  const src = fs.readFileSync(file, 'utf8').split('\n')
  let code = 0,
    test = 0,
    inBlock = false,
    testDepth = -1,
    depth = 0,
    pendingTest = false
  for (const raw of src) {
    let l = raw.trim()
    if (inBlock) {
      if (l.includes('*/')) {
        inBlock = false
        l = l.slice(l.indexOf('*/') + 2).trim()
      } else continue
    }
    if (l.startsWith('/*')) {
      if (!l.includes('*/')) {
        inBlock = true
        continue
      }
      l = l.slice(l.indexOf('*/') + 2).trim()
    }
    if (l === '' || l.startsWith('//') || l.startsWith('*')) continue
    if (file.endsWith('.rs') && l.startsWith('#[cfg(test)]')) {
      pendingTest = true
      test++
      continue
    }
    const opens = (l.match(/{/g) || []).length,
      closes = (l.match(/}/g) || []).length
    if (pendingTest && testDepth < 0 && opens) {
      testDepth = depth
      pendingTest = false
    }
    if (testDepth >= 0) test++
    else code++
    depth += opens - closes
    if (testDepth >= 0 && depth <= testDepth) testDepth = -1
  }
  return { code, test }
}
const groups = JSON.parse(process.argv[2])
for (const [name, files] of Object.entries(groups)) {
  let code = 0,
    test = 0
  for (const f of files) {
    const c = count(f)
    const isTest = /\.test\.|\/tests\/|_test\.rs/.test(f)
    if (isTest) test += c.code + c.test
    else {
      code += c.code
      test += c.test
    }
  }
  console.log(
    `${name.padEnd(48)} code ${String(code).padStart(6)}  tests ${String(test).padStart(6)}  files ${files.length}`,
  )
}
