import { mentionSpans } from './hub.ts';

/** What a message's Copy puts on the clipboard (board #68, owner
 * 2026-11-07: "复制消息时…不用把最前面 @ 的 Agent 名字复制进来"): the body as
 * written, minus its LEADING run of `@addresses` and the spaces or `, ， 、 : ：`
 * after them. Addresses are read by `mentionSpans`, the server's grammar, so
 * an email or a mid-sentence `@bob` stays. A body that is only addresses
 * copies as empty text: the owner excluded the leading names, with no
 * exception (validator P1 on #68). */
export function copyBody(body: string): string {
  const gap = /^[\s,，、:：]*/u;
  let at = gap.exec(body)![0].length, cut = -1;
  for (const span of mentionSpans(body)) {
    if (span.at !== at) break;
    at = span.at + 1 + span.name.length;
    at += gap.exec(body.slice(at))![0].length;
    cut = at;
  }
  return cut >= 0 ? body.slice(cut) : body;
}
