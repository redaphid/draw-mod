import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import type { Listener } from '../types'
import {
  HOSTED,
  LANE_WORKER,
  LANE_WORKER_PROMPT,
  LISTEN_TOOLS,
  ROOT_TOOLS,
  WITHHELD,
  canvasNote,
  claimedHandle,
  laneName,
  idle,
  fresher,
  laneNameOf,
  sameLane,
  withHandle,
  MAIN,
  MAX_FAILURES,
  afterDelivery,
  armable,
  describe,
  laneClaims,
  laneHandles,
  openedBoard,
  laneKey,
  handleOf,
  listenArgv,
  unaddressed,
  parseSend,
  parseTicket,
  retryPlan,
  sendText,
  toolPrefix,
  upgrade,
  upsert,
} from './lib'
import type { Send, Ticket } from './lib'

const listeners = atom({ plugin: 'draw', key: 'listeners' } as const, [] as Listener[])
// Each scoped agent's lane handle, by agentId: every draw call it makes carries it.
const scopes = atom({ plugin: 'draw', key: 'scopes' } as const, {} as Record<string, string>)
// The last lane of each agent whose scope was pruned after a day idle: until it has a lane again, it may not draw at all.
const forgotten = atom({ plugin: 'draw', key: 'forgotten' } as const, {} as Record<string, string>)

// Children and tickets die with the module, so a reload re-arms them from the saved listeners.
const children = new Map<string, () => void>()
const tickets = new Map<string, Ticket>()
const failures = new Map<string, number>()
const retrying = new Set<string>()
const downloads = new Map<string, Promise<void>>()
const HEALTHY_MS = 60_000
// stop() bumps a key's generation, so a listen it cut short neither retries nor routes.
const generations = new Map<string, number>()
const server = 'claude.ai draw'
// When each agent last called a tool. A reload starts every scoped agent's day over.
const lastCall = new Map<string, number>()
let home = ''

const textOf = (content: { type: string; text?: string }[]) =>
  content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')

async function save($: EngineInterface, listener: Listener) {
  await update($, listeners, list => upsert(list, listener))
  await refresh($)
}

// Changes only the given fields of the stored record, so what a concurrent `track` wrote survives, and
// nothing once `stale` says a newer arm or `open` has taken the key over.
async function patch($: EngineInterface, key: string, change: Partial<Listener>, stale: () => boolean) {
  await update($, listeners, list => (stale() ? list : list.map(l => (l.key === key ? { ...l, ...change } : l))))
  await refresh($)
}

async function refresh($: EngineInterface) {
  const all = await read($, listeners)
  const live = all.filter(l => l.status === 'listening').length
  $.ui.status(all.length === 0 ? undefined : `listening ${live}/${all.length}`)
}

async function find($: EngineInterface, key: string) {
  return (await read($, listeners)).find(l => l.key === key)
}

async function mint($: EngineInterface, listener: Listener) {
  const args = {
    ...(listener.lane ? { lane: listener.lane } : {}),
    ...(listener.lastSent ? { ack: listener.lastSent } : {}),
  }
  const answer = await $.mcp.call(server, 'listener', args)
  const text = textOf(answer.content)
  if (answer.isError) throw new Error(text.split('\n')[0] || 'listener refused')
  const ticket = parseTicket(text, home)
  if (!ticket) throw new Error('the listener answer was not in the expected form')
  return ticket
}

async function sha256($: EngineInterface, path: string) {
  return (await $.process.run(['shasum', '-a', '256', path])).stdout.split(' ')[0]
}

// The download goes to a temporary name and is moved into place only once its digest matches, so
// listeners arming together never run or delete a half-written script.
async function download($: EngineInterface, ticket: Ticket) {
  if ((await $.process.run(['test', '-f', ticket.path])).exitCode === 0 && (await sha256($, ticket.path)) === ticket.sha256)
    return
  const partial = `${ticket.path}.${Math.random().toString(16).slice(2)}.part`
  await $.process.run(['mkdir', '-p', ticket.path.replace(/\/[^/]+$/, '')])
  const fetched = await $.process.run(['curl', '-fsS', ticket.script, '-o', partial])
  if (fetched.exitCode !== 0) throw new Error(`could not fetch the listener: ${fetched.stderr.trim()}`)
  if ((await sha256($, partial)) !== ticket.sha256) {
    await $.process.run(['rm', '-f', partial])
    throw new Error('the downloaded listener does not match the sha256 the board gave, so it was not run')
  }
  await $.process.run(['mv', '-f', partial, ticket.path])
}

function ensureScript($: EngineInterface, ticket: Ticket) {
  const pending = downloads.get(ticket.path) ?? download($, ticket).finally(() => downloads.delete(ticket.path))
  downloads.set(ticket.path, pending)
  return pending
}

