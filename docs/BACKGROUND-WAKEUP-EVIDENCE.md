# Background wakeup: measured evidence

This file records what agy 1.5.14 actually does on Windows, captured while
building the cross-turn wakeup slices (#156). It exists because the shape of the
evidence — not the intent — decided the design.

Machine: Windows, agy 1.5.14 at `C:\Users\12867\AppData\Local\agy\bin\agy.exe`,
run as `agy -p "<prompt>" --output-format stream-json --dangerously-skip-permissions`.

## 1. A detached command that outlives the turn

Prompt: start a background command that sleeps 45s and prints `EVIDENCE-OK`,
then end the turn immediately.

| time (UTC) | event | source |
|---|---|---|
| 04:35:06 | `run_command` with `WaitMsBeforeAsync: "500"` | `brain/e21edb5b…/.system_generated/logs/transcript.jsonl` step 1 |
| 04:35:08 | `Tool is running as a background task with task id: e21edb5b…/task-2` | same file, step 2 (`GENERIC`, status `RUNNING`) |
| **04:35:09** | **turn ends** — last `PLANNER_RESPONSE` | step 3 |
| **04:35:54** | **completion message written**, 45.0s after the turn ended | `brain/e21edb5b…/.system_generated/messages/ff172462-511d-4142-99fb-1b3b812866af.json` |

The completion message:

```json
{
  "sender": "e21edb5b-175b-4756-8c2d-763e320f7b52/task-2",
  "priority": "MESSAGE_PRIORITY_HIGH",
  "renderDetails": { "messageTitle": "Background sleep task finished" },
  "content": "Task id \"e21edb5b…/task-2\" finished with result:\nCommand exited with code 0.\n\nCommand output:\nEVIDENCE-OK\r\n\nLog: file:///C:/Users/12867/.gemini/antigravity-cli/brain/e21edb5b…/.system_generated/tasks/task-2.log"
}
```

The matching `tasks/task-2.log` contains exactly `EVIDENCE-OK\n` — **no exit
marker**. Across the whole machine (207 task logs, 114 of them under isolated
accounts) the pattern `The command exited with code N` / `[exit code N]` /
`[command timed out]` appears **0 times**. Any detector that watches the log file
for a terminal line therefore never fires on a real run; it only fires on the
mock fixtures that were written from the same wrong assumption.

Conclusion: the completion message is the terminal signal, and slice 2 parses it
(`taskIdFromMessage`, `taskLogFromMessage` in `src/features/background/brain-poll.ts`).

## 2. A one-shot schedule timer that fires after the turn

Prompt: arm the `schedule` tool for 60s, then end the turn.

| time (UTC) | event | source |
|---|---|---|
| 04:37:45 | `schedule` with `DurationSeconds: "60"` | `brain/41379aa6…/logs/transcript.jsonl` step 1 |
| 04:37:47 | `Tool is running as a background task with task id: 41379aa6…/task-2` | step 2 |
| **04:37:47** | **turn ends** | step 3 |
| **04:38:47.757** | **timer message written**, 60s after the turn ended | `messages/aff0f1af-94c8-474f-82e4-66e1af440179.json` |

```json
{
  "sender": "41379aa6-e0bf-4bc4-98bc-d37348fccd00/task-2",
  "renderDetails": { "messageTitle": "1m timer: Timer has expired" },
  "content": "EVIDENCE-TIMER: report the current time"
}
```

Note that a timer's completion message carries the **prompt text**, not an exit
code, and its `tasks/task-2.log` is 0 bytes. Slice 2 keeps timer wakeups on the
slice-1 path (in-process timer armed from the recording) and uses this message
only to cancel a matching `TimerCondition` timer.

## 3. What agy reports for a live call

`transcript.jsonl` steps use `RUNNING` / `DONE` / `ERROR`, while the ACP
transport reports `pending` / `in_progress` / `completed` and maps a live tool
call to `ACTIVE`. Only matching `RUNNING` (the original implementation) silently
misses every ACP turn, so `isStillLive` accepts `running`, `active`, `pending`
and `in_progress`.

## 4. Counter-examples

Each of these has a test in `test/background-followup-wakeup.test.ts`:

- a completion message or task log that already existed when the turn settled
  never wakes the session (baseline snapshot taken at settle time);
- `Language server stopped due to server restart` clears the watch instead of
  waking, and does not retry — an infrastructure restart is not user-actionable;
- the same message / task id / subagent transition wakes exactly once;
- a `TimerCondition` timer is cancelled when the matching completion notice
  arrives first, so the session is not woken twice for the same work;
- with `backgroundWakeup` off (the default) none of the above even subscribes.
