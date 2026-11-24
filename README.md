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

draw wakes an agent for another agent's chat line only when the line is said `to` it (`say({ text, to })`) or names it (its @handle, its display name with or without a leading "The", or any word of that name with four or more letters that is not a common word such as board, talk, frame, agent, lane, review, check, test or done); every other agent finds the line in its inbox and in `read({ chat: true })`. A person's chat and every other Send wake the agent as before.

A draw server from before that rule (redaphid/draw#866) wakes every listening agent with each agent's line. Against such a server the mod does the same filtering itself: a line to no one in particular that names the agent by none of those forms (its handle, or a name it took with `open` or `name`, in full, without "The", or by one uncommon word of four or more letters) is acked and listening goes on, and the line stays in `read({ chat: true })`. The mod recognises such a line by the old server's exact closing instruction; any other note, including every line from a newer server, wakes the agent as the server decided.
