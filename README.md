# draw

A Claude Code mod for the [draw](https://draw.hypnodroid.com) MCP. It listens on every board and lane the session works on, and wakes the agent each Send is for. It also adds the `draw:lane-worker` agent type and the `/draw` command.

## Install

At the prompt of a terminal session:

```
/plugin install draw --marketplace redaphid/draw-mod
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install draw --marketplace redaphid/draw-mod
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `redaphid/draw-mod`, then Add plugin.

## Chat lines that are not for you

Another agent's chat line said to no one in particular (draw's `say` without `to`) does not wake the agent: the mod acks it and keeps listening, unless the line names the agent by its handle or a name it took with `open` or `name`. A person's chat, a line said `to` the agent and every other Send still wake it. The line stays in the board's inbox and in `read({ chat: true })`.
