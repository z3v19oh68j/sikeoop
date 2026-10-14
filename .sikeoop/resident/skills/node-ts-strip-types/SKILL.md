---
name: node-ts-strip-types
description: 用 Node 内置「类型剥离」直接运行 / 测试 .ts 文件（node xx.ts、node --test）时使用：配 tsconfig、排查 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX、导入找不到模块等问题。
---

# Node 原生跑 TypeScript（类型剥离）

## 什么时候用
- 想不装 tsx/ts-node，直接 `node file.ts` 或 `node --test` 跑 .ts。
- 测试报 `ERR_MODULE_NOT_FOUND`（导入没写后缀）、`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`、或类型导入在运行时报错。

## 版本
- 22.6 起有 `--experimental-strip-types`；23.6 / 22.18 起默认开启；24.12 / 25.2 起稳定；26 删除了 `--experimental-transform-types`。
- 关闭用 `--no-strip-types`。Node **不做类型检查**，类型检查还得跑 `tsc --noEmit`。

## 步骤
1. TypeScript ≥ 5.8，tsconfig 加：
   ```json
   {
     "compilerOptions": {
       "noEmit": true,
       "target": "esnext",
       "module": "nodenext",
       "allowImportingTsExtensions": true,
       "erasableSyntaxOnly": true,
       "verbatimModuleSyntax": true
     }
   }
   ```
   要输出 .js 发布时去掉 noEmit，改用 `rewriteRelativeImportExtensions: true`。
2. 相对导入写全后缀：`import { x } from './registry.ts'`，不是 `'./registry'`。
3. 纯类型用 `import type { T } from './t.ts'` 或 `import { fn, type T }`。
4. 跑 `tsc --noEmit` 先查一遍，再 `node --test`。

## 容易踩的坑
- 不支持：`enum`、带运行时代码的 `namespace`、构造函数参数属性 `constructor(public x)`、`import x = require()`、`export =`、装饰器、`.tsx`。改成 `as const` 对象 + 联合类型、普通字段赋值。
- Node 不读 tsconfig：`paths` 别名不生效，用 package.json 的 `#` 开头 subpath imports 代替。
- 模块系统按 package.json 的 `"type"` 决定；`.mts` 恒为 ESM，`.cts` 恒为 CJS。
- node_modules 里的 .ts 一律不处理。

## 出处
- Node 官方文档 Modules: TypeScript（v26.11.1）：https://nodejs.org/api/typescript.html
- TypeScript 5.8 发布说明：https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html
