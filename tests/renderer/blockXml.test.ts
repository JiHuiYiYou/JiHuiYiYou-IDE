// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { domToTree, treeToDom } from '../../src/renderer/blocks/xml'
import type { BlockTree } from '../../src/lang/blocks/tree'

/**
 * 块树 ⇄ Blockly XML 的往返。
 *
 * ⚠️ 这里盯的是**一个曾经把代码悄悄改掉**的 bug：
 * `domToTree` 原来用 `querySelector('value[name="X"] > block')` —— 那是搜
 * **所有后代**，不是直接子节点。嵌套的同名输入会**遮蔽**外层的那个：
 *
 *   fib(n - 1) + fib(n - 2)
 *        └────┬────┘  └────┬────┘
 *      外层 binop 的 RIGHT 命中了**左半边** `fib(n-1)` 里面那个
 *      同名的 `value[name="RIGHT"]` ⇒ `fib(n - 2)` 变成了 `1`。
 *
 * 结果是：用户打开文件，源码被悄悄改写。**所以必须用 `:scope >`**。
 */

/** `fib(n - 1) + fib(n - 2)` 的块树。 */
function fibBody(): BlockTree {
  const call = (n: number): BlockTree => ({
    type: 'jhyy_call',
    fields: { NAME: 'fib' },
    inputs: {},
    statements: {
      ARGS: [
        {
          type: 'jhyy_arg',
          fields: {},
          inputs: {
            ARG: {
              type: 'jhyy_binop',
              fields: { OP: '-' },
              inputs: {
                LEFT: { type: 'jhyy_var', fields: { NAME: 'n' }, inputs: {}, statements: {} },
                RIGHT: {
                  type: 'jhyy_value',
                  fields: { KIND: 'number', VALUE: String(n) },
                  inputs: {},
                  statements: {},
                },
              },
              statements: {},
            },
          },
          statements: {},
        },
      ],
    },
  })

  return {
    type: 'jhyy_binop',
    fields: { OP: '+' },
    inputs: { LEFT: call(1), RIGHT: call(2) },
    statements: {},
  }
}

describe('块树 ⇄ XML 往返', () => {
  it('嵌套的同名输入不能遮蔽外层的', () => {
    const tree = fibBody()
    const dom = treeToDom([tree])
    const back = domToTree(dom.firstElementChild!)

    const left = back.inputs!.LEFT!
    const right = back.inputs!.RIGHT!

    // 左边是 fib(n - 1)
    expect(left.type).toBe('jhyy_call')
    expect(left.fields!.NAME).toBe('fib')
    const leftArg = left.statements!.ARGS[0].inputs!.ARG!
    expect(leftArg.type).toBe('jhyy_binop')
    expect(leftArg.inputs!.RIGHT!.fields!.VALUE).toBe('1')

    // 右边**也**得是 fib(n - 2) —— 以前这里会变成 fib(n-1) 里的那个 "1"
    expect(right.type).toBe('jhyy_call')
    expect(right.fields!.NAME).toBe('fib')
    const rightArg = right.statements!.ARGS[0].inputs!.ARG!
    expect(rightArg.type).toBe('jhyy_binop')
    expect(rightArg.inputs!.RIGHT!.fields!.VALUE).toBe('2')
  })

  it('往返之后跟原来一模一样', () => {
    const tree = fibBody()
    const dom = treeToDom([tree])
    expect(domToTree(dom.firstElementChild!)).toEqual(tree)
  })

  it('字段只认直接子节点的', () => {
    const tree: BlockTree = {
      type: 'jhyy_binop',
      fields: { OP: '-' },
      inputs: {
        LEFT: {
          type: 'jhyy_binop',
          fields: { OP: '*' },
          inputs: {
            LEFT: { type: 'jhyy_var', fields: { NAME: 'a' }, inputs: {}, statements: {} },
            RIGHT: { type: 'jhyy_var', fields: { NAME: 'b' }, inputs: {}, statements: {} },
          },
          statements: {},
        },
        RIGHT: { type: 'jhyy_var', fields: { NAME: 'c' }, inputs: {}, statements: {} },
      },
      statements: {},
    }
    const dom = treeToDom([tree])
    const back = domToTree(dom.firstElementChild!)
    // 外层的 OP 是 "-"（不是内层的 "*"）
    expect(back.fields!.OP).toBe('-')
    expect(back.inputs!.LEFT!.fields!.OP).toBe('*')
  })

  it('语句容器里的块按 <next> 链读回来', () => {
    const tree: BlockTree = {
      type: 'jhyy_func',
      fields: { NAME: 'f', RET: 'i32' },
      inputs: {},
      statements: {
        PARAMS: [
          { type: 'jhyy_param', fields: { NAME: 'n', TYPE: 'i32' }, inputs: {}, statements: {} },
        ],
        BODY: [
          { type: 'jhyy_expr_stmt', fields: {}, inputs: {}, statements: {} },
          { type: 'jhyy_expr_stmt', fields: {}, inputs: {}, statements: {} },
        ],
      },
    }
    const dom = treeToDom([tree])
    const back = domToTree(dom.firstElementChild!)
    expect(back.statements!.PARAMS).toHaveLength(1)
    expect(back.statements!.BODY).toHaveLength(2)
    expect(back.statements!.PARAMS[0].fields!.NAME).toBe('n')
  })
})
