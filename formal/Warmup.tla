---- MODULE Warmup ----
\* Formal model of the ControlMaster warm-up coordination in src/ssh.js.
\*
\* Scope: the in-process contract that
\*   - callers share ONE in-flight warm-up per ssh destination;
\*   - a terminal (interactive authentication) is only ever opened for an
\*     interactive warm-up, never for a headless probe, and never while a
\*     recent terminal failure is being replayed (the anti-terminal-spam rule);
\*   - a caller's cancellation detaches that caller only and never alters the
\*     shared warm-up.
\*
\* The cross-process socket lock that serialises warm-ups across MCP processes
\* is verified separately (Lock.tla). The 30s failure-cache timer is modelled
\* by the nondeterministic CacheExpire action.
\*
\* `Dedup = FALSE` models a hypothetical implementation that lets each caller
\* start its own warm-up; TLC then refutes NoConcurrentTerminals, which is how
\* the model demonstrates it is sensitive to the dedup it is supposed to check.

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Callers, TerminalCallers, Dedup

VARIABLES
  st,          \* Callers -> {"idle", "wait", "done", "abort"}
  headless,    \* number of in-flight headless warm-ups
  terminal,    \* number of in-flight interactive warm-ups
  master,      \* ControlMaster established
  cached,      \* recent terminal failure being replayed
  open         \* authentication terminals currently open

vars == <<st, headless, terminal, master, cached, open>>

Init ==
  /\ st = [c \in Callers |-> "idle"]
  /\ headless = 0 /\ terminal = 0
  /\ master = FALSE /\ cached = FALSE /\ open = 0

\* Start a headless warm-up (subsea probe, may open a terminal if it hits an
\* authentication failure and the caller allows interactivity).
StartHeadless(c) ==
  /\ st[c] = "idle" /\ ~master /\ ~cached
  /\ (Dedup = TRUE => headless + terminal = 0)
  /\ headless' = headless + 1
  /\ st' = [st EXCEPT ![c] = "wait"]
  /\ UNCHANGED <<terminal, master, cached, open>>

StartInteractive(c) ==
  /\ st[c] = "idle" /\ c \in TerminalCallers /\ ~master /\ ~cached
  /\ (Dedup = TRUE => headless + terminal = 0)
  /\ terminal' = terminal + 1
  /\ st' = [st EXCEPT ![c] = "wait"]
  /\ UNCHANGED <<headless, master, cached, open>>

\* A caller that arrives while a warm-up is in flight shares it.
Join(c) ==
  /\ st[c] = "idle" /\ headless + terminal > 0
  /\ st' = [st EXCEPT ![c] = "wait"]
  /\ UNCHANGED <<headless, terminal, master, cached, open>>

ProbeOk ==
  /\ headless > 0
  /\ master' = TRUE /\ headless' = 0
  /\ st' = [c \in Callers |-> IF st[c] = "wait" THEN "done" ELSE st[c]]
  /\ UNCHANGED <<terminal, cached, open>>

\* A headless probe failed. Interactive waiters retry interactively; others
\* receive the failure.
ProbeFail ==
  /\ headless > 0
  /\ headless' = 0
  /\ st' = [c \in Callers |->
             IF st[c] = "wait" /\ c \in TerminalCallers THEN "idle"
             ELSE IF st[c] = "wait" THEN "done"
             ELSE st[c]]
  /\ UNCHANGED <<terminal, master, cached, open>>

\* Only an interactive warm-up opens a window, and at most one per warm-up.
OpenTerminal ==
  /\ terminal > open /\ terminal > 0
  /\ open' = open + 1
  /\ UNCHANGED <<st, headless, terminal, master, cached>>

TerminalOk ==
  /\ open > 0
  /\ master' = TRUE /\ open' = 0 /\ terminal' = 0 /\ cached' = FALSE
  /\ st' = [c \in Callers |-> IF st[c] = "wait" THEN "done" ELSE st[c]]
  /\ UNCHANGED <<headless>>

TerminalFail ==
  /\ open > 0
  /\ open' = 0 /\ terminal' = 0 /\ cached' = TRUE
  /\ st' = [c \in Callers |-> IF st[c] = "wait" THEN "done" ELSE st[c]]
  /\ UNCHANGED <<headless, master>>

CacheExpire ==
  /\ cached
  /\ cached' = FALSE
  /\ UNCHANGED <<st, headless, terminal, master, open>>

Reuse(c) ==
  /\ master /\ st[c] = "idle"
  /\ st' = [st EXCEPT ![c] = "done"]
  /\ UNCHANGED <<headless, terminal, master, cached, open>>

\* Cancellation: detaches this caller only. The shared warm-up is untouched.
Abort(c) ==
  /\ st[c] = "wait"
  /\ st' = [st EXCEPT ![c] = "abort"]
  /\ UNCHANGED <<headless, terminal, master, cached, open>>

Next ==
  \/ \E c \in Callers: StartHeadless(c) \/ StartInteractive(c) \/ Join(c) \/ Reuse(c) \/ Abort(c)
  \/ ProbeOk \/ ProbeFail \/ OpenTerminal \/ TerminalOk \/ TerminalFail \/ CacheExpire

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ st \in [Callers -> {"idle", "wait", "done", "abort"}]
  /\ headless \in 0..Cardinality(Callers)
  /\ terminal \in 0..Cardinality(Callers)
  /\ open \in 0..Cardinality(Callers)
  /\ master \in BOOLEAN
  /\ cached \in BOOLEAN

\* SAFETY: at most one authentication terminal is open at any time.
NoConcurrentTerminals == open <= 1

\* SAFETY: a terminal only ever serves an interactive warm-up.
TerminalNeedsInteractive == open > 0 => terminal > 0

\* SAFETY: a cached terminal failure suppresses further terminal attempts.
NoTerminalWhileCached == cached => open = 0

\* SAFETY: with dedup, at most one warm-up is in flight per destination.
SingleWarmup == Dedup = TRUE => headless + terminal <= 1

\* Cancellation isolation is structural: Abort(c) has no shared-variable
\* writes, so a caller's cancellation cannot cancel the shared warm-up. It is
\* also covered by test/ssh-warmup.test.mjs; TLC cannot check this general
\* action-form temporal property (only <>[] / []<> are supported), so it is
\* not listed in Warmup.cfg.
AbortIsolated ==
  \A c \in Callers:
    [][ (st[c] # "abort" /\ st'[c] = "abort")
        => (headless' = headless /\ terminal' = terminal /\ master' = master
            /\ cached' = cached /\ open' = open) ]_vars

====
