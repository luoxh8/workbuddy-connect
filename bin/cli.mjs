#!/usr/bin/env node
// npm 包的入口。两个坑要在这里抹平：
//   1) 装在 node_modules 里时 Node 拒绝对 .ts 做类型擦除（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）
//      → 自己挂一个 loader，把包内 .ts 擦成 JS。
//   2) src/cli.ts 用 `process.argv[1] === import.meta.url` 判断"是不是被直接运行"，
//      这里是被 import 的，所以先把 argv[1] 指回 cli.ts，等价于直接运行它。
// 仓库里直接 `node src/cli.ts ...` 不需要经过本文件。
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

// 类型擦除在 Node 里还是 experimental，会打一条吓人的 warning；这里只滤掉它。
const emitWarning = process.emitWarning
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (text.includes('stripTypeScriptTypes')) return
  return emitWarning.call(process, warning, ...rest)
}

const entry = new URL('../src/cli.ts', import.meta.url)
register('./ts-loader.mjs', import.meta.url)
process.argv[1] = fileURLToPath(entry)

await import(entry.href)
