# Slack Feedback Loop — Design Spec

## Problem

Worker wysyla powiadomienia na Slack przez webhook (jednokierunkowo). Uzytkownik nie ma mozliwosci odpowiedziec w watku, zeby powiedziec agentowi co poprawic.

## Rozwiazanie

Slack Bolt SDK w Socket Mode — worker nasluchuje na odpowiedzi w watkach Slack i re-uruchamia Claude Code z feedbackiem uzytkownika.

## Wymagania

1. Kazdy kto odpowie w watku moze kierowac agenta (brak ograniczen per user)
2. Feedback podczas aktywnej pracy agenta: kill procesu + restart z feedbackiem
3. Prefix `fix:` = popraw istniejacy kod, `redo:` = zacznij od nowa, brak prefixu = `fix:`
4. Limit rund feedbacku (konfigurowalny), po przekroczeniu pytanie "czy kontynuowac?"
5. Backward compatible — bez tokenow dziala jak dotychczas (webhook only)

## Konfiguracja Slack App

Uzytkownik tworzy Slack App w panelu `api.slack.com/apps`:

- **Socket Mode**: enabled
- **App-Level Token** (`xapp-...`) z scope `connections:write`
- **Bot Token** (`xoxb-...`) z scopes: `chat:write`, `channels:history`, `groups:history`
- **Event Subscriptions**: `message.channels`, `message.groups`

### Nowe env vars

```
SLACK_BOT_TOKEN=xoxb-...        # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...        # App-Level Token (Socket Mode)
SLACK_CHANNEL=C0123456789       # Channel ID do wysylania powiadomien (wymagany gdy bot aktywny)
MAX_FEEDBACK_ROUNDS=3           # Limit rund feedbacku per task (default: 3)
```

Istniejacy `SLACK_WEBHOOK_URL` zostaje jako fallback gdy bot tokens nie ustawione.

## Architektura

### Nowy modul: `src/slack-bot.ts`

Odpowiada za:
- Inicjalizacje Slack Bolt App w Socket Mode
- Nasluchiwanie na wiadomosci w watkach (`message` event)
- Mapowanie `thread_ts` -> `jiraKey`
- Wysylanie wiadomosci przez `chat.postMessage` (zwraca `ts` i `channel`)
- Obsluga komendy potwierdzenia po przekroczeniu limitu rund (`tak`/`nie`)

### Migracja wysylania wiadomosci: webhook -> Bot API

Obecny `sendSlack()` uzywa incoming webhook — nie zwraca `thread_ts`. Gdy bot jest aktywny, notyfikacje sa wysylane przez `app.client.chat.postMessage()` ktory zwraca `{ ts, channel }`. Te wartosci sa zapisywane w store jako `slackThreadTs` i `slackChannel`.

```ts
// slack-bot.ts
async function postMessage(channel: string, blocks: SlackBlock[]): Promise<{ ts: string; channel: string }> {
  const result = await app.client.chat.postMessage({
    channel,
    blocks,
  });
  return { ts: result.ts!, channel: result.channel! };
}

// Odpowiedz w watku:
async function replyInThread(channel: string, threadTs: string, text: string): Promise<void> {
  await app.client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
  });
}
```

### Zmiany w istniejacych modulach

| Modul | Zmiana |
|-------|--------|
| `src/slack.ts` | `notifySuccess`/`notifyFailure` zwracaja `Promise<{ts, channel} \| void>`. Gdy `slackBot.isActive()` — deleguja do `slackBot.postMessage()`. W przeciwnym razie — webhook (jak dotychczas). |
| `src/store.ts` | Nowe pola: `slackThreadTs`, `slackChannel`, `feedbackRound`, `childProcessPid` |
| `src/index.ts` | Start Slack Bolt app obok polling loop. Po `notifySuccess`/`notifyFailure` zapisuje `ts`+`channel` do store. Nowy handler `processTaskWithFeedback()`. Nie startuje bota w trybie `--once`. |
| `src/claude.ts` | Spawn z `detached: true`. Zapisuje `child.pid` do store. Nowa funkcja `runClaudeCodeWithFeedback()`. Eksportuje `killClaudeProcess()`. |
| `src/config.ts` | Nowe env vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL`, `MAX_FEEDBACK_ROUNDS` |

### Flow

```
Slack thread reply
    |
    v
