# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Rainyy99/hidden-spec-cli-01-run-20261122-entry2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Rainyy99/hidden-spec-cli-01-run-20261122-entry2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It applies AI-written edits in four formats (unified diff, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls) to a tree of files, to a single written specification — finding the lines an edit names even when the model drifted their whitespace or indentation, and changing every file or none.

Built for the [make.fun](https://make.fun) competition "Build mend, one patch tool for every AI edit format" (hidden-spec-cli-01-run-20261122).

## Run

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library only. No install step.
