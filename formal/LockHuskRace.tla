---- MODULE LockHuskRace ----
\* Formal model of the cross-process target-store lock in src/lock.js.
\*
\* Scope of the model:
\*   - the lock is a directory at `<store>.lock` holding an `owner` record;
\*   - recovery runs under the gate `<store>.lock.recover`;
\*   - a directory with a live owner pid is never recovered; a directory with
\*     no valid owner record is a "husk" and may be recovered once its mtime
\*     is older than the grace period (modelled by the `lockAged` flag);
\*   - acquisition writes the owner record after mkdir, then re-reads it and
\*     only proceeds when its own token is the one on disk.
\*
\* The environment may crash a process at any point (leaving its record), and
\* may age a husk at any time. TLC explores every interleaving of these
\* actions, so the invariants below are checked against all bounded
\* executions, not samples.
\*
\* Deliberate abstraction: gate acquisition is atomic here (mkdir + owner
\* write). The gate's own husk window is analogous but is not the focus of
\* this model; see formal/README.md.

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Procs

NoOne == "no-one"

States == {"start", "pre", "create", "writeOwner", "confirm", "hold",
           "release", "done", "judge", "wait", "recover", "inGate", "crashed"}

VARIABLES
  pc, alive,                                                \* per process
  lockPresent, lockHusk, lockOwner, lockAged,               \* <store>.lock
  gatePresent, gateHusk, gateOwner, gateAged                \* <store>.lock.recover

vars == <<pc, alive, lockPresent, lockHusk, lockOwner, lockAged,
          gatePresent, gateHusk, gateOwner, gateAged>>

\* A live gate blocks new lock creates and new recoveries.
GateLive ==
  IF ~gatePresent THEN FALSE
  ELSE IF ~gateHusk THEN alive[gateOwner]
  ELSE ~gateAged

\* judgeLock(): can this lock directory be recovered right now?
JudgeLock ==
  IF ~lockPresent THEN "gone"
  ELSE IF ~lockHusk THEN (IF alive[lockOwner] THEN "held" ELSE "stale")
  ELSE (IF lockAged THEN "stale" ELSE "held")

HeldProcs == {p \in Procs : pc[p] = "hold"}

Init ==
  /\ pc = [p \in Procs |-> "start"]
  /\ alive = [p \in Procs |-> TRUE]
  /\ lockPresent = FALSE /\ lockHusk = FALSE /\ lockOwner = NoOne /\ lockAged = FALSE
  /\ gatePresent = FALSE /\ gateHusk = FALSE /\ gateOwner = NoOne /\ gateAged = FALSE

\* ------------------------------ environment ------------------------------

Crash(p) ==
  /\ alive[p] /\ pc[p] \notin {"done", "crashed"}
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ pc' = [pc EXCEPT ![p] = "crashed"]
  /\ UNCHANGED <<lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* The mtime grace period passes for an ownerless lock husk.
AgeLock ==
  /\ lockPresent /\ lockHusk /\ ~lockAged
  /\ lockAged' = TRUE
  /\ UNCHANGED <<pc, alive, lockPresent, lockHusk, lockOwner,
                 gatePresent, gateHusk, gateOwner, gateAged>>

AgeGate ==
  /\ gatePresent /\ gateHusk /\ ~gateAged
  /\ gateAged' = TRUE
  /\ UNCHANGED <<pc, alive, lockPresent, lockHusk, lockOwner,
                 gatePresent, gateHusk, gateOwner>>

\* --------------------------- acquiring process ---------------------------

Begin(p) ==
  /\ pc[p] = "start" /\ alive[p]
  /\ pc' = [pc EXCEPT ![p] = "pre"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* Acquirers stay clear of a live recovery gate (they do not even create).
PreToCreate(p) ==
  /\ pc[p] = "pre" /\ alive[p] /\ ~GateLive
  /\ pc' = [pc EXCEPT ![p] = "create"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* mkdir succeeded: the directory now exists but has no owner record yet.
Create(p) ==
  /\ pc[p] = "create" /\ alive[p] /\ ~lockPresent
  /\ lockPresent' = TRUE /\ lockHusk' = TRUE /\ lockOwner' = NoOne /\ lockAged' = FALSE
  /\ pc' = [pc EXCEPT ![p] = "writeOwner"]
  /\ UNCHANGED <<alive, gatePresent, gateHusk, gateOwner, gateAged>>

\* mkdir failed (EEXIST): go judge the existing directory.
Contend(p) ==
  /\ pc[p] = "create" /\ alive[p] /\ lockPresent
  /\ pc' = [pc EXCEPT ![p] = "judge"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* writeOwnerRecord(): path-based, writes into whatever directory is at the
\* path now - including a successor created after this process's own mkdir.
WriteOwner(p) ==
  /\ pc[p] = "writeOwner" /\ alive[p] /\ lockPresent
  /\ lockOwner' = p /\ lockHusk' = FALSE
  /\ pc' = [pc EXCEPT ![p] = "confirm"]
  /\ UNCHANGED <<alive, lockPresent, lockAged, gatePresent, gateHusk, gateOwner, gateAged>>

\* The directory vanished before the owner write: retry.
WriteOwnerGone(p) ==
  /\ pc[p] = "writeOwner" /\ alive[p] /\ ~lockPresent
  /\ pc' = [pc EXCEPT ![p] = "pre"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* Re-read the owner record: proceed only when our own token is on disk and
