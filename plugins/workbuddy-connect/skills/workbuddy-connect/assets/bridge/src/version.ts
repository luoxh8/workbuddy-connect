import { readFileSync } from 'node:fs'

function manifest(): Record<string, unknown> {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * 版本号的唯一来源：包根目录的 `package.json`。
 * 仓库里（`src/` 的上一层）和 npm 安装后（`node_modules/workbuddy-connect/package.json`）
 * 相对位置一致，所以同一个 `import.meta.url` 解析两边都成立。
 */
export function packageVersion(): string {
  const version = manifest().version
  return typeof version === 'string' && version !== '' ? version : '0.0.0'
}

/** 包名，用于把 CLI 的用法提示显示成用户真正敲的那个命令。 */
export function packageName(): string {
  const name = manifest().name
  return typeof name === 'string' && name !== '' ? name : 'workbuddy-connect'
}
