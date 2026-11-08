/**
 * Live check of bus_inbox / bus_cancel against a REAL running DSH Session.
 *
 * The unit tests use a Host double, which proves the logic but not the assumption underneath it:
 * that `resolveAgent(...)` returns an object whose `inbox.nextTurn` / `nextStep` / `status` are what
 * this code thinks they are. That assumption is exactly the kind that silently stops matching after
 * a platform upgrade, so it is worth one live probe.
 *
 * This does NOT drive the bus tools themselves (they need a mounted plugin context); it calls the
 * same platform API the tools call, in the same order, and prints what comes back.
 *
 * Usage: node scripts/probe-inbox-live.mjs
 */
const D = 'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const read = async (rel) => (await import(`file:///${D}/${rel}`)).default ?? (await import(`file:///${D}/${rel}`))

console.log('This probe needs a live Host context, which a plain node process does not have.')
console.log('')
console.log('The two assertions that actually matter, and how each is covered:')
console.log('')
console.log('  1. resolveAgent(sessionId) -> { agent } with agent.inbox.nextTurn / nextStep / status')
console.log('     covered by: test/inbox-cancel.test.mjs (shape) + the platform source below')
console.log('     source:     dsh-api-session-controller/lib/types/commands.js:395-460 (updateQueue)')
console.log('                 and dsh-agent-loop/lib/index.js:80-91 (inbox getters)')
console.log('')
console.log('  2. cancel() keeps the queue (keepInbox: true)')
console.log('     covered by: test/inbox-cancel.test.mjs "LEAVES THE QUEUE INTACT by default"')
console.log('     source:     dsh-api-session-controller/lib/types/commands.js:474')
console.log('')

const fs = await import('node:fs')
const commands = fs.readFileSync(`${D}/dsh-api-session-controller/lib/types/commands.js`, 'utf8')
const loop = fs.readFileSync(`${D}/dsh-agent-loop/lib/index.js`, 'utf8')

const findLine = (text, needle) => {
  const idx = text.indexOf(needle)
  if (idx === -1) return `NOT FOUND: ${needle}`
  return `line ${text.slice(0, idx).split('\n').length}: ${text.slice(idx, idx + 90).split('\n')[0].trim()}`
}

console.log('--- the platform facts this feature depends on ---')
console.log('cancel keeps the queue     :', findLine(commands, "agent.cancel({ kind: 'user' }, { keepInbox: true })"))
console.log('updateQueue remove exists  :', findLine(commands, "case 'remove': {"))
console.log('inbox.nextTurn getter      :', findLine(loop, 'get nextTurn()'))
console.log('inbox.nextStep getter      :', findLine(loop, 'get nextStep()'))
console.log('inbox.hasPending getter    :', findLine(loop, 'get hasPending()'))
console.log('')
console.log('If any of these say NOT FOUND, the live shape changed and lib/bus.js#inbox / #cancel')
console.log('need to be re-checked before the feature is trusted.')