// The key is marked before any await, so a turn end cannot arm it ahead of its backoff.
async function retry($: EngineInterface, key: string, error: string) {
  retrying.add(key)
  const count = (failures.get(key) ?? 0) + 1
  failures.set(key, count)
  tickets.delete(key)
  const plan = retryPlan(count)
  const generation = generations.get(key) ?? 0
  const stale = () => (generations.get(key) ?? 0) !== generation
  $.clock.after(plan.ms, () => {
    if (stale()) return
    retrying.delete(key)
    void arm($, key)
  })
  const board = (await find($, key))?.board
  if (plan.announce) $.ui.toast(`draw cannot listen on ${board ?? 'a board'} (${error}); it keeps retrying every minute`)
  await patch($, key, { status: count >= MAX_FAILURES ? 'failing' : 'waiting', error }, stale)
}

// Answers the agent that now owns the listener: its lane agent, or undefined for the main session.
async function deliver($: EngineInterface, listener: Listener, send: Send) {
  if (listener.owner) {
    const scoped = (await scopeOf($, listener.owner)) === listener.lane
    const sent = await $.session.send({ to: { agentId: listener.owner }, text: sendText(send, listener, { scoped }) })
    if (sent.isDelivered) return listener.owner
    await $.prompt.submit({ text: sendText(send, listener, { rerouted: true }) })
    return undefined
  }
  await $.prompt.submit({ text: sendText(send, listener, { rerouted: Boolean(listener.lane) }) })
  return undefined
}

// Runs one listen: a Send wakes its agent, and the next listen starts once that agent's turn ends,
// so the board's baseline is taken after the agent's answer, as the listen skill says.
async function arm($: EngineInterface, key: string) {
  if (children.has(key)) return
  children.set(key, () => {})
  const listener = await find($, key)
  if (!listener) return void children.delete(key)
  const generation = generations.get(key) ?? 0
  const stale = () => (generations.get(key) ?? 0) !== generation
  try {
    const ticket = tickets.get(key) ?? (await mint($, listener))
    if (stale()) return
    tickets.set(key, ticket)
    await ensureScript($, ticket)
    if (stale()) return
    const env: Record<string, string> = ticket.origin === HOSTED ? {} : { DRAW_URL: ticket.origin }
    const child = $.process.spawn({ argv: listenArgv(ticket, listener.lastSent), env })
    children.set(key, () => void child.return({ code: null, signal: 'SIGTERM' }))
    await patch($, key, { board: ticket.board, status: 'listening', error: undefined }, stale)
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    for await (const chunk of child) {
      if (chunk.stream === 'stdout') stdout += chunk.text
      if (chunk.stream === 'stderr') stderr += chunk.text
    }
    const { code } = await child.result
    if (stale()) return
    children.delete(key)
    const current = (await find($, key)) ?? listener
    // A listen that ran a while was healthy, so an expiry after it starts the failure count over.
    if (Date.now() - started > HEALTHY_MS) failures.delete(key)
    if (code === 2) return await retry($, key, 'ticket expired')
    const send = code === 0 ? parseSend(stdout) : undefined
    if (!send) return await retry($, key, stderr.trim().split('\n').pop() || `listener exited ${code}`)
    failures.delete(key)
    if (unaddressed(send, namesOf(current, ticket))) {
      // Acked by the next listen, which starts now: no turn of this agent's will end to start it.
      log($, `${send.sent}: another agent's chat line to no one in particular, acked without waking the agent`)
      await update($, listeners, list => afterDelivery(list, key, send, current.owner))
      await refresh($)
      return void arm($, key)
    }
    let threw = false
    const owner = await deliver($, current, send).catch(error => {
      threw = true
      $.ui.toast(`draw could not hand ${send.sent} on ${send.board ?? current.board} to its agent: read it with the draw read tool`)
      log($, error)
      return current.owner
    })
    if (stale()) return
    await update($, listeners, list => afterDelivery(list, key, send, owner))
    await refresh($)
    // Nothing woke an agent whose turn end would re-arm the lane, so the backoff does.
    if (threw) await retry($, key, `could not hand over ${send.sent}`)
  } catch (error) {
    if (stale()) return
    children.delete(key)
    await retry($, key, error instanceof Error ? error.message : String(error))
  }
}

// What other agents' chat lines may call this listener's agent: its handle on the board and the names it took there.
const namesOf = (listener: Listener, ticket: Ticket) =>
  [handleOf(ticket.watcher), handleOf(listener.lane ? laneClaims(listener.lane)?.agent : undefined), ...(listener.names ?? [])].filter(
    (name): name is string => Boolean(name),
  )

