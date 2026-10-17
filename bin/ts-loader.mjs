// 只干一件事：把包内的 .ts 源码擦掉类型后当 ESM 交给 Node。
// 用 Node 自带的 module.stripTypeScriptTypes（22.13+），不引入任何依赖。
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

// 这条 loader 跑在 Node 的 hooks 线程里，ExperimentalWarning 也是在这条线程发出的
// （主线程里改 process.emitWarning 拦不住），所以在这里滤掉它。
const emitWarning = process.emitWarning
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (text.includes('stripTypeScriptTypes')) return
  return emitWarning.call(process, warning, ...rest)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const source = await readFile(fileURLToPath(url), 'utf8')
    const code = stripTypeScriptTypes(source, { mode: 'strip' })
    return { format: 'module', source: code, shortCircuit: true }
  }
  return nextLoad(url, context)
}