slack-bot.ts: message event
    |
    +-- ignoruj wiadomosci od bota (own bot_id)
    +-- ignoruj message subtypes (bot_message, message_changed, etc.)
    +-- mapuje thread_ts -> jiraKey (lookup w store)
    |     +-- nie znaleziono -> ignoruj (watek nie dotyczy znadego taska)
    |
    +-- sprawdza feedbackRound < MAX_FEEDBACK_ROUNDS
    |     +-- jesli >= limit -> "Czy kontynuowac?" i czeka na "tak"
    |     +-- timeout 24h -> auto-decline
    |
    +-- parsuje prefix: "fix:" -> popraw istniejacy, "redo:" -> od nowa
    |     +-- brak prefixu -> domyslnie "fix:"
    |
    +-- czy Claude Code aktualnie dziala na tym tasku?
    |     +-- TAK -> killClaudeProcess(jiraKey), poczekaj na exit
    |
    +-- reply w watku: "Przetwarzam feedback (runda N)..."
    |
    v
index.ts: processTaskWithFeedback(jiraKey, feedback, mode)
    |
    +-- JIRA: transition back to "In Progress"
    +-- fix:  -> uzyj istniejacego worktree (jesli brak -> fallback na redo)
    +-- redo: -> removeWorktree + createWorktree + zamknij stary PR (`gh pr close`)
    |
    v
claude.ts: runClaudeCodeWithFeedback()
    |
    +-- prompt: oryginalny task + "Human feedback: <tresc>"
    +-- push na ten sam branch (fix) lub nowy branch (redo)
    |
    v
slack-bot.ts: reply w watku -> "Poprawki zastosowane" lub "Blad"
index.ts: JIRA transition -> "In Review"
```

## Store — nowe pola

```ts
interface ProcessedTask {
  jiraKey: string;
  startedAt: string;
  completedAt?: string;
  status: "processing" | "done" | "failed";
  prUrl?: string;
  error?: string;
  slackThreadTs?: string;
  slackChannel?: string;
  feedbackRound: number;
  feedbackClosed?: boolean;
  childProcessPid?: number;
  limitReachedAt?: string;    // ISO timestamp — kiedy osiagnieto limit rund
}
```

## Kill aktywnego procesu

Spawn Claude Code z `detached: true` aby utworzyc process group:

```ts
const child = spawn("claude", args, {
  cwd: workDir,
  detached: true,  // tworzy nowa process group
  stdio: ["ignore", "pipe", "pipe"],
  // ...
});
```

Kill process:
1. Pobierz `childProcessPid` ze store
2. `process.kill(-pid, 'SIGTERM')` — kill calej process group (uwaga: negacja PID)
3. setTimeout 5s — jesli dalej zyje -> `process.kill(-pid, 'SIGKILL')`
4. Czekaj na `close` event (promise), dopiero potem startuj nowe uruchomienie

Zabezpieczenie przed race condition: mutex (`processingLock: Map<jiraKey, Promise>`) w `index.ts`. Feedback handler ustawia lock przed killem, poll loop sprawdza lock przed startem nowego taska.

```ts
// index.ts — in-memory lock
const processingLock = new Map<string, Promise<void>>();
```

## Prompt z feedbackiem

```
## Original Task: MOW-123
<oryginalny prompt>

## Human Feedback (round 2 of 3)
fix: popraw walidacje emaila — brakuje sprawdzenia domeny

