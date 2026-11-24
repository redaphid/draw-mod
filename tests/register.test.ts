import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { laneHandles } from '../hooks/lib'

const SHA = '00eb9973717b84359a2cc4571004eb554c28b8c87fc8aa356e29c871f7f81cb1'
const SCRIPT_PATH = '/home/lair/.cache/draw/listener-00eb9973717b8435.mjs'

const handle = (board: string, agent: string, expires: number) =>
  `${btoa(JSON.stringify({ k: 'lane', b: board, f: `${agent}-frame`, a: `claude/${agent}`, p: 'agent:hypnodroid@example.com', x: expires }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}.not-a-real-signature`

const answer = (board: string) =>
  [
    'script https://draw.hypnodroid.com/api/listener.mjs',
    `sha256 ${SHA}`,
    'path $HOME/.cache/draw/listener-00eb9973717b8435.mjs',
    `run node "$HOME/.cache/draw/listener-00eb9973717b8435.mjs" --board ${board} --listen --ticket eyJiIjoidGhlLWxhaXIiLCJwIjoiaHVtYW46dGh1bmRlcndyZW5jaEBleGFtcGxlLmNvbSIsInciOiJodW1hbjp0aHVuZGVyd3JlbmNoQGV4YW1wbGUuY29tL2NsYXVkZS1jb2RlLTEiLCJ4IjoxfQ.sig`,
  ].join('\n')

const LIST = {
  command: 'draw',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
}

type Listen = { argv: readonly string[]; end: (stdout: string, code: number) => void }