// One listener per lane agent, whatever handle names it: a fresh handle and owner replace the old ones.
async function track($: EngineInterface, lane: string, owner: string) {
  const claims = laneClaims(lane)
  if (!claims) return
  const key = laneKey(claims)
  const known = await find($, key)
  if (known?.owner === owner && known.lane === lane) return
  await save($, {
    key,
    lane,
    owner,
    board: claims.board,
    frame: claims.frame,
    lastSent: known?.lastSent,
    status: known?.status ?? 'waiting',
  })
}

// `board` is where the main session now sits: the one `open` answered with, or the one a call named.
async function learn($: EngineInterface, agentId: string | undefined, lane: string | undefined, sat: { board?: string } | undefined) {
  if (agentId && lane) return track($, lane, agentId)
  if (agentId || !sat) return
  const names = (await find($, MAIN))?.names
  stop(MAIN)
  failures.delete(MAIN)
  retrying.delete(MAIN)
  await save($, { key: MAIN, ...sat, status: 'waiting', ...(names ? { names } : {}) })
}

const log = ($: EngineInterface, error: unknown) =>
  $.ui.log(`draw: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })

async function scopeOf($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return undefined
  return (await read($, scopes))[agentId]
}

async function pin($: EngineInterface, agentId: string, lane: string) {
  await update($, scopes, all => ({ ...all, [agentId]: lane }))
  await update($, forgotten, all => Object.fromEntries(Object.entries(all).filter(([id]) => id !== agentId)))
  await track($, lane, agentId).catch(error => log($, error))
  return lane
}

const ownLanes = (e: object, scoped: string) =>
  'names' in e && Array.isArray(e.names) && e.names.length > 0 && e.names.every((name: unknown) => name === laneNameOf(scoped))

const ASK_AGAIN = 'Ask whoever dispatched you for your lane again.'

async function claimLane($: EngineInterface, description: string) {
  const name = laneName(description, Math.random().toString(16).slice(2, 6))
  const answer = await $.mcp.call(server, 'lanes', { names: [name] })
  if (answer.isError) return undefined
  return claimedHandle(textOf(answer.content))
}

// A subagent given a lane, by handle in its prompt, by its parent's canvas, or by a lane the mod claims for a lane
// worker, works in that lane alone: every handle in its prompt becomes its own, and every draw call carries it.
async function scope($: EngineInterface, e: AgentSpawnInput) {
  const [handle] = laneHandles(e.prompt)
  const inherited = await scopeOf($, e.parentAgentId)
  if (e.subagentType === 'fork') return { lane: inherited, owns: false, e }
  const claimed = handle ?? inherited ?? (e.subagentType === LANE_WORKER ? await claimLane($, e.description) : undefined)
  const claims = claimed ? laneClaims(claimed) : undefined
  if (!claimed || !claims) return { lane: undefined, e }
  return { lane: claimed, owns: !inherited || Boolean(handle), e: { ...e, prompt: withHandle(e.prompt, claimed) + canvasNote(claims.frame) } }
}

function stop(key: string) {
  generations.set(key, (generations.get(key) ?? 0) + 1)
  children.get(key)?.()
  children.delete(key)
  tickets.delete(key)
}

export const register: Register = on => {
  const prefix = toolPrefix(server)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
    await $.command.register({ name: 'draw', description: 'List the draw boards and lanes this session listens on' })
    await $.agent.register({
      name: 'lane-worker',
      description:
        'Draws on one frame of a draw board as its whole canvas and answers the Sends people and agents make there. Use for any subagent that should draw or show its work on a draw board.',
      prompt: LANE_WORKER_PROMPT,
      disallowedTools: WITHHELD.map(tool => prefix + tool),
    })
    await update($, listeners, upgrade)
    for (const listener of await read($, listeners)) void arm($, listener.key)
    return started
  })

  on('command.run', { command: 'draw' }, async $ => ({ text: describe(await read($, listeners)) }))

  on('agent.spawn', async ($, e, next) => {
    // A resumed agent keeps the canvas it had; the engine ignores a rewritten prompt for it anyway.
    if (e.resume) return next(e)
    const scoped = await scope($, e).catch(error => (log($, error), { lane: undefined, owns: false, e }))
    const started = await next(scoped.e)
    const owner = started.agentId
    if (!owner || !scoped.lane) return started
    const lane = scoped.lane
    lastCall.set(owner, await $.clock.now())
    await update($, scopes, all => ({ ...all, [owner]: lane }))
    if (scoped.owns) await track($, lane, owner).catch(error => log($, error))
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) lastCall.set(agentId, await $.clock.now())
    if (!e.tool.startsWith(prefix)) return next(e)
    const tool = e.tool.slice(prefix.length)
    const given = 'lane' in e && typeof e.lane === 'string' ? e.lane : undefined
    const pinned = await scopeOf($, agentId)
    const last = agentId && !pinned ? (await read($, forgotten))[agentId] : undefined
    const scoped =
      agentId && given && ((pinned && fresher(given, pinned)) || (last && sameLane(given, last))) ? await pin($, agentId, given) : pinned
    const own = scoped ?? last
    const listening = LISTEN_TOOLS.includes(tool)
    // `lanes` refuses a handle, so a re-mint of the agent's own lane runs on the main session's board, and only
    // when that is its lane's board; the fresh handle is pinned.
    if (agentId && own && tool === 'lanes' && ownLanes(e, own)) {
      const board = (await find($, MAIN))?.board
      if (board !== laneClaims(own)?.board)
        return { deny: `Your lane is on a board the main session does not have open. ${ASK_AGAIN}` }
      const { lane: _handle, ...bare } = { lane: undefined, ...e }
      const ran = await next(bare)
      const fresh = ran.text ? claimedHandle(ran.text) : undefined
      if (fresh && sameLane(fresh, own)) return (await pin($, agentId, fresh), ran)
      if (ran.deny !== undefined || ran.isError) return ran
      return { ...ran, context: [...(ran.context ?? []), `That handle is not for your lane, so your calls keep using your own. ${ASK_AGAIN}`] }
    }
    // Subagents share the main session's MCP connection, so whether or not one still has a canvas, none may change its board.
    if (agentId && ROOT_TOOLS.includes(tool))
      return {
        deny: scoped
          ? `${tool} is not available here: your canvas is the only board you work on.${tool === 'lanes' ? ' Call lanes only with your own lane name to renew its handle.' : ''}`
          : `${tool} is not available to a subagent: it would change the board for the main session and every other agent.`,
      }
    if (last && !scoped)
      return {
        deny: `Your draw canvas was released after a day without calls, and its handle has expired. Call lanes with your lane's name, ${laneNameOf(last)}, to renew it, or ${ASK_AGAIN.toLowerCase()}`,
      }
    const named = 'board' in e && typeof e.board === 'string' ? e.board : undefined
    const mainBoard = named ? (await find($, MAIN))?.board : undefined
    // Naming another board moves the shared MCP session there, for the main session and every agent at once.
    if (agentId && !scoped && named && named !== mainBoard)
      return { deny: `A subagent may not name another board: it would move the main session and every other agent to ${named}. ${ASK_AGAIN}` }
    const lane = scoped ?? given
    // A lane handle names its own board and frame, and the server refuses a call that also names them.
    const { board: _board, frame: _frame, ...unplaced } = { board: undefined, frame: undefined, ...e }
    const call = scoped && lane ? { ...unplaced, lane } : e
    const claims = agentId && lane ? laneClaims(lane) : undefined
    const key = claims ? laneKey(claims) : MAIN
    if (listening) {
      const listener = await find($, key)
      if (listener && (failures.get(key) ?? 0) < MAX_FAILURES)
        return {
          deny: `The draw plugin already listens here for you (${listener.status}). End your turn when your work is done: each Send reaches you as a message. Do not run listener or wait_for_send.`,
        }
      return next(call)
    }
    const ran = await next(call)
    if (ran.deny !== undefined || ran.isError) return ran
    const opened = tool === 'open' ? openedBoard(ran.text ?? '') : undefined
    const sat = tool === 'open' ? (opened ? { board: opened } : {}) : named && named !== mainBoard ? { board: named } : undefined
    await learn($, agentId, scoped ? undefined : given, sat).catch(error => log($, error))
    const took = (tool === 'name' || tool === 'open') && 'name' in e && typeof e.name === 'string' ? e.name : undefined
    if (took)
      await update($, listeners, list => list.map(l => (l.key === key ? { ...l, names: [...new Set([...(l.names ?? []), took])] } : l))).catch(
        error => log($, error),
      )
    return ran
  }).catch(($, e, next) =>
    // A failed guard must not let a subagent's call through unscoped, so it refuses in the guard's place.
    next.called || !e.agentId || !e.tool.startsWith(prefix)
      ? next(e)
      : { deny: 'The draw plugin could not check this call against your canvas, so it was not run. Try it again.' },
  )

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const now = await $.clock.now()
    const pinnedNow = await read($, scopes)
    const ids = Object.keys(pinnedNow)
    for (const id of ids) if (!lastCall.has(id)) lastCall.set(id, now)
    const gone = idle(ids, lastCall, now)
    for (const id of gone) lastCall.delete(id)
    await update($, scopes, all => Object.fromEntries(Object.entries(all).filter(([id]) => !gone.includes(id))))
    if (gone.length > 0) await update($, forgotten, all => ({ ...all, ...Object.fromEntries(gone.flatMap(id => (pinnedNow[id] ? [[id, pinnedNow[id]]] : []))) }))
    for (const key of armable(await read($, listeners), e.agentId, retrying)) void arm($, key)
    return done
  })
}