\* no live recovery gate can still move it.
Confirm(p) ==
  /\ pc[p] = "confirm" /\ alive[p]
  /\ lockPresent /\ ~lockHusk /\ lockOwner = p /\ ~GateLive
  /\ pc' = [pc EXCEPT ![p] = "hold"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

ConfirmMismatch(p) ==
  /\ pc[p] = "confirm" /\ alive[p]
  /\ (~lockPresent \/ lockHusk \/ lockOwner # p)
  /\ pc' = [pc EXCEPT ![p] = "pre"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* Wait a live gate out, then re-read.
ConfirmWait(p) ==
  /\ pc[p] = "confirm" /\ alive[p] /\ GateLive
  /\ UNCHANGED vars

\* --------------------------- release --------------------------------------

ReleaseStart(p) ==
  /\ pc[p] = "hold" /\ alive[p]
  /\ pc' = [pc EXCEPT ![p] = "release"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* Token-checked release: only the recorded owner removes the lock.
Release(p) ==
  /\ pc[p] = "release" /\ alive[p]
  /\ lockPresent /\ ~lockHusk /\ lockOwner = p
  /\ lockPresent' = FALSE /\ lockHusk' = FALSE /\ lockOwner' = NoOne /\ lockAged' = FALSE
  /\ pc' = [pc EXCEPT ![p] = "done"]
  /\ UNCHANGED <<alive, gatePresent, gateHusk, gateOwner, gateAged>>

\* --------------------------- contention / recovery ------------------------

JudgeStep(p) ==
  /\ pc[p] = "judge" /\ alive[p]
  /\ pc' = [pc EXCEPT ![p] = CASE JudgeLock = "gone" -> "pre"
                                  [] JudgeLock = "held" -> "wait"
                                  [] OTHER -> "recover"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

WaitStep(p) ==
  /\ pc[p] = "wait" /\ alive[p]
  /\ pc' = [pc EXCEPT ![p] = "pre"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

RecoverCreate(p) ==
  /\ pc[p] = "recover" /\ alive[p] /\ ~gatePresent
  /\ gatePresent' = TRUE /\ gateHusk' = FALSE /\ gateOwner' = p /\ gateAged' = FALSE
  /\ pc' = [pc EXCEPT ![p] = "inGate"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged>>

RecoverTake(p) ==
  /\ pc[p] = "recover" /\ alive[p] /\ gatePresent /\ ~GateLive
  /\ gateHusk' = FALSE /\ gateOwner' = p /\ gateAged' = FALSE
  /\ pc' = [pc EXCEPT ![p] = "inGate"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged, gatePresent>>

RecoverWait(p) ==
  /\ pc[p] = "recover" /\ alive[p] /\ GateLive
  /\ pc' = [pc EXCEPT ![p] = "wait"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* Under the gate: RE-inspect the lock and only then move it aside.
InGate(p) ==
  /\ pc[p] = "inGate" /\ alive[p] /\ gateOwner = p
  /\ IF JudgeLock = "stale"
       THEN lockPresent' = FALSE /\ lockHusk' = FALSE /\ lockOwner' = NoOne /\ lockAged' = FALSE
       ELSE UNCHANGED <<lockPresent, lockHusk, lockOwner, lockAged>>
  /\ gatePresent' = FALSE /\ gateHusk' = FALSE /\ gateOwner' = NoOne /\ gateAged' = FALSE
  /\ pc' = [pc EXCEPT ![p] = "pre"]
  /\ UNCHANGED <<alive>>

Next ==
  \/ \E p \in Procs: Crash(p)
  \/ AgeLock
  \/ AgeGate
  \/ \E p \in Procs:
       \/ Begin(p) \/ PreToCreate(p) \/ Create(p) \/ Contend(p)
       \/ WriteOwner(p) \/ WriteOwnerGone(p)
       \/ Confirm(p) \/ ConfirmMismatch(p) \/ ConfirmWait(p)
       \/ ReleaseStart(p) \/ Release(p)
       \/ JudgeStep(p) \/ WaitStep(p)
       \/ RecoverCreate(p) \/ RecoverTake(p) \/ RecoverWait(p) \/ InGate(p)

Spec == Init /\ [][Next]_vars

\* --------------------------- properties -----------------------------------

TypeOK ==
  /\ pc \in [Procs -> States]
  /\ alive \in [Procs -> BOOLEAN]
  /\ lockPresent \in BOOLEAN
  /\ lockHusk \in BOOLEAN
  /\ lockOwner \in Procs \cup {NoOne}
  /\ lockAged \in BOOLEAN
  /\ gatePresent \in BOOLEAN
  /\ gateHusk \in BOOLEAN
  /\ gateOwner \in Procs \cup {NoOne}
  /\ gateAged \in BOOLEAN
  /\ (lockHusk = FALSE) => (lockOwner # NoOne \/ ~lockPresent)
  \* a husk never carries an owner, and an owned lock is never a husk
  /\ (lockPresent /\ lockOwner # NoOne) => (lockHusk = FALSE)

\* SAFETY: at most one process is ever inside the critical section.
MutualExclusion == Cardinality(HeldProcs) <= 1

\* SAFETY: at most one process holds the recovery gate.
GateExclusion == Cardinality({p \in Procs : pc[p] = "inGate"}) <= 1

=============================================================================