// The engine beneath the mod: a draw MCP, a shell, the agent roster and the delivery nouns, all in memory.
function world(on: On) {
  const clock = mock.clock(on)
  const state = {
    agents: [] as string[],
    mintFails: false,
    listenerCalls: [] as Record<string, unknown>[],
    listens: [] as Listen[],
    runs: [] as (readonly string[])[],
    sends: [] as { to: string; text: string }[],
    prompts: [] as string[],
    toasts: [] as string[],
    lanes: [] as (string | undefined)[],
    calls: [] as Record<string, unknown>[],
    claims: [] as Record<string, unknown>[],
    spawned: [] as { subagentType: string; prompt: string }[],
    registered: [] as { disallowedTools?: readonly string[] }[],
    nextAgent: 's1',
    claimable: '',
    answers: {} as Record<string, string>,
    brokenReads: false,
    denials: [] as string[],
    gate: undefined as Promise<void> | undefined,
    unreachable: [] as string[],
    sendThrows: false,
    sendGate: undefined as Promise<void> | undefined,
    mintGate: undefined as Promise<void> | undefined,
    holdNextRead: undefined as Promise<void> | undefined,
    promptGate: undefined as Promise<void> | undefined,
    holdNextWrite: undefined as Promise<void> | undefined,
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'draw' } }))
  on('agent.register', (_$, e) => (state.registered.push({ ...e }), { value: { agent: 'draw:lane-worker' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => (state.toasts.push(String(e.text)), { value: undefined }))
  on('agent.list', async () => {
    if (state.gate) await state.gate
    return {
      value: state.agents.map(id => ({ id, description: id, type: 'general-purpose', status: 'idle' as const })),
    }
  })
  on('state.get', async (_$, e, next) => {
    const hold = state.holdNextRead
    state.holdNextRead = undefined
    if (hold) await hold
    if (state.brokenReads) return { value: null } as never
    return next(e)
  })
  on('state.set', async (_$, e, next) => {
    const hold = state.holdNextWrite
    state.holdNextWrite = undefined
    if (hold) await hold
    return next(e)
  })
  on('mcp.call', async (_$, e) => {
    expect(e.server).toBe('claude.ai draw')
    if (e.tool === 'lanes') state.claims.push({ ...e.args })
    if (e.tool === 'lanes') return { value: { content: [{ type: 'text', text: JSON.stringify({ lane: state.claimable }) }], isError: false } }
    state.listenerCalls.push({ ...e.args })
    if (state.mintGate) await state.mintGate
    if (state.mintFails) return { value: { content: [{ type: 'text', text: 'board unreachable' }], isError: true } }
    return { value: { content: [{ type: 'text', text: answer('the-lair') }], isError: false } }
  })
  on('process.run', (_$, e) => {
    state.runs.push(e.argv)
    const [command] = e.argv
    const stdout = command === 'printenv' ? '/home/lair\n' : command === 'shasum' ? `${SHA}  file\n` : ''
    return { value: { exitCode: command === 'test' ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$, e) {
    let end: Listen['end'] = () => {}
    const done = new Promise<{ stdout: string; code: number }>(resolve => {
      end = (stdout, code) => resolve({ stdout, code })
    })
    state.listens.push({ argv: e.argv, end })
    const { stdout, code } = await done
    if (stdout) yield { stream: 'stdout' as const, text: stdout }
    return { value: { code, signal: null } }
  })
  // Like the engine, delivery resumes a finished agent whether or not the roster still lists it.
  on('session.send', async (_$, e) => {
    const to = typeof e.to === 'string' ? e.to : JSON.stringify(e.to)
    state.sends.push({ to, text: e.text })
    if (state.sendGate) await state.sendGate
    if (state.sendThrows) throw new Error('the engine broke')
    return state.unreachable.some(id => to.includes(id))
      ? { isDelivered: false as const, reason: 'unknown agent' }
      : { isDelivered: true as const }
  })
  on('prompt.submit', async (_$, e) => {
    state.prompts.push(e.text)
    if (state.promptGate) await state.promptGate
    return { text: e.text }
  })
  on('tool.call', (_$, e) => {
    state.lanes.push('lane' in e && typeof e.lane === 'string' ? e.lane : undefined)
    state.calls.push({ ...e })
    const opened = e.tool === 'mcp__claude_ai_draw__open' && 'boardName' in e ? `opened ${String(e.boardName)} · https://draw.hypnodroid.com/b/${String(e.boardName)}` : ''
    return { result: {}, text: state.answers[e.tool.replace('mcp__claude_ai_draw__', '')] ?? opened }
  })
  on('agent.spawn', (_$, e) => (state.spawned.push({ subagentType: e.subagentType, prompt: e.prompt }), { model: 'opus', agentId: state.nextAgent }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.run', () => ({ text: '' }))
  return { clock, state }
}

const send = (sent: string, board = 'the-lair') => `${JSON.stringify({ sent, board, by: 'human:hypnodroid@example.com', note: 'hello' })}\n`

const turnEnd = (agentId?: string) => ({
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
})

describe('register', () => {
  const armLane = async ($: Engine, agent: string, lane: string) => {
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane, agentId: agent })
    await $.turn.complete(turnEnd(agent))
  }

  test('a lane whose agent left the roster keeps it as owner, and a Send resumes that agent', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['a1']
    await armLane($, 'a1', handle('the-lair', 'rusty', 1))
    await clock.settle()
    state.agents = []
    state.listens[0]?.end('', 2)
    await clock.advance(1_000)
    expect(state.listens).toHaveLength(2)

    state.listens[1]?.end(send('send-1'), 0)
    await clock.settle()
    expect(state.sends.map(s => s.to).join()).toContain('a1')
    expect(state.prompts).toEqual([])
  })

  test('a Send its agent cannot be reached for goes to the main session, worded as rerouted', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['a9']
    state.unreachable = ['a9']
    await armLane($, 'a9', handle('the-lair', 'lost', 1))
    await clock.settle()
    state.listens[0]?.end(send('send-13'), 0)
    await clock.settle()
    expect(state.prompts.join('\n')).toContain('send-13')
    expect(state.prompts.join('\n')).toContain('could not be reached')

    await $.turn.complete(turnEnd())
    await clock.settle()
    state.listens.at(-1)?.end(send('send-16'), 0)
    await clock.settle()
    expect(state.prompts.at(-1)).toContain('send-16')
    expect(state.prompts.at(-1)).toContain('could not be reached')
  })

  test('a delivery that throws still leads to the next listen', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['t1']
    state.sendThrows = true
    await armLane($, 't1', handle('the-lair', 'thorn', 1))
    await clock.settle()
    state.listens[0]?.end(send('send-14'), 0)
    await clock.settle()
    await clock.advance(1_000)
    expect(state.listens).toHaveLength(2)
    expect(state.toasts.join()).toContain('send-14')
  })

  test('a new handle tracked while a ticket is minted is the one the next listen uses', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['m1']
    let release = () => {}
    state.mintGate = new Promise(resolve => {
      release = resolve
    })
    await armLane($, 'm1', handle('the-lair', 'mint', 1))
    await clock.settle()
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane: handle('the-lair', 'mint', 2), agentId: 'm1' })
    state.mintGate = undefined
    release()
    await clock.settle()
    state.listens[0]?.end('', 2)
    await clock.advance(1_000)
    expect(state.listenerCalls.at(-1)?.lane).toBe(handle('the-lair', 'mint', 2))
  })

  test('a new handle tracked while a Send is handed over is the one the next listen uses', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['h1']
    await armLane($, 'h1', handle('the-lair', 'hand', 1))
    await clock.settle()
    let release = () => {}
    state.sendGate = new Promise(resolve => {
      release = resolve
    })
    state.listens[0]?.end(send('send-15'), 0)
    await clock.settle()
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane: handle('the-lair', 'hand', 2), agentId: 'h1' })
    state.sendGate = undefined
    release()
    await clock.settle()
    await $.turn.complete(turnEnd('h1'))
    await clock.settle()
    state.listens.at(-1)?.end('', 2)
    await clock.advance(1_000)
    expect(state.listenerCalls.at(-1)?.lane).toBe(handle('the-lair', 'hand', 2))
  })

  test('one lane agent under two handles gets one listener, and the newest owner hears it', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['b1', 'b2']
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane: handle('the-lair', 'pip', 1), agentId: 'b1' })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane: handle('the-lair', 'pip', 2), agentId: 'b2' })
    await $.turn.complete(turnEnd('b2'))
    await clock.settle()
    expect(state.listens).toHaveLength(1)

    state.listens[0]?.end(send('send-2'), 0)
    await clock.settle()
    expect(state.sends).toHaveLength(1)
    expect(state.sends[0]?.to).toContain('b2')
  })

  test('two turn ends at once arm a lane once', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['c1']
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane: handle('the-lair', 'moth', 1), agentId: 'c1' })
    let open = () => {}
    state.gate = new Promise(resolve => {
      open = resolve
    })
    const ends = Promise.all([$.turn.complete(turnEnd('c1')), $.turn.complete(turnEnd('c1'))])
    await clock.settle()
    state.gate = undefined
    open()
    await ends
    await clock.settle()
    expect(state.listenerCalls).toHaveLength(1)
    expect(state.listens).toHaveLength(1)
    for (const listen of state.listens) listen.end('', 1)
    await clock.settle()
  })

  test('the listener script is fetched to a temporary name and moved into place once checked', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['d1']
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane: handle('the-lair', 'wren', 1), agentId: 'd1' })
    await $.turn.complete(turnEnd('d1'))
    await clock.settle()
    const curl = state.runs.find(argv => argv[0] === 'curl')
    const target = curl?.[curl.indexOf('-o') + 1] ?? ''
    expect(target).not.toBe(SCRIPT_PATH)
    expect(target.startsWith(SCRIPT_PATH)).toBe(true)
    expect(state.runs).toContainEqual(['mv', '-f', target, SCRIPT_PATH])
    for (const listen of state.listens) listen.end('', 1)
    await clock.settle()
  })

  test('while the plugin listens for a lane, its agent may not run listener or wait_for_send', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['e1']
    const lane = handle('the-lair', 'quill', 1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane, agentId: 'e1' })
    await clock.settle()
    for (const tool of ['mcp__claude_ai_draw__listener', 'mcp__claude_ai_draw__wait_for_send'] as const) {
      const result = await $.tool.call({ tool, lane: handle('the-lair', 'quill', 5), agentId: 'e1' })
      expect(JSON.stringify(result)).toContain('already listens here for you')
    }
  })

  test('a listener that keeps failing says so, shows failing, and still retries', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['f1']
    state.mintFails = true
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane: handle('valley-of-the-sun', 'ember', 1), agentId: 'f1' })
    await $.turn.complete(turnEnd('f1'))
    await clock.advance(10 * 60_000)
    expect(state.toasts.filter(t => t.includes('cannot listen'))).toHaveLength(1)
    const listing = await $.command.run(LIST)
    expect(listing.text).toContain('failing')
    const before = state.listenerCalls.length
    await clock.advance(60_000)
    expect(state.listenerCalls.length).toBe(before + 1)
    await clock.settle()
  })

  test("a failed mint is not re-armed by its agent's turn end before its backoff", async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['g1']
    state.mintFails = true
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let failed = () => {}
    const failing = new Promise<void>(resolve => {
      failed = resolve
    })
    state.mintGate = failing.then(() => {
      state.holdNextRead = held
    })
    await armLane($, 'g1', handle('the-lair', 'gale', 1))
    failed()
    await clock.settle()
    await $.turn.complete(turnEnd('g1'))
    await clock.settle()
    release()
    await clock.settle()
    expect(state.listenerCalls).toHaveLength(1)
  })

  test('a Send still being handed over when the main session opens another board leaves the new listener listening', async ($, on) => {
    const { clock, state } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__open', boardName: 'the-lair' })
    await $.turn.complete(turnEnd())
    await clock.settle()
    let release = () => {}
    state.promptGate = new Promise(resolve => {
      release = resolve
    })
    state.listens[0]?.end(send('send-3'), 0)
    await clock.settle()
    await $.tool.call({ tool: 'mcp__claude_ai_draw__open', boardName: 'valley-of-the-sun' })
    await $.turn.complete(turnEnd())
    await clock.settle()
    expect(state.listens).toHaveLength(2)
    state.promptGate = undefined
    release()
    await clock.settle()
    const listing = await $.command.run(LIST)
    expect(listing.text).toContain('listening')
  })

  const spawn = (prompt: string, subagentType = 'general-purpose', parentAgentId?: string) => ({
    tool_use_id: 'tu',
    prompt,
    description: 'plan the lair',
    subagentType,
    provider: { plugin: 'engine', tier: 'builtin' as const },
    parentModel: 'opus',
    background: true,
    fork: subagentType === 'fork',
    ...(parentAgentId ? { parentAgentId } : {}),
  })

  test('a subagent keeps its canvas while it works or after it leaves the roster, and loses it after a day idle', async ($, on) => {
    const { clock, state } = world(on)
    const hour = 60 * 60 * 1000
    state.agents = ['s1']
    const lane = handle('the-lair', 'scope', 1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn(`Draw the plan. Lane handle: ${lane}`))
    state.agents = []
    await clock.advance(23 * hour)
    await $.turn.complete(turnEnd())
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 's1' })
    await clock.advance(23 * hour)
    await $.turn.complete(turnEnd())
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1' })
    await clock.advance(25 * hour)
    await $.turn.complete(turnEnd())
    await clock.settle()
    const released = await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1' })
    expect(state.lanes.slice(1)).toEqual([lane])
    expect(JSON.stringify(released)).toContain('released after a day')
  })

  test('a scoped subagent keeps its own type and its handle, and is told of its canvas', async ($, on) => {
    const { state } = world(on)
    state.agents = ['s1']
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn(`Review PR 9. Lane handle: ${handle('the-lair', 'scope', 1)}`))
    expect(state.spawned[0]?.subagentType).toBe('general-purpose')
    expect(state.spawned[0]?.prompt).toContain(handle('the-lair', 'scope', 1))
    expect(state.spawned[0]?.prompt).toContain('Your canvas is the draw frame "scope-frame"')
    expect(state.registered[0]?.disallowedTools).toContain('mcp__claude_ai_draw__open')
  })

  test("a scoped subagent's calls carry its own lane, even over one it passes, and whole-board tools are refused", async ($, on) => {
    const { state } = world(on)
    state.agents = ['s1']
    const lane = handle('the-lair', 'scope', 1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn(`Lane handle: ${lane}`))
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1' })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1', lane: handle('the-lair', 'stranger', 1) })
    const opened = await $.tool.call({ tool: 'mcp__claude_ai_draw__open', agentId: 's1', boardName: 'valley-of-the-sun' })
    expect(state.lanes).toEqual([lane, lane])
    expect(JSON.stringify(opened)).toContain('not available here')
  })

  test("a lane another agent owns keeps its owner when a scoped agent passes that lane's handle", async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['s1', 'o1']
    const theirs = handle('the-lair', 'owner', 1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 'o1', lane: theirs })
    await $.agent.spawn(spawn(`Lane handle: ${handle('the-lair', 'scope', 1)}`))
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1', lane: theirs })
    await $.turn.complete(turnEnd('o1'))
    await clock.settle()
    state.listens.at(-1)?.end(send('send-7'), 0)
    await clock.settle()
    expect(state.sends.map(s => s.to).join()).toContain('o1')
  })

  test("a scoped subagent's board and frame are dropped, since its lane handle already names them", async ($, on) => {
    const { state } = world(on)
    state.agents = ['s1']
    const lane = handle('the-lair', 'scope', 1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn(`Lane handle: ${lane}`))
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1', board: 'valley-of-the-sun', frame: 'elsewhere' })
    expect(state.calls[0]).toMatchObject({ lane })
    expect(state.calls[0]).not.toHaveProperty('board')
    expect(state.calls[0]).not.toHaveProperty('frame')
  })

  test('an unscoped subagent may not name a board other than the main session\'s, which would move everyone there', async ($, on) => {
    const { state } = world(on)
    state.agents = ['u1']
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__open', boardName: 'the-lair' })
    const away = await $.tool.call({ tool: 'mcp__claude_ai_draw__read', agentId: 'u1', board: 'valley-of-the-sun' })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__read', agentId: 'u1', board: 'the-lair' })
    expect(JSON.stringify(away)).toContain('may not name another board')
    expect(state.calls.map(c => c.board)).toEqual([undefined, 'the-lair'])
  })

  test('the main session naming a board on any tool listens there, as open would', async ($, on) => {
    const { clock, state } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', board: 'the-lair' })
    await $.turn.complete(turnEnd())
    await clock.settle()
    expect(state.listens).toHaveLength(1)
    expect(state.listens[0]?.argv).toContain('--listen')
  })

  test('a child or a fork of a scoped agent works on the same canvas', async ($, on) => {
    const { state } = world(on)
    state.agents = ['s1', 'k1', 'f1']
    const lane = handle('the-lair', 'scope', 1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn(`Lane handle: ${lane}`))
    state.nextAgent = 'k1'
    await $.agent.spawn(spawn('Help with the plan.', 'general-purpose', 's1'))
    state.nextAgent = 'f1'
    await $.agent.spawn(spawn('carry on', 'fork', 's1'))
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 'k1' })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 'f1' })
    const opened = await $.tool.call({ tool: 'mcp__claude_ai_draw__open', agentId: 'f1', boardName: 'valley-of-the-sun' })
    expect(state.lanes).toEqual([lane, lane])
    expect(JSON.stringify(opened)).toContain('not available here')
    expect(state.spawned[2]?.subagentType).toBe('fork')
  })

  test('a lane worker spawned with no lane gets one claimed, and its Sends name only its canvas', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['s1']
    state.claimable = handle('the-lair', 'claimed', 1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn('Draw the plan.', 'draw:lane-worker'))
    await $.turn.complete(turnEnd('s1'))
    expect(state.claims[0]).toEqual({ names: [expect.stringMatching(/^[a-z0-9-]+-[0-9a-f]{4}$/)] })
    await clock.settle()
    state.listens.at(-1)?.end(send('send-8'), 0)
    await clock.settle()
    expect(state.sends[0]?.text).toContain('on your canvas')
    expect(state.sends[0]?.text).not.toContain('the-lair')
    expect(state.sends[0]?.text).not.toContain(state.claimable)
  })

  test('a subagent with no canvas, or one whose canvas was forgotten, may not open a board', async ($, on) => {
    const { state } = world(on)
    state.agents = ['u1']
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    for (const tool of ['mcp__claude_ai_draw__open', 'mcp__claude_ai_draw__lanes', 'mcp__claude_ai_draw__theme'] as const) {
      const refused = await $.tool.call({ tool, agentId: 'u1', boardName: 'valley-of-the-sun' })
      expect(JSON.stringify(refused)).toContain('not available to a subagent')
    }
    const main = await $.tool.call({ tool: 'mcp__claude_ai_draw__open', boardName: 'valley-of-the-sun' })
    expect(JSON.stringify(main)).not.toContain('not available')
  })

  test('a resumed lane worker keeps its canvas and no new lane is claimed for it', async ($, on) => {
    const { state } = world(on)
    state.agents = ['s1']
    state.claimable = handle('the-lair', 'claimed', 1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn('Draw the plan.', 'draw:lane-worker'))
    state.claimable = handle('the-lair', 'second', 1)
    await $.agent.spawn({ ...spawn('Answer the Send.', 'draw:lane-worker'), resume: { agentId: 's1' } })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1' })
    expect(state.lanes).toEqual([handle('the-lair', 'claimed', 1)])
  })

  test('an implementer handed a lane passes the real handle on, so a workflow carrier writes its worklog with it', async ($, on) => {
    const { state } = world(on)
    state.agents = ['v1', 'c1']
    const lane = handle('the-lair', 'implementer', 1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    state.nextAgent = 'v1'
    await $.agent.spawn(spawn(`Implement FIELD-1. Your board lane: ${JSON.stringify({ name: 'implementer', lane })}`))
    const brief = state.spawned[0]?.prompt ?? ''
    await $.tool.call({ tool: 'mcp__claude_ai_draw__worklog', agentId: 'v1', lane: laneHandles(brief)[0] })
    state.nextAgent = 'c1'
    await $.agent.spawn(spawn(`Carry the run. board.json: ${brief}`))
    await $.tool.call({ tool: 'mcp__claude_ai_draw__worklog', agentId: 'c1', lane: laneHandles(state.spawned[1]?.prompt ?? '')[0] })
    expect(state.lanes).toEqual([lane, lane])
  })

  test('a fresher handle for its own lane replaces the pinned one, for its calls and its listener', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['s1']
    const old = handle('the-lair', 'scope', 1)
    const fresh = handle('the-lair', 'scope', 2)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn(`Lane handle: ${old}`))
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1', lane: fresh })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1' })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1', lane: old })
    await $.turn.complete(turnEnd('s1'))
    await clock.settle()
    expect(state.lanes).toEqual([fresh, fresh, fresh])
    expect(state.listenerCalls.at(-1)?.lane).toBe(fresh)
  })

  test("a scoped subagent may re-mint its own lane with lanes on its lane's board, and no other", async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['s1']
    const fresh = handle('the-lair', 'scope', 2)
    state.answers.lanes = JSON.stringify({ name: 'scope', lane: fresh })
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn(`Lane handle: ${handle('the-lair', 'scope', 1)}`))
    const away = await $.tool.call({ tool: 'mcp__claude_ai_draw__lanes', agentId: 's1', names: ['scope'] })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__open', boardName: 'the-lair' })
    await $.turn.complete(turnEnd())
    await clock.settle()
    const other = await $.tool.call({ tool: 'mcp__claude_ai_draw__lanes', agentId: 's1', names: ['stranger'] })
    const own = await $.tool.call({ tool: 'mcp__claude_ai_draw__lanes', agentId: 's1', names: ['scope'] })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1' })
    expect(JSON.stringify(away)).toContain('does not have open')
    expect(JSON.stringify(other)).toContain('not available here')
    expect(JSON.stringify(own)).not.toContain('not available')
    expect(state.lanes).toEqual([undefined, undefined, fresh])
  })

  test('an agent whose canvas was released may not draw until it renews its lane or passes one', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['s1']
    const lane = handle('the-lair', 'scope', 2)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.agent.spawn(spawn(`Lane handle: ${handle('the-lair', 'scope', 1)}`))
    await clock.advance(25 * 60 * 60 * 1000)
    await $.turn.complete(turnEnd())
    await clock.settle()
    const refused = await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1' })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1', lane })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1' })
    expect(JSON.stringify(refused)).toContain('Call lanes with your lane\'s name, scope')
    expect(state.lanes).toEqual([lane, lane])
  })

  test('an agent whose canvas was released can renew it with lanes for its own name', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['s1']
    const fresh = handle('the-lair', 'scope', 2)
    state.answers.lanes = JSON.stringify({ name: 'scope', lane: fresh })
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__open', boardName: 'the-lair' })
    await $.agent.spawn(spawn(`Lane handle: ${handle('the-lair', 'scope', 1)}`))
    await clock.advance(25 * 60 * 60 * 1000)
    await $.turn.complete(turnEnd())
    await clock.settle()
    await $.tool.call({ tool: 'mcp__claude_ai_draw__lanes', agentId: 's1', names: ['scope'] })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', agentId: 's1' })
    expect(state.lanes.slice(-1)).toEqual([fresh])
  })

  test("a scoping check that throws refuses a subagent's draw call and lets the main session's through", async ($, on) => {
    const { state } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    state.brokenReads = true
    const refused = await $.tool.call({ tool: 'mcp__claude_ai_draw__open', agentId: 'u1', boardName: 'valley-of-the-sun' })
    const main = await $.tool.call({ tool: 'mcp__claude_ai_draw__listener' })
    expect(JSON.stringify(refused)).toContain('could not check this call')
    expect(JSON.stringify(main)).not.toContain('could not check')
  })

  test('a board opened while the main listener marks itself listening is listened on', async ($, on) => {
    const { clock, state } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__open', boardName: 'the-lair' })
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let minted = () => {}
    state.mintGate = new Promise<void>(resolve => {
      minted = resolve
    }).then(() => {
      state.holdNextRead = held
    })
    await $.turn.complete(turnEnd())
    await clock.settle()
    minted()
    await clock.settle()
    state.mintGate = undefined
    await $.tool.call({ tool: 'mcp__claude_ai_draw__open', boardName: 'valley-of-the-sun' })
    release()
    await clock.settle()
    await $.turn.complete(turnEnd())
    await clock.settle()
    expect(state.listenerCalls).toHaveLength(2)
  })

  test('a new handle tracked while a retry records its failure is the one the next listen uses', async ($, on) => {
    const { clock, state } = world(on)
    state.agents = ['k1']
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    await armLane($, 'k1', handle('the-lair', 'kite', 1))
    await clock.settle()
    state.holdNextWrite = held
    state.listens[0]?.end('', 2)
    await clock.settle()
    await $.tool.call({ tool: 'mcp__claude_ai_draw__draw', lane: handle('the-lair', 'kite', 2), agentId: 'k1' })
    release()
    await clock.settle()
    await clock.advance(1_000)
    expect(state.listenerCalls.at(-1)?.lane).toBe(handle('the-lair', 'kite', 2))
  })
})

