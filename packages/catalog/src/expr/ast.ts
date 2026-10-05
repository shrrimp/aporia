export type Node =
  | { readonly type: 'num'; readonly value: number }
  | { readonly type: 'var'; readonly name: string }
  | { readonly type: 'vec'; readonly items: readonly Node[] }
  | { readonly type: 'unary'; readonly op: '-' | '!'; readonly arg: Node }
  | { readonly type: 'binary'; readonly op: string; readonly left: Node; readonly right: Node }
  | { readonly type: 'cond'; readonly test: Node; readonly then: Node; readonly else: Node }
  | { readonly type: 'call'; readonly fn: string; readonly args: readonly Node[] }
  | { readonly type: 'lambda'; readonly params: readonly string[]; readonly body: Node }
  | { readonly type: 'member'; readonly object: Node; readonly name: string }
  | { readonly type: 'index'; readonly object: Node; readonly index: Node };

/** `name = expr; name2 = expr2` as used by explorable buttons. */
export interface Assignment {
  readonly name: string;
  readonly value: Node;
}