## Instructions
Review the existing implementation on this branch.
Apply the feedback above. Do not start from scratch unless prefixed with "redo:".
Push changes and update the existing PR.
```

Przy `redo:` — instrukcja "start fresh, create a new PR" + nowy worktree.

## Limit rund + pytanie o kontynuacje

Gdy `feedbackRound >= MAX_FEEDBACK_ROUNDS`:
- Worker odpowiada w watku: "Osiagnieto limit N rund poprawek. Napisz 'tak' aby kontynuowac kolejne N rund, lub 'nie' aby zakonczyc."
- `"tak"` -> resetuje licznik do 0, przetwarza feedback normalnie
- `"nie"` -> ustawia flage `feedbackClosed: true` w store, ignoruje dalsze wiadomosci, reply: "Praca nad tym taskiem zakonczona."
- cokolwiek innego -> przypomina o `tak`/`nie`
- timeout 24h bez odpowiedzi -> auto-decline. Timestamp zapisany w `limitReachedAt` w store (przezywa restart). Przy kazdym message event sprawdzamy: jesli `limitReachedAt` + 24h < now -> auto-decline, reply: "Brak odpowiedzi — praca zakonczona.", ustaw `feedbackClosed: true`.

Po resecie licznika numeracja kontynuuje: "round 4 of 6", "round 7 of 9" itd.

## JIRA status podczas feedback

- Poczatek feedback rundy: transition do "In Progress" (task wraca do pracy)
- Koniec feedback rundy (sukces): transition do "In Review" + komentarz z nowym PR URL
- Koniec feedback rundy (blad): task zostaje "In Progress", komentarz z bledem

## Obejscie `isProcessed()` guard

`processTaskWithFeedback()` to oddzielna sciezka — nie przechodzi przez `processTask()`. Nie podlega guard `isProcessed()`. Uzywa bezposrednio `markProcessing()` -> `runClaudeCodeWithFeedback()` -> `markDone()`/`markFailed()`.

## Edge cases

### Worker restart
Mapowanie `thread_ts -> jiraKey` jest w `store.ts` (plik na dysku), przezywa restart. Bolt reconnectuje automatycznie. Wiadomosci wyslane w trakcie downtime nie beda przetworzone — user zobaczy brak reakcji i napisze ponownie.

### Wiele taskow jednoczesnie
Feedback handler dziala niezaleznie od poll loop:
- Feedback na **inny** task niz aktualnie przetwarzany -> kolejka (`Map<jiraKey, { feedback, mode }>`)
- Feedback na **ten sam** task -> kill + restart
- Kolejka jest drenowana po zakonczeniu biezacego taska — zarowno w `processTask` jak i `processTaskWithFeedback` (oba maja drain w finally block)
- Wiele feedbackow na ten sam zakolejkowany task: ostatni wygrywa (overwrite)

### Worktree po `redo:`
- `removeWorktree()` + `createWorktree()` od `baseBranch`
- Istniejacy branch usuniety, nowy PR tworzony
- Stary PR na GitHubie zamykany jawnie: `gh pr close <branch> --delete-branch`

### Wiadomosci nie-feedbackowe
- Ignoruj wiadomosci od bota (`message.bot_id` matches own bot ID)
- Ignoruj message subtypes: `bot_message`, `message_changed`, `message_deleted`, `channel_join`, etc.
- Slack reactions (`reaction_added`) sa oddzielnym event type — nie triggeruja message handlera
- Wszystko inne = feedback

### Brak worktree
- Traktuj jak `redo:` — stworz nowy worktree
- Powiadom w watku: "Worktree nie istnieje, tworze nowy (tryb redo)."

### Tryb `--once`
- Slack bot NIE startuje w trybie `--once` — proces musi moc sie zakonczyc
- Webhook nadal dziala w `--once`

## Dependencies

Jedyna nowa dependency:

```json
{
  "dependencies": {
    "@slack/bolt": "^4.1.0"
  }
}
```

`dotenv` jest juz w `package.json`.

## Startup

```
main()
  +-- ensureRepoReady(), claude --version, gh auth (istniejace)
  +-- isOnce? (--once flag)
  |     +-- TAK -> pollCycle(), exit (bez Slack bota)
  |     +-- NIE -> kontynuuj
  +-- SLACK_BOT_TOKEN + SLACK_APP_TOKEN ustawione?
  |     +-- TAK -> startSlackBot()
  |     |         +-- inicjalizuje Bolt App w Socket Mode
  |     |         +-- rejestruje message handler
  |     |         +-- app.start()
  |     +-- NIE -> log "Slack feedback disabled", webhook jak dotychczas
  +-- notifyWorkerStart() (przez bot lub webhook)
  +-- pollCycle()
  +-- setInterval(pollCycle)
```

## Graceful shutdown

```ts
const shutdown = async () => {
  clearInterval(interval);
  // Kill any running Claude Code processes
  for (const [key, task] of Object.entries(loadState().processed)) {
    if (task.childProcessPid) {
      try { process.kill(-task.childProcessPid, 'SIGTERM'); } catch {}
    }
  }
  if (slackBot) await slackBot.stop();
  process.exit(0);
};
```
