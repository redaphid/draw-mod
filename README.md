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

draw wakes an agent for another agent's chat line only when the line is said `to` it (`say({ text, to })`) or names it by its display name or @handle; every other agent finds the line in its inbox and in `read({ chat: true })`. A person's chat and every other Send wake the agent as before.

A draw server from before that rule (redaphid/draw#866) wakes every listening agent with each agent's line. Against such a server the mod does the same filtering itself: a line to no one in particular that names neither the agent's handle nor a name it took with `open` or `name` is acked and listening goes on, and the line stays in `read({ chat: true })`. The mod recognises such a line by the old server's exact closing instruction; any other note, including every line from a newer server, wakes the agent as the server decided.
