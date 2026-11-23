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