// The board wraps another agent's chat line in this note; `to` is set only when it was said to one agent.
const agentLine = (text: string) =>
  `chat on frame talk "talk" from Stopwatch Heron:\n${text}\n\nAn agent said this. Answer with say({ text, frame: "talk" }) only if it asks you something; your answer wakes it.`
const chat = (sent: string, note: string, to: string | null = null, by = 'human:hypnodroid@…/stopwatch') =>
  `${JSON.stringify({ sent, board: 'the-lair', by, to, note, scope: 'chat', mine: true })}\n`

describe('chat lines that are not for this agent', () => {
  const listenMain = async ($: Engine, clock: { settle: () => Promise<void> }, name?: string) => {
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    await $.tool.call({ tool: 'mcp__claude_ai_draw__open', boardName: 'the-lair', ...(name ? { name } : {}) })
    await $.turn.complete(turnEnd())
    await clock.settle()
  }

  test("another agent's line to no one is acked by the next listen and wakes no one", async ($, on) => {
    const { clock, state } = world(on)
    await listenMain($, clock)
    state.listens[0]?.end(chat('send-40', agentLine('Verified: first frame 23% faster (1.74 s to 1.34 s)')), 0)
    await clock.settle()
    expect({ prompts: state.prompts, next: state.listens[1]?.argv.slice(-2) }).toEqual({ prompts: [], next: ['--ack', 'send-40'] })
  })

  test("a person's chat message wakes the agent", async ($, on) => {
    const { clock, state } = world(on)
    await listenMain($, clock)
    const note = 'chat on frame talk from human:hypnodroid@…:\nwhy blue?\n\nAnswer in the chat with say({ text, frame: "talk" }); keep it short, it may be read aloud.'
    state.listens[0]?.end(chat('send-41', note, 'claude-code-1', 'human:hypnodroid@…'), 0)
    await clock.settle()
    expect(state.prompts.join()).toContain('send-41')
  })

  test("another agent's line naming this agent's handle wakes it", async ($, on) => {
    const { clock, state } = world(on)
    await listenMain($, clock)
    state.listens[0]?.end(chat('send-42', agentLine('@claude-code-1 can you check the bench?')), 0)
    await clock.settle()
    expect(state.prompts.join()).toContain('send-42')
  })

  test("another agent's line naming the name this agent took on open wakes it", async ($, on) => {
    const { clock, state } = world(on)
    await listenMain($, clock, 'The Lantern Moth')
    state.listens[0]?.end(chat('send-43', agentLine('the lantern moth, is the profile done?')), 0)
    await clock.settle()
    expect(state.prompts.join()).toContain('send-43')
  })

  test("another agent's line said to this agent with say's to wakes it", async ($, on) => {
    const { clock, state } = world(on)
    await listenMain($, clock)
    state.listens[0]?.end(chat('send-44', agentLine('done, over to you'), 'claude-code-1'), 0)
    await clock.settle()
    expect(state.prompts.join()).toContain('send-44')
  })

  test("a person's selection Send still wakes the agent", async ($, on) => {
    const { clock, state } = world(on)
    await listenMain($, clock)
    state.listens[0]?.end(send('send-45'), 0)
    await clock.settle()
    expect(state.prompts.join()).toContain('send-45')
  })

  // A newer board wakes only the agents a line names, by names the mod may not know (one taken in an earlier session).
  test("a line a newer board woke this agent for wakes it, though the mod does not know the name it uses", async ($, on) => {
    const { clock, state } = world(on)
    await listenMain($, clock)
    const note = `chat on frame talk "talk" from Stopwatch Heron:\nQuiet Bell, is the bench done?\n\nAn agent said this. Answer with say({ text, frame: "talk", to: "Stopwatch Heron" }) only if it asks you something; that wakes it alone.`
    state.listens[0]?.end(chat('send-46', note), 0)
    await clock.settle()
    expect(state.prompts.join()).toContain('send-46')
  })
})
