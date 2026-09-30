---- MODULE Lock ----
\* Formal model of the cross-process target-store lock in src/lock.js, AFTER
\* the rename-publish fix (see LockHuskRace.tla for the pre-fix protocol that
\* TLC refutes).
\*
\* Acquisition now builds the lock in a PRIVATE staging directory and only then
\* publishes it with an atomic rename. The canonical `<store>.lock` path
\* therefore only ever appears with a complete owner record, so there is no
\* window in which a stalled creator can write its record into a successor's
\* directory. Recovery still runs under the `<store>.lock.recover` gate, and a
\* directory whose owner pid is alive is never recovered.
\*
\* Deliberate abstraction (see formal/README.md): gate acquisition is atomic
\* here. The gate is a recovery-only mutex; its husk window is the same class
\* of issue and is tracked separately.

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Procs

NoOne == "no-one"

States == {"start", "pre", "confirm", "hold",
           "release", "done", "judge", "wait", "recover", "inGate", "crashed"}

VARIABLES
  pc, alive,                                                \* per process
  lockPresent, lockHusk, lockOwner, lockAged,               \* <store>.lock
  gatePresent, gateHusk, gateOwner, gateAged                \* <store>.lock.recover

vars == <<pc, alive, lockPresent, lockHusk, lockOwner, lockAged,
          gatePresent, gateHusk, gateOwner, gateAged>>

GateLive ==
  IF ~gatePresent THEN FALSE
  ELSE IF ~gateHusk THEN alive[gateOwner]
  ELSE ~gateAged

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

\* --------------------------- acquisition ---------------------------------

Begin(p) ==
  /\ pc[p] = "start" /\ alive[p]
  /\ pc' = [pc EXCEPT ![p] = "pre"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* rename(staging, lockPath) with an absent target: atomic, exclusive,
\* owner record already present in the staging directory.
PublishAbsent(p) ==
  /\ pc[p] = "pre" /\ alive[p] /\ ~GateLive /\ ~lockPresent
  /\ lockPresent' = TRUE /\ lockHusk' = FALSE /\ lockOwner' = p /\ lockAged' = FALSE
  /\ pc' = [pc EXCEPT ![p] = "confirm"]
  /\ UNCHANGED <<alive, gatePresent, gateHusk, gateOwner, gateAged>>

\* An abandoned empty husk (only legacy artifacts have no owner record) is
\* replaced by the rename once it is past the grace period.
PublishStaleHusk(p) ==
  /\ pc[p] = "pre" /\ alive[p] /\ ~GateLive
  /\ lockPresent /\ lockHusk /\ lockAged
  /\ lockPresent' = TRUE /\ lockHusk' = FALSE /\ lockOwner' = p /\ lockAged' = FALSE
  /\ pc' = [pc EXCEPT ![p] = "confirm"]
  /\ UNCHANGED <<alive, gatePresent, gateHusk, gateOwner, gateAged>>

\* rename fails against a non-empty lock: go judge it.
ContendOwned(p) ==
  /\ pc[p] = "pre" /\ alive[p] /\ ~GateLive
  /\ lockPresent /\ ~lockHusk
  /\ pc' = [pc EXCEPT ![p] = "judge"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

\* A young ownerless husk is protected by the grace period: retry later.
SkipHeldHusk(p) ==
  /\ pc[p] = "pre" /\ alive[p] /\ ~GateLive
  /\ lockPresent /\ lockHusk /\ ~lockAged
  /\ UNCHANGED vars

\* Re-read the owner record: proceed only when our own token is on disk.
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

ConfirmWait(p) ==
  /\ pc[p] = "confirm" /\ alive[p] /\ GateLive
  /\ UNCHANGED vars

\* --------------------------- release --------------------------------------

ReleaseStart(p) ==
  /\ pc[p] = "hold" /\ alive[p]
  /\ pc' = [pc EXCEPT ![p] = "release"]
  /\ UNCHANGED <<alive, lockPresent, lockHusk, lockOwner, lockAged,
                 gatePresent, gateHusk, gateOwner, gateAged>>

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
       \/ Begin(p)
       \/ PublishAbsent(p) \/ PublishStaleHusk(p) \/ ContendOwned(p) \/ SkipHeldHusk(p)
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
  /\ (lockPresent /\ lockOwner # NoOne) => (lockHusk = FALSE)

\* SAFETY: at most one process is ever inside the critical section.
MutualExclusion == Cardinality(HeldProcs) <= 1

\* SAFETY: at most one process holds the recovery gate.
GateExclusion == Cardinality({p \in Procs : pc[p] = "inGate"}) <= 1

\* The fix's key structural property: the canonical lock path is never an
\* ownerless husk, because a lock is only published once its owner record is
\* already inside the staging directory.
NoHusk == ~(lockPresent /\ lockHusk)

=============================================================================
